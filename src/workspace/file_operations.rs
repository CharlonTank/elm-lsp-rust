//! File operations for the Elm workspace.
//!
//! Contains functions for renaming and moving Elm files, updating module
//! declarations and imports across the workspace.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tower_lsp::lsp_types::*;

use super::{
    composed, is_module_segment, is_same_file, normalized, FileOperationResult, Workspace,
    LAMDERA_PROTECTED_FILES,
};
use crate::parser::ElmParser;

/// Check if a file is a protected Lamdera file (must be at root of src/)
fn is_lamdera_protected_file(path: &Path) -> bool {
    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
        if LAMDERA_PROTECTED_FILES.contains(&file_name) {
            // Check if parent directory is "src" (the file is at root of src/)
            if let Some(parent) = path.parent() {
                if let Some(parent_name) = parent.file_name().and_then(|n| n.to_str()) {
                    return parent_name == "src";
                }
            }
        }
    }
    false
}

/// `path` with each part that the disk does not hold yet in the form a
/// module's name has, every accent written as one letter. A file system that
/// tells the two forms of an accent apart keeps a name as it is given, and
/// the compiler looks for a module under the one form. A part that is there
/// already stays as the caller spells it.
fn with_new_names_composed(path: &Path) -> PathBuf {
    let mut made = PathBuf::new();
    for part in path.components() {
        let given = made.join(part);
        made = if given.symlink_metadata().is_ok() {
            given
        } else {
            made.join(composed(&part.as_os_str().to_string_lossy()))
        };
    }
    made
}

impl Workspace {
    /// Rename a file and update its module declaration + all imports
    pub fn rename_file(&self, uri: &Url, new_name: &str) -> anyhow::Result<FileOperationResult> {
        let old_path = uri
            .to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid file URI"))?;

        // Block renaming protected Lamdera files (only at root of src/)
        if self.is_lamdera_project && is_lamdera_protected_file(&old_path) {
            if let Some(file_name) = old_path.file_name().and_then(|n| n.to_str()) {
                return Err(anyhow::anyhow!(
                    "Cannot rename {} in a Lamdera project - this file is required by Lamdera",
                    file_name
                ));
            }
        }

        // Validate new name
        if !new_name.ends_with(".elm") {
            return Err(anyhow::anyhow!("New name must end with .elm"));
        }

        // Get old module name from file content
        let content = std::fs::read_to_string(&old_path)?;
        let old_module_name = extract_module_name_from_content(&content)
            .ok_or_else(|| anyhow::anyhow!("Could not extract module name from file"))?;

        // Compute new module name (just the filename without .elm)
        // Only the one ending: "Text.elm.elm" is no name of a module
        let new_module_base = composed(new_name.strip_suffix(".elm").unwrap_or(new_name));
        if !is_module_segment(&new_module_base) {
            return Err(anyhow::anyhow!(
                "\"{}\" is no module name. It has to start with an upper-case letter and hold only letters, digits and underscores",
                new_module_base
            ));
        }

        // Compute new path
        let new_path = with_new_names_composed(
            &old_path
                .parent()
                .ok_or_else(|| anyhow::anyhow!("Invalid file path"))?
                .join(new_name),
        );

        // The compiler finds a module by its path below a source directory, so that
        // path is the module's name, whatever the file declared so far: a copy in
        // src/Backup that still says "module Utils" becomes Backup.Helpers. A file
        // that lies where its name says stays in its directory and keeps the first
        // parts of the name. With "src" and "src/Sub" in elm.json, Sub.Utils in
        // src/Sub becomes Sub.Helpers, where the inner directory alone would call
        // it Helpers. A file in no source directory keeps the first parts of the
        // name it declares too.
        let keeps_its_place =
            self.is_at_home(&old_path, &old_module_name) || !self.is_in_source_directory(&new_path);
        let new_module_name = if keeps_its_place {
            match old_module_name.rsplit_once('.') {
                Some((prefix, _)) => format!("{}.{}", prefix, new_module_base),
                None => new_module_base.to_string(),
            }
        } else {
            self.module_name_at(&new_path)?
        };

        // Collect all edits
        let mut changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();

        // 1. Update module declaration in the file itself
        if let Some(name_range) = find_module_name_range(&content) {
            changes.entry(uri.clone()).or_default().push(TextEdit {
                range: name_range,
                new_text: new_module_name.clone(),
            });
        }

        // 2. Update all imports across the workspace
        let files_updated = self.update_imports_of_file(
            &old_path,
            &old_module_name,
            &new_module_name,
            uri,
            &mut changes,
        )?;

        Ok(FileOperationResult {
            old_module_name,
            new_module_name,
            old_path: old_path.to_string_lossy().to_string(),
            new_path: new_path.to_string_lossy().to_string(),
            files_updated,
            changes,
        })
    }

