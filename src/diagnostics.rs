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

/// A problem the compiler reported in a file other than the one asked about.
#[derive(Debug, PartialEq)]
pub struct ProblemElsewhere {
    pub path: String,
    /// 1-indexed, as the compiler prints it
    pub line: u32,
    pub title: String,
}

/// What a build said about one file.
#[derive(Debug, Default)]
pub struct CompileReport {
    /// Problems in the file itself
    pub diagnostics: Vec<Diagnostic>,
    /// Problems in other files. They keep the project from compiling just the same.
    pub elsewhere: Vec<ProblemElsewhere>,
}

/// Whether two paths name the same file. The compiler reports resolved paths,
/// so a path that goes through a link, as everything under /tmp does on
/// macOS, has to be resolved as well before the two are compared.
fn same_file(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
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

    /// Run elm/lamdera make on a file and report what the compiler said.
    ///
    /// An `Err` means there is no verdict: no compiler could be started, or
    /// its report could not be read. That must never look like a clean build.
    pub fn get_diagnostics(&self, file_uri: &Url) -> Result<CompileReport, String> {
        let file_path = file_uri
            .to_file_path()
            .map_err(|_| format!("{} is not a file", file_uri))?
            .to_string_lossy()
            .to_string();

        let workspace_root = self
            .workspace_root
            .clone()
            .or_else(|| Self::find_workspace_root(&file_path))
            .ok_or_else(|| format!("No elm.json found for {}", file_path))?;

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

        let output = output.ok_or_else(|| {
            "Could not run the Elm compiler: neither elm nor lamdera could be started. Is one of them on PATH?"
                .to_string()
        })?;

        // If successful, no errors
        if output.status.success() {
            return Ok(CompileReport::default());
        }

        // elm make outputs JSON to stderr
        let stderr = String::from_utf8_lossy(&output.stderr);
        self.parse_elm_output(&stderr, &file_path, &workspace_root)
    }

    /// `root` is the directory the compiler ran in. Its relative paths start there.
    fn parse_elm_output(
        &self,
        output: &str,
        file_path: &str,
        root: &str,
    ) -> Result<CompileReport, String> {
        let parsed: Result<ElmMakeOutput, _> = serde_json::from_str(output);

        match parsed {
            Ok(ElmMakeOutput::CompileErrors { errors }) => {
                let mut report = CompileReport::default();

                for error in errors {
                    let in_this_file =
                        same_file(&Path::new(root).join(&error.path), Path::new(file_path));
                    for problem in &error.problems {
                        if in_this_file {
                            report.diagnostics.push(self.problem_to_diagnostic(problem));
                        } else {
                            report.elsewhere.push(ProblemElsewhere {
                                path: error.path.clone(),
                                line: problem.region.start.line,
                                title: problem.title.clone(),
                            });
                        }
                    }
                }

                Ok(report)
            }
            Ok(ElmMakeOutput::GeneralError { title, message, .. }) => {
                // General error (e.g., elm.json issues)
                let msg = message.iter().map(|p| p.to_string()).collect::<String>();
                Ok(CompileReport {
                    diagnostics: vec![Diagnostic {
                        range: Range::new(Position::new(0, 0), Position::new(0, 0)),
                        severity: Some(DiagnosticSeverity::ERROR),
                        source: Some("elm".to_string()),
                        message: format!("{}: {}", title, msg),
                        ..Default::default()
                    }],
                    elsewhere: vec![],
                })
            }
            Err(e) => {
                tracing::debug!("Failed to parse elm make output ({}): {}", e, output);
                let first_line = output
                    .lines()
                    .find(|line| !line.trim().is_empty())
                    .unwrap_or("it printed nothing");
                Err(format!(
                    "The compiler failed, and its report could not be read: {}",
                    first_line.chars().take(200).collect::<String>()
                ))
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
        let report = provider
            .parse_elm_output(json, "/test/Bad.elm", "/test")
            .unwrap();
        let diagnostics = report.diagnostics;

        assert!(report.elsewhere.is_empty());
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].message.contains("NAMING ERROR"));
        assert_eq!(diagnostics[0].range.start.line, 2); // 0-indexed
        assert_eq!(diagnostics[0].range.start.character, 6); // 0-indexed
    }

    #[test]
    fn test_errors_in_other_files_are_reported_apart() {
        let json = r#"{"type":"compile-errors","errors":[{"path":"src/Other.elm","name":"Other","problems":[{"title":"TYPE MISMATCH","region":{"start":{"line":12,"column":5},"end":{"line":12,"column":9}},"message":["no"]}]}]}"#;

        let report = DiagnosticsProvider::new()
            .parse_elm_output(json, "/test/Main.elm", "/test")
            .unwrap();

        assert!(report.diagnostics.is_empty());
        assert_eq!(
            report.elsewhere,
            vec![ProblemElsewhere {
                path: "src/Other.elm".to_string(),
                line: 12,
                title: "TYPE MISMATCH".to_string()
            }]
        );
    }

    #[test]
    fn test_unreadable_compiler_output_is_an_error() {
        let provider = DiagnosticsProvider::new();

        let error = provider
            .parse_elm_output("\nelm: internal error\nmore", "/test/Main.elm", "/test")
            .unwrap_err();
        assert_eq!(
            error,
            "The compiler failed, and its report could not be read: elm: internal error"
        );

        let silent = provider
            .parse_elm_output("", "/test/Main.elm", "/test")
            .unwrap_err();
        assert_eq!(
            silent,
            "The compiler failed, and its report could not be read: it printed nothing"
        );
    }

    #[test]
    #[cfg(unix)]
    fn test_an_error_under_the_resolved_path_belongs_to_the_file_asked_about() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("Main.elm"), "module Main exposing (..)\n").unwrap();
        // The project is reached through a link, and the compiler reports where the link leads
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let reported = real.join("Main.elm").canonicalize().unwrap();
        let asked = link.join("Main.elm");
        let problem = r#"[{"title":"NAMING ERROR","region":{"start":{"line":3,"column":7},"end":{"line":3,"column":10}},"message":["no"]}]"#;
        let provider = DiagnosticsProvider::new();

        for path in [reported.to_str().unwrap(), "Main.elm"] {
            let json = format!(
                r#"{{"type":"compile-errors","errors":[{{"path":{:?},"name":"Main","problems":{}}}]}}"#,
                path, problem
            );
            let report = provider
                .parse_elm_output(&json, asked.to_str().unwrap(), link.to_str().unwrap())
                .unwrap();
            assert_eq!(report.diagnostics.len(), 1, "path {}", path);
            assert!(report.elsewhere.is_empty());
        }
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
