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
        if let Some(module_range) = find_module_declaration_range(&content) {
            let new_module_decl = format!("module {} exposing", new_module_name);
            let old_module_decl_match = format!("module {} exposing", old_module_name);

            if content.contains(&old_module_decl_match) {
                changes.entry(uri.clone()).or_default().push(TextEdit {
                    range: module_range,
                    new_text: new_module_decl,
                });
            }
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
        if let Some(module_range) = find_module_declaration_range(&content) {
            let new_module_decl = format!("module {} exposing", new_module_name);
            changes.entry(uri.clone()).or_default().push(TextEdit {
                range: module_range,
                new_text: new_module_decl,
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
        let import_pattern = format!("import {}", old_module);
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

            // Find all import statements for the old module
            for (line_num, line) in content.lines().enumerate() {
                let trimmed = line.trim();
                if trimmed.starts_with(&import_pattern) {
                    // Check it's not a prefix match (e.g., "import Foo" shouldn't match "import FooBar")
                    let after_import = &trimmed[import_pattern.len()..];
                    if after_import.is_empty()
                        || after_import.starts_with(' ')
                        || after_import.starts_with('\n')
                        || after_import.starts_with('\t')
                    {
                        let line_start = line.find("import").unwrap_or(0);
                        let old_end = line_start + "import ".len() + old_module.len();

                        changes.entry(file_uri.clone()).or_default().push(TextEdit {
                            range: Range {
                                start: Position {
                                    line: line_num as u32,
                                    character: (line_start + "import ".len()) as u32,
                                },
                                end: Position {
                                    line: line_num as u32,
                                    character: old_end as u32,
                                },
                            },
                            new_text: new_module.to_string(),
                        });

                        files_updated += 1;
                    }
                }

                // Also check for qualified references like "OldModule.function"
                // This handles cases where the module is used with qualification
                let qualified_pattern = format!("{}.", old_module);
                if trimmed.contains(&qualified_pattern)
                    && !trimmed.starts_with("import ")
                    && !trimmed.starts_with("module ")
                {
                    // Find all occurrences in the line
                    let mut search_start = 0;
                    while let Some(pos) = line[search_start..].find(&qualified_pattern) {
                        let actual_pos = search_start + pos;

                        // Make sure it's not part of a larger identifier
                        let before_ok = actual_pos == 0
                            || !line
                                .chars()
                                .nth(actual_pos - 1)
                                .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '.');

                        if before_ok {
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
        }

        Ok(files_updated)
    }
}

/// Extract module name from file content using simple string parsing
pub(crate) fn extract_module_name_from_content(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(after_module) = trimmed.strip_prefix("module ") {
            // Find "exposing" to extract the module name
            if let Some(exposing_pos) = after_module.find(" exposing") {
                let module_name = after_module[..exposing_pos].trim();
                // Validate it's a proper module name (starts with uppercase)
                if module_name.chars().next().is_some_and(char::is_uppercase) {
                    return Some(module_name.to_string());
                }
            }
        }
    }
    None
}

/// Find the range of the module declaration (just "module ModuleName exposing" part)
pub(crate) fn find_module_declaration_range(content: &str) -> Option<Range> {
    for (line_num, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if let Some(after_module) = trimmed.strip_prefix("module ") {
            if let Some(exposing_pos) = after_module.find(" exposing") {
                let module_name = after_module[..exposing_pos].trim();
                // Validate it's a proper module name
                if module_name.chars().next().is_some_and(char::is_uppercase) {
                    let line_start = line.find("module")?;
                    // Calculate end: "module " + module_name + " exposing"
                    let decl_len = "module ".len() + module_name.len() + " exposing".len();
                    return Some(Range {
                        start: Position {
                            line: line_num as u32,
                            character: line_start as u32,
                        },
                        end: Position {
                            line: line_num as u32,
                            character: (line_start + decl_len) as u32,
                        },
                    });
                }
            }
        }
    }
    None
}
