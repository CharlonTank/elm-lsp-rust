use serde::Deserialize;
use std::path::Path;
use std::process::Command;
use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, Position, Range, Url};

use crate::workspace::depends_on_lamdera;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ElmMakeOutput {
    #[serde(rename = "compile-errors")]
    CompileErrors { errors: Vec<ElmError> },
    #[serde(rename = "error")]
    GeneralError {
        path: Option<String>,
        title: String,
        message: Vec<MessagePart>,
    },
}

#[derive(Debug, Deserialize)]
pub struct ElmError {
    pub path: String,
    pub name: String,
    pub problems: Vec<ElmProblem>,
}

#[derive(Debug, Deserialize)]
pub struct ElmProblem {
    pub title: String,
    pub region: ElmRegion,
    pub message: Vec<MessagePart>,
}

#[derive(Debug, Deserialize)]
pub struct ElmRegion {
    pub start: ElmPosition,
    pub end: ElmPosition,
}

#[derive(Debug, Deserialize)]
pub struct ElmPosition {
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum MessagePart {
    Text(String),
    Styled(StyledText),
}

#[derive(Debug, Deserialize)]
pub struct StyledText {
    pub string: String,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub underline: bool,
    pub color: Option<String>,
}

impl std::fmt::Display for MessagePart {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MessagePart::Text(s) => write!(f, "{}", s),
            MessagePart::Styled(styled) => write!(f, "{}", styled.string),
        }
    }
}

pub struct DiagnosticsProvider {
    workspace_root: Option<String>,
}

impl DiagnosticsProvider {
    pub fn new() -> Self {
        Self {
            workspace_root: None,
        }
    }

    pub fn set_workspace_root(&mut self, root: &str) {
        self.workspace_root = Some(root.to_string());
    }

    /// Find elm.json in parent directories
    fn find_workspace_root(file_path: &str) -> Option<String> {
        let mut path = Path::new(file_path).parent()?;

        loop {
            let elm_json = path.join("elm.json");
            if elm_json.exists() {
                return Some(path.to_string_lossy().to_string());
            }

            path = path.parent()?;
        }
    }