    /// Move a file to a new location and update its module declaration + all imports
    pub fn move_file(&self, uri: &Url, target_path: &str) -> anyhow::Result<FileOperationResult> {
        let old_path = uri
            .to_file_path()
            .map_err(|_| anyhow::anyhow!("Invalid file URI"))?;

        // Block moving protected Lamdera files (only at root of src/)
        if self.is_lamdera_project && is_lamdera_protected_file(&old_path) {
            if let Some(file_name) = old_path.file_name().and_then(|n| n.to_str()) {
                return Err(anyhow::anyhow!(
                    "Cannot move {} in a Lamdera project - this file is required by Lamdera",
                    file_name
                ));
            }
        }

        // Validate target path
        if !target_path.ends_with(".elm") {
            return Err(anyhow::anyhow!("Target path must end with .elm"));
        }

        // Get old module name from file content
        let content = std::fs::read_to_string(&old_path)?;
        let old_module_name = extract_module_name_from_content(&content)
            .ok_or_else(|| anyhow::anyhow!("Could not extract module name from file"))?;

        // The full new path. A relative target starts at the workspace root.
        let new_path =
            with_new_names_composed(&normalized(&if Path::new(target_path).is_absolute() {
                PathBuf::from(target_path)
            } else {
                self.root_path.join(target_path)
            }));

        // The compiler finds a module by its path below a source directory,
        // so that path is the module's name
        let new_module_name = self.module_name_at(&new_path)?;

        // Collect all edits
        let mut changes: HashMap<Url, Vec<TextEdit>> = HashMap::new();

        // 1. Update module declaration in the file itself
        if let Some(name_range) = find_module_name_range(&content) {
            changes.entry(uri.clone()).or_default().push(TextEdit {
                range: name_range,
                new_text: new_module_name.clone(),
            });
        }

        // 2. Update all imports across the workspace
        let files_updated = self.update_imports_of_file(
            &old_path,
            &old_module_name,
            &new_module_name,
            uri,
            &mut changes,
        )?;

        Ok(FileOperationResult {
            old_module_name,
            new_module_name,
            old_path: old_path.to_string_lossy().to_string(),
            new_path: new_path.to_string_lossy().to_string(),
            files_updated,
            changes,
        })
    }

    /// Update the imports of the module in the file at `path`, when that file
    /// is the one the module's importers mean. A copy that still declares the
    /// module of the file it was made from waits for that name, and nothing
    /// imports it: the importers of the name are the other file's.
    fn update_imports_of_file(
        &self,
        path: &Path,
        old_module: &str,
        new_module: &str,
        skip_uri: &Url,
        changes: &mut HashMap<Url, Vec<TextEdit>>,
    ) -> anyhow::Result<usize> {
        let holds_the_name = self
            .modules
            .get(old_module)
            .is_some_and(|module| is_same_file(&module.path, path));
        if !holds_the_name {
            return Ok(0);
        }
        self.update_imports_for_rename(old_module, new_module, skip_uri, changes)
    }

    /// Update all imports of old_module to new_module across the workspace
    fn update_imports_for_rename(
        &self,
        old_module: &str,
        new_module: &str,
        skip_uri: &Url,
        changes: &mut HashMap<Url, Vec<TextEdit>>,
    ) -> anyhow::Result<usize> {
        let qualified_pattern = format!("{}.", old_module);
        let mut files_updated = 0;

        for module in self.modules.values() {
            let file_uri =
                Url::from_file_path(&module.path).map_err(|_| anyhow::anyhow!("Invalid path"))?;

            // Skip Evergreen files
            if module.path.to_string_lossy().contains("/Evergreen/") {
                continue;
            }

            // Skip the file being renamed/moved (already handled)
            if &file_uri == skip_uri {
                continue;
            }

            let content = std::fs::read_to_string(&module.path)?;
            // A file that never writes the name neither imports the module nor uses it
            if !content.contains(old_module) {
                continue;
            }
            let Some(tree) = self.parser.parse(&content) else {
                continue;
            };
            let header = header_clauses(&tree);

            // Find all import statements for the old module
            let imports: Vec<(tree_sitter::Node, tree_sitter::Node)> = header
                .iter()
                .filter_map(|(clause, name)| Some((*clause, (*name)?)))
                .filter(|(clause, name)| {
                    clause.kind() == "import_clause" && &content[name.byte_range()] == old_module
                })
                .collect();
            for (_, name) in &imports {
                changes.entry(file_uri.clone()).or_default().push(TextEdit {
                    range: self.parser.node_to_range(*name),
                    new_text: new_module.to_string(),
                });
                files_updated += 1;
            }

            // "Utils.greet" means the renamed module only in a file that imports it
            // under its own name. With "import Utils as U" the file says "U.greet",
            // and in a file without the import "Utils" is the alias of another module.
            let imports_it_by_name = imports
                .iter()
                .any(|(clause, _)| clause.child_by_field_name("asClause").is_none());
            if !imports_it_by_name {
                continue;
            }

            // Also check for qualified references like "OldModule.function"
            // This handles cases where the module is used with qualification
            for (line_num, line) in content.lines().enumerate() {
                // The lines of the module declaration and of the imports hold
                // the names of modules and no use of one
                let in_the_header = || {
                    header.iter().any(|(clause, _)| {
                        (clause.start_position().row..=clause.end_position().row)
                            .contains(&line_num)
                    })
                };
                if !line.contains(&qualified_pattern) || in_the_header() {
                    continue;
                }

                // Find all occurrences in the line
                let mut search_start = 0;
                while let Some(pos) = line[search_start..].find(&qualified_pattern) {
                    let actual_pos = search_start + pos;

                    // Make sure it's not part of a larger identifier
                    let before_ok = !line[..actual_pos]
                        .chars()
                        .next_back()
                        .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '.');

                    // "Utils.Extra.pad" names the module Utils.Extra, which lies below
                    // the renamed one and keeps its name: an upper-case word with a
                    // dot behind it is one more part of a module's name
                    let after = &line[actual_pos + qualified_pattern.len()..];
                    let word_end = after
                        .find(|c: char| !(c.is_alphanumeric() || c == '_'))
                        .unwrap_or(after.len());
                    let names_a_module_below =
                        after.starts_with(char::is_uppercase) && after[word_end..].starts_with('.');

                    if before_ok && !names_a_module_below {
                        changes.entry(file_uri.clone()).or_default().push(TextEdit {
                            range: Range {
                                start: Position {
                                    line: line_num as u32,
                                    character: actual_pos as u32,
                                },
                                end: Position {
                                    line: line_num as u32,
                                    character: (actual_pos + old_module.len()) as u32,
                                },
                            },
                            new_text: new_module.to_string(),
                        });
                    }

                    search_start = actual_pos + qualified_pattern.len();
                }
            }
        }

        Ok(files_updated)
    }
}

/// The module declaration and the imports at the top of a file, each with
/// the name of the module in it. They come from the parse tree, so a clause
/// counts however it is laid out: with any number of spaces, with "exposing"
/// on a line of its own. A line in a comment or in a string that reads like
/// one does not count. Where the parser could not read a clause to its end
/// the name is left out, because what it took for the name can be a part of
/// it.
fn header_clauses(
    tree: &tree_sitter::Tree,
) -> Vec<(tree_sitter::Node<'_>, Option<tree_sitter::Node<'_>>)> {
    let root = tree.root_node();
    let mut cursor = root.walk();
    root.children(&mut cursor)
        .filter(|clause| matches!(clause.kind(), "module_declaration" | "import_clause"))
        .map(|clause| {
            let mut parts = clause.walk();
            let name = clause
                .children(&mut parts)
                .find(|part| part.kind() == "upper_case_qid")
                .filter(|_| !clause.has_error());
            (clause, name)
        })
        .collect()
}

/// The name of the module that a file declares, and the place of the name
/// in the file. Columns count bytes.
fn declared_name(content: &str) -> Option<(String, Range)> {
    let parser = ElmParser::new();
    let tree = parser.parse(content)?;
    let name = header_clauses(&tree)
        .into_iter()
        .find_map(|(clause, name)| name.filter(|_| clause.kind() == "module_declaration"))?;
    Some((
        content[name.byte_range()].to_string(),
        parser.node_to_range(name),
    ))
}

/// The name of the module that a file declares, read from its text
pub(crate) fn extract_module_name_from_content(content: &str) -> Option<String> {
    declared_name(content).map(|(name, _)| name)
}

/// The place of the module's name in the file that declares it
pub(crate) fn find_module_name_range(content: &str) -> Option<Range> {
    declared_name(content).map(|(_, place)| place)
}