    /// The compilers to try for a project, in order. A Lamdera project needs
    /// `lamdera`. Every other project is built with `elm`, the compiler its
    /// elm.json names and its node_modules may pin. The other one is a
    /// stand-in for a machine that has only one of them installed.
    fn compilers_for(workspace_root: &str) -> [&'static str; 2] {
        let is_lamdera = std::fs::read_to_string(Path::new(workspace_root).join("elm.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .is_some_and(|elm_json| depends_on_lamdera(&elm_json));

        if is_lamdera {
            ["lamdera", "elm"]
        } else {
            ["elm", "lamdera"]
        }
    }

    /// Run elm/lamdera make and get diagnostics
    pub fn get_diagnostics(&self, file_uri: &Url) -> Vec<Diagnostic> {
        let file_path = match file_uri.to_file_path() {
            Ok(p) => p.to_string_lossy().to_string(),
            Err(_) => return vec![],
        };

        let workspace_root = self
            .workspace_root
            .clone()
            .or_else(|| Self::find_workspace_root(&file_path));

        let workspace_root = match workspace_root {
            Some(root) => root,
            None => return vec![],
        };

        // The first compiler that can be started does the build
        let output = Self::compilers_for(&workspace_root)
            .into_iter()
            .find_map(|compiler| {
                Command::new(compiler)
                    .args(["make", &file_path, "--report=json", "--output=/dev/null"])
                    .current_dir(&workspace_root)
                    .output()
                    .ok()
            });

        let output = match output {
            Some(o) => o,
            None => {
                tracing::error!("Failed to run elm/lamdera make: neither could be started");
                return vec![];
            }
        };

        // elm make outputs JSON to stderr
        let stderr = String::from_utf8_lossy(&output.stderr);

        // If successful, no errors
        if output.status.success() {
            return vec![];
        }

        self.parse_elm_output(&stderr, &file_path)
    }

    fn parse_elm_output(&self, output: &str, file_path: &str) -> Vec<Diagnostic> {
        let parsed: Result<ElmMakeOutput, _> = serde_json::from_str(output);

        match parsed {
            Ok(ElmMakeOutput::CompileErrors { errors }) => {
                let mut diagnostics = vec![];

                for error in errors {
                    // Only include diagnostics for the requested file
                    if error.path != file_path {
                        continue;
                    }

                    for problem in error.problems {
                        diagnostics.push(self.problem_to_diagnostic(&problem));
                    }
                }

                diagnostics
            }
            Ok(ElmMakeOutput::GeneralError { title, message, .. }) => {
                // General error (e.g., elm.json issues)
                let msg = message.iter().map(|p| p.to_string()).collect::<String>();
                vec![Diagnostic {
                    range: Range::new(Position::new(0, 0), Position::new(0, 0)),
                    severity: Some(DiagnosticSeverity::ERROR),
                    source: Some("elm".to_string()),
                    message: format!("{}: {}", title, msg),
                    ..Default::default()
                }]
            }
            Err(e) => {
                tracing::error!("Failed to parse elm make output: {}", e);
                tracing::debug!("Output was: {}", output);
                vec![]
            }
        }
    }

    fn problem_to_diagnostic(&self, problem: &ElmProblem) -> Diagnostic {
        // Convert elm positions (1-indexed) to LSP positions (0-indexed)
        let start = Position::new(
            problem.region.start.line.saturating_sub(1),
            problem.region.start.column.saturating_sub(1),
        );
        let end = Position::new(
            problem.region.end.line.saturating_sub(1),
            problem.region.end.column.saturating_sub(1),
        );

        // Build message from parts
        let message_text: String = problem
            .message
            .iter()
            .map(|part| part.to_string())
            .collect();

        Diagnostic {
            range: Range::new(start, end),
            severity: Some(DiagnosticSeverity::ERROR),
            source: Some("elm".to_string()),
            code: None,
            code_description: None,
            message: format!("{}\n\n{}", problem.title, message_text.trim()),
            related_information: None,
            tags: None,
            data: None,
        }
    }
}

impl Default for DiagnosticsProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_compile_error() {
        let json = r#"{"type":"compile-errors","errors":[{"path":"/test/Bad.elm","name":"Bad","problems":[{"title":"NAMING ERROR","region":{"start":{"line":3,"column":7},"end":{"line":3,"column":10}},"message":["I cannot find a `bar` variable"]}]}]}"#;

        let provider = DiagnosticsProvider::new();
        let diagnostics = provider.parse_elm_output(json, "/test/Bad.elm");

        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].message.contains("NAMING ERROR"));
        assert_eq!(diagnostics[0].range.start.line, 2); // 0-indexed
        assert_eq!(diagnostics[0].range.start.character, 6); // 0-indexed
    }

    fn project_with(elm_json: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("elm.json"), elm_json).unwrap();
        dir
    }

    #[test]
    fn test_plain_elm_project_is_built_with_elm_first() {
        let dir = project_with(
            r#"{"dependencies":{"direct":{"elm/core":"1.0.5"},"indirect":{"elm/json":"1.1.3"}}}"#,
        );
        let root = dir.path().to_str().unwrap();

        assert_eq!(DiagnosticsProvider::compilers_for(root), ["elm", "lamdera"]);
    }

    #[test]
    fn test_lamdera_project_is_built_with_lamdera_first() {
        let direct =
            project_with(r#"{"dependencies":{"direct":{"lamdera/core":"1.0.0"},"indirect":{}}}"#);
        let indirect =
            project_with(r#"{"dependencies":{"direct":{},"indirect":{"lamdera/codecs":"1.0.0"}}}"#);

        for dir in [&direct, &indirect] {
            let root = dir.path().to_str().unwrap();
            assert_eq!(DiagnosticsProvider::compilers_for(root), ["lamdera", "elm"]);
        }
    }

    #[test]
    fn test_unreadable_elm_json_falls_back_to_elm_first() {
        let missing = tempfile::tempdir().unwrap();
        let broken = project_with("not json");

        for dir in [&missing, &broken] {
            let root = dir.path().to_str().unwrap();
            assert_eq!(DiagnosticsProvider::compilers_for(root), ["elm", "lamdera"]);
        }
    }
}
