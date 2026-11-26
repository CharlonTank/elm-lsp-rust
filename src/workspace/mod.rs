use icu_normalizer::ComposingNormalizerBorrowed;
use icu_properties::{props::GeneralCategory, CodePointMapData};
use std::collections::{BTreeMap, HashMap};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tower_lsp::lsp_types::*;
use walkdir::WalkDir;

use crate::binder::BoundSymbolKind;
use crate::document::ElmSymbol;
use crate::parser::ElmParser;
use crate::type_checker::TypeChecker;

mod erd;
mod field_operations;
mod file_operations;
mod move_function;
mod types;
mod variant_operations;

pub use erd::*;
pub use types::*;

/// True when an elm.json lists a lamdera/* package, directly or indirectly.
/// That makes the project a Lamdera project.
pub fn depends_on_lamdera(elm_json: &serde_json::Value) -> bool {
    ["direct", "indirect"].iter().any(|kind| {
        elm_json["dependencies"][kind]
            .as_object()
            .is_some_and(|packages| packages.keys().any(|name| name.starts_with("lamdera/")))
    })
}

/// The path without its "." and ".." parts, worked out from the text alone.
pub(crate) fn normalized(path: &Path) -> PathBuf {
    let mut plain = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                plain.pop();
            }
            other => plain.push(other.as_os_str()),
        }
    }
    plain
}

/// The place that `listed` names when it is read from the directory `from`,
/// without "." and ".." in it, so a file there has one name in the index.
/// ".." is read as the file system reads it, and as the compiler therefore
/// does: behind a link it is the directory above the one the link leads to,
/// where the text alone says it is the one the link lies in. With
/// home/app a link to data/app, "../shared" is data/shared.
pub(crate) fn resolved_from(from: &Path, listed: &Path) -> PathBuf {
    use std::path::Component;
    let mut place = from.to_path_buf();
    for component in listed.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if place.is_symlink() {
                    if let Ok(real) = place.canonicalize() {
                        place = real;
                    }
                }
                place.pop();
            }
            Component::Normal(part) => place.push(part),
            // A path that starts at the root of the file system leaves `from` behind
            start => place = PathBuf::from(start.as_os_str()),
        }
    }
    place
}

/// What tells a file from every other on this machine, however its path is
/// spelled. A link has one of its own, apart from the file it leads to.
/// `None` where nothing is at the path, and on a system that has no such
/// thing to tell.
#[cfg(unix)]
fn identity_of(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let entry = path.symlink_metadata().ok()?;
    Some((entry.dev(), entry.ino()))
}

#[cfg(not(unix))]
fn identity_of(_path: &Path) -> Option<(u64, u64)> {
    None
}

/// True when two paths name one file: they are one path, or two spellings of
/// it on a file system that ignores letter case, or the form an accent is
/// written in. A file is no copy of itself, whatever a client calls it.
pub(crate) fn is_same_file(one: &Path, other: &Path) -> bool {
    one == other || identity_of(one).is_some_and(|identity| identity_of(other) == Some(identity))
}

/// `path` with its parts as the disk spells them, from where it leaves
/// `known`, a path that is spelled as its files are. A file system that
/// ignores case reads "SRC" in elm.json as the directory src, and the index
/// knows a file by one spelling, the one a client names it by.
pub(crate) fn as_spelled_on_disk(path: &Path, known: &Path) -> PathBuf {
    let shared = path
        .components()
        .zip(known.components())
        .take_while(|(ours, theirs)| ours == theirs)
        .count();
    let mut spelled: PathBuf = path.components().take(shared).collect();
    for component in path.components().skip(shared) {
        let part = component.as_os_str();
        let listed = name_listed_in(&spelled, part);
        spelled.push(listed.as_deref().unwrap_or(part));
    }
    spelled
}

/// The name that a directory lists for the entry it also finds under `name`,
/// another spelling of it. `None` where the directory lists `name` itself,
/// and where nothing is found under it: a file system that tells "SRC" from
/// "src" has no SRC to offer when it holds a src.
fn name_listed_in(directory: &Path, name: &OsStr) -> Option<OsString> {
    let wanted = identity_of(&directory.join(name))?;
    let mut listed = Vec::new();
    for entry in std::fs::read_dir(directory).ok()?.flatten() {
        if entry.file_name() == name {
            return None;
        }
        listed.push(entry.file_name());
    }
    listed
        .into_iter()
        .find(|other| identity_of(&directory.join(other)) == Some(wanted))
}

/// Whether a directory or a file, without its extension, can be one part of
/// a module name: an upper-case letter, then letters, the digits 0 to 9 and
/// underscores. A letter is one of any script, as it is for the compiler,
/// which builds a module Été. What only looks like a letter is none for
/// either: a numeral such as Ⅷ, a mark that joins the letter in front of
/// it, a letter in a square. The compiler also takes a name that starts with
/// one of the few letters that are two capitals in one, ǅ. The grammar that
/// the index reads a file with does not, so no tool gives a module such a
/// name.
pub(crate) fn is_module_segment(name: &str) -> bool {
    use GeneralCategory::*;
    let category_of = CodePointMapData::<GeneralCategory>::new();
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| category_of.get(first) == UppercaseLetter)
        && chars.all(|c| {
            c.is_ascii_digit()
                || c == '_'
                || matches!(
                    category_of.get(c),
                    UppercaseLetter
                        | LowercaseLetter
                        | TitlecaseLetter
                        | ModifierLetter
                        | OtherLetter
                )
        })
}

/// The module name that a path below a source directory spells, with dots
/// for the separators and every accent as one letter. The error is the part
/// that can be no part of a name, or nothing where the path names no file.
fn module_name_below(below: &Path) -> Result<String, Option<String>> {
    let segments: Vec<String> = below
        .with_extension("")
        .components()
        .map(|component| composed(&component.as_os_str().to_string_lossy()))
        .collect();
    if let Some(odd) = segments.iter().find(|segment| !is_module_segment(segment)) {
        return Err(Some(odd.clone()));
    }
    if segments.is_empty() {
        return Err(None);
    }
    Ok(segments.join("."))
}

/// A name with every accent written as one letter, the form a module's name
/// has for the compiler. A disk can keep the same name as a letter with a
/// mark behind it, and finds it under either form.
pub(crate) fn composed(name: &str) -> String {
    ComposingNormalizerBorrowed::new_nfc()
        .normalize(name)
        .into_owned()
}

/// Why a file is not there for the index to read.
enum Absent {
    /// Nothing is at the path, or a link that leads nowhere
    Gone,
    /// Something is, and it cannot be looked at. Carries the reason.
    Hidden(String),
}

/// Whether an error says that nothing is at a path: no entry of that name,
/// or a plain file where one of the directories on the way would have to be.
fn says_nothing_is_there(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

/// Look at a path the way a read of it would, following links: `Ok` when a
/// file is there. A missing permission on a directory above it must not pass
/// for a missing file, or the index would drop a module that is still there.
fn file_at(path: &Path) -> Result<(), Absent> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => Err(Absent::Gone),
        Err(e) if says_nothing_is_there(&e) => Err(Absent::Gone),
        Err(e) => Err(Absent::Hidden(e.to_string())),
    }
}

/// How a source file looked when the index last read it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct FileStamp {
    modified: SystemTime,
    len: u64,
}

/// File systems round modification times, some to two seconds. A file that
/// changed more recently than this can change again without a new stamp, so
/// it gets none and is read again at the next look.
const UNSETTLED: Duration = Duration::from_secs(2);

impl FileStamp {
    /// The stamp of a file, or `None` while the file is too fresh to have a reliable one.
    fn of(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path).ok()?;
        let modified = metadata.modified().ok()?;
        // A date well ahead of the clock is as far from the next write as one well behind it
        let settled = match modified.elapsed() {
            Ok(age) => age > UNSETTLED,
            Err(ahead) => ahead.duration() > UNSETTLED,
        };
        settled.then_some(FileStamp {
            modified,
            len: metadata.len(),
        })
    }

    /// Whether a file that had the stamp `before` and has the stamp `now` is
    /// known to be the same. Without a stamp it may have changed unnoticed.
    fn unchanged(before: &Option<Self>, now: &Option<Self>) -> bool {
        now.is_some() && before == now
    }
}

/// The source files that differ on disk from what the index last read.
#[derive(Debug, Default, PartialEq)]
pub struct DiskChanges {
    /// New or modified
    pub changed: Vec<PathBuf>,
    /// Gone
    pub deleted: Vec<PathBuf>,
}

/// Represents an Elm module with its symbols and metadata
#[derive(Debug, Clone)]
pub struct ElmModule {
    pub path: PathBuf,
    pub module_name: String,
    pub symbols: Vec<ElmSymbol>,
    pub imports: Vec<ImportInfo>,
    pub exposing: ExposingInfo,
}

#[derive(Debug, Clone)]
pub struct ImportInfo {
    pub module_name: String,
    pub alias: Option<String>,
    pub exposing: ExposingInfo,
}

#[derive(Debug, Clone)]
pub enum ExposingInfo {
    All,
    Explicit(Vec<String>),
}

/// Cross-file symbol reference
#[derive(Debug, Clone)]
pub struct SymbolReference {
    pub uri: Url,
    pub range: Range,
    pub is_definition: bool,
    pub kind: Option<BoundSymbolKind>,
    /// For field references, the type alias that contains this field
    pub type_context: Option<String>,
}

/// A symbol definition at a specific position
/// Used by classify_definition_at_position for type-aware reference finding
#[derive(Debug, Clone)]
pub struct DefinitionSymbol {
    pub name: String,
    pub kind: BoundSymbolKind,
    pub uri: Url,
    pub range: Range,
    /// For fields: the type alias name; for constructors: the custom type name
    pub type_context: Option<String>,
    pub module_name: Option<String>,
    /// For local variables: the start/end positions of their scope (function body, case branch, etc.)
    pub scope_range: Option<Range>,
}

/// Global symbol entry in the index
#[derive(Debug, Clone)]
pub struct GlobalSymbol {
    pub name: String,
    pub module_name: String,
    pub kind: SymbolKind,
    pub definition_uri: Url,
    pub definition_range: Range,
    pub signature: Option<String>,
}

/// Protected files in Lamdera projects that should not be renamed/moved
const LAMDERA_PROTECTED_FILES: &[&str] = &["Env.elm", "Types.elm", "Frontend.elm", "Backend.elm"];

/// Protected type names in Lamdera projects that should not be renamed
const LAMDERA_PROTECTED_TYPES: &[&str] = &[
    "FrontendMsg",
    "BackendMsg",
    "ToBackend",
    "ToFrontend",
    "FrontendModel",
    "BackendModel",
];

/// Represents an external package dependency
#[derive(Debug, Clone)]
pub struct ExternalPackage {
    pub name: String,    // e.g., "elm/core"
    pub version: String, // e.g., "1.0.5"
    pub path: PathBuf,   // Path to package source
}

/// The workspace index - tracks all symbols across all files
pub struct Workspace {
    pub root_path: PathBuf,
    pub source_dirs: Vec<PathBuf>,
    pub modules: HashMap<String, ElmModule>,
    pub symbols: HashMap<String, Vec<GlobalSymbol>>,
    pub references: HashMap<String, Vec<SymbolReference>>,
    pub parser: ElmParser,
    pub type_checker: TypeChecker,
    pub is_lamdera_project: bool,
    /// External packages (from ~/.elm or elm-stuff)
    pub external_packages: Vec<ExternalPackage>,
    /// Symbols from external packages (indexed separately)
    pub external_symbols: HashMap<String, Vec<GlobalSymbol>>,
    /// The source files as the index last read them
    file_stamps: HashMap<PathBuf, Option<FileStamp>>,
    /// elm.json as it was read, or `None` when there was none
    elm_json_text: Option<String>,
    /// The source directories as elm.json lists them, to be spelled again
    /// when the disk may have changed
    listed_source_dirs: Vec<String>,
    /// Source files that could not be read, each with the reason. The index
    /// knows nothing of them, so a refactoring would pass them over.
    unreadable: BTreeMap<PathBuf, String>,
    /// What the last walk of the source directories could not look at, each
    /// with the reason: a directory it could not list, or a file it could not
    /// tell from a missing one. What lies there is unknown to the index.
    hidden: Vec<(PathBuf, String)>,
    /// Files that wait for a module name which another file holds, each with
    /// that name. Two files can declare one module for a while, a copy that
    /// is not yet renamed for one, and `modules` has room for one of them.
    /// A waiting file is known to the index and not read into it.
    displaced: BTreeMap<PathBuf, String>,
}

impl Workspace {
    pub fn new(root_path: PathBuf) -> Self {
        Self {
            root_path,
            source_dirs: Vec::new(),
            modules: HashMap::new(),
            symbols: HashMap::new(),
            references: HashMap::new(),
            parser: ElmParser::new(),
            type_checker: TypeChecker::new(),
            is_lamdera_project: false,
            external_packages: Vec::new(),
            external_symbols: HashMap::new(),
            file_stamps: HashMap::new(),
            elm_json_text: None,
            listed_source_dirs: Vec::new(),
            unreadable: BTreeMap::new(),
            hidden: Vec::new(),
            displaced: BTreeMap::new(),
        }
    }

    /// Check if a symbol name is a protected Lamdera type that cannot be renamed
    pub fn is_protected_lamdera_type(&self, name: &str) -> bool {
        self.is_lamdera_project && LAMDERA_PROTECTED_TYPES.contains(&name)
    }

    /// Deduplicate references by (uri, range) - sorts and removes duplicates
    fn deduplicate_references(results: &mut Vec<SymbolReference>) {
        results.sort_by(|a, b| {
            (&a.uri, a.range.start.line, a.range.start.character).cmp(&(
                &b.uri,
                b.range.start.line,
                b.range.start.character,
            ))
        });
        results.dedup_by(|a, b| a.uri == b.uri && a.range == b.range);
    }

    /// Extract base name from a potentially qualified symbol name (e.g., "Module.func" -> "func")
    fn extract_base_name(qualified_name: &str) -> &str {
        if qualified_name.contains('.') {
            qualified_name.rsplit('.').next().unwrap_or(qualified_name)
        } else {
            qualified_name
        }
    }

    /// Iterate over non-Evergreen modules with their URIs
    fn iter_non_evergreen_modules(&self) -> impl Iterator<Item = (&ElmModule, Url)> {
        self.modules.values().filter_map(|module| {
            if module.path.to_string_lossy().contains("/Evergreen/") {
                return None;
            }
            Url::from_file_path(&module.path)
                .ok()
                .map(|uri| (module, uri))
        })
    }

    /// Sort text edits in reverse order (bottom to top) within each file
    /// to avoid offset issues when applying edits sequentially
    pub(super) fn sort_edits_reverse(changes: &mut HashMap<Url, Vec<TextEdit>>) {
        for edits in changes.values_mut() {
            edits.sort_by(|a, b| {
                b.range
                    .start
                    .line
                    .cmp(&a.range.start.line)
                    .then_with(|| b.range.start.character.cmp(&a.range.start.character))
            });
        }
    }

    /// Initialize workspace by reading elm.json and indexing all files
    pub fn initialize(&mut self) -> anyhow::Result<()> {
        // Read elm.json to find source directories
        self.elm_json_text = self.read_elm_json()?;
        if let Some(content) = self.elm_json_text.clone() {
            self.parse_elm_json(&content)?;
        } else {
            // Default to src/ if no elm.json
            self.listed_source_dirs = vec!["src".to_string()];
            self.spell_source_directories();
        }

        // Index all .elm files
        self.index_all_files()?;

        // Index external packages for go-to-definition support
        self.index_external_packages()?;

        Ok(())
    }

    /// A source directory as the index names it: the place the file system
    /// finds for what elm.json lists, spelled as the disk spells it from
    /// where it leaves the project root.
    fn source_directory(&self, dir: &str) -> PathBuf {
        as_spelled_on_disk(
            &resolved_from(&self.root_path, Path::new(dir)),
            &self.root_path,
        )
    }

    /// Work out the source directories from what elm.json lists. That is
    /// done again at each comparison with the disk: a directory for generated
    /// code can come into being later, in another letter case than elm.json
    /// has for it.
    fn spell_source_directories(&mut self) {
        self.source_dirs = self
            .listed_source_dirs
            .iter()
            .map(|dir| self.source_directory(dir))
            .collect();
    }

    fn parse_elm_json(&mut self, content: &str) -> anyhow::Result<()> {
        let json: serde_json::Value = serde_json::from_str(content)?;

        // Detect Lamdera project by checking for lamdera/* dependencies
        self.is_lamdera_project = depends_on_lamdera(&json);
        if self.is_lamdera_project {
            tracing::info!("Detected Lamdera project");
        }

        // An application lists its source directories. A package has none to
        // list and keeps its modules in src. A directory that is not there yet
        // is kept as well: generated sources appear after the server started,
        // and the walk passes over what does not exist.
        self.listed_source_dirs = match json
            .get("source-directories")
            .and_then(|dirs| dirs.as_array())
        {
            Some(dirs) => dirs
                .iter()
                .filter_map(|dir| dir.as_str())
                .map(str::to_string)
                .collect(),
            None => vec!["src".to_string()],
        };
        self.spell_source_directories();

        // Parse dependencies for external package support
        self.parse_dependencies(&json);

        Ok(())
    }

    /// Parse dependencies from elm.json and locate package sources
    fn parse_dependencies(&mut self, json: &serde_json::Value) {
        let elm_home = Self::get_elm_home();

        if let Some(deps) = json.get("dependencies") {
            // Parse direct dependencies
            if let Some(direct) = deps.get("direct") {
                self.collect_packages(direct, &elm_home);
            }
            // Parse indirect dependencies
            if let Some(indirect) = deps.get("indirect") {
                self.collect_packages(indirect, &elm_home);
            }
        }

        tracing::info!("Found {} external packages", self.external_packages.len());
    }

    /// Collect packages from a dependencies object
    fn collect_packages(&mut self, deps: &serde_json::Value, elm_home: &Path) {
        if let Some(obj) = deps.as_object() {
            for (name, version) in obj {
                if let Some(version_str) = version.as_str() {
                    // Try to find package in elm home
                    let package_path = elm_home
                        .join("0.19.1")
                        .join("packages")
                        .join(name.replace('/', std::path::MAIN_SEPARATOR_STR))
                        .join(version_str)
                        .join("src");

                    if package_path.exists() {
                        self.external_packages.push(ExternalPackage {
                            name: name.clone(),
                            version: version_str.to_string(),
                            path: package_path,
                        });
                    }
                }
            }
        }
    }

    /// Get the Elm home directory (~/.elm or ELM_HOME)
    fn get_elm_home() -> PathBuf {
        if let Ok(elm_home) = std::env::var("ELM_HOME") {
            PathBuf::from(elm_home)
        } else if let Some(home) = dirs::home_dir() {
            home.join(".elm")
        } else {
            PathBuf::from(".elm")
        }
    }

    /// Index external packages for go-to-definition support
    fn index_external_packages(&mut self) -> anyhow::Result<()> {
        let packages: Vec<_> = self.external_packages.clone();

        for package in &packages {
            if let Err(e) = self.index_external_package(package) {
                tracing::warn!("Failed to index package {}: {}", package.name, e);
            }
        }

        tracing::info!("Indexed {} external symbols", self.external_symbols.len());
        Ok(())
    }

    /// Index a single external package
    fn index_external_package(&mut self, package: &ExternalPackage) -> anyhow::Result<()> {
        for entry in WalkDir::new(&package.path)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "elm") {
                self.index_external_file(path, &package.name)?;
            }
        }
        Ok(())
    }

    /// Index a single external file (only extracts symbols, no references)
    fn index_external_file(&mut self, path: &Path, _package_name: &str) -> anyhow::Result<()> {
        let content = std::fs::read_to_string(path)?;
        let uri = Url::from_file_path(path).map_err(|_| anyhow::anyhow!("Invalid path"))?;

        if let Some(tree) = self.parser.parse(&content) {
            let symbols = self.parser.extract_symbols(&tree, &content);
            let module_name = self
                .extract_module_name(&tree, &content)
                .unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Unknown")
                        .to_string()
                });

            // Add symbols to external index (not the main symbols index)
            for symbol in &symbols {
                let global_symbol = GlobalSymbol {
                    name: symbol.name.clone(),
                    module_name: module_name.clone(),
                    kind: symbol.kind,
                    definition_uri: uri.clone(),
                    definition_range: symbol.definition_range.unwrap_or(symbol.range),
                    signature: symbol.signature.clone(),
                };

                // Index by unqualified name
                self.external_symbols
                    .entry(symbol.name.clone())
                    .or_default()
                    .push(global_symbol.clone());

                // Index by qualified name
                let qualified_name = format!("{}.{}", module_name, symbol.name);
                self.external_symbols
                    .entry(qualified_name)
                    .or_default()
                    .push(global_symbol);
            }
        }

        Ok(())
    }

    /// The .elm files in the source directories. A Lamdera project's
    /// Evergreen snapshots are left out. What cannot be looked at is noted,
    /// because the answer is short of it.
    fn source_files(&mut self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        let mut hidden = Vec::new();

        for source_dir in &self.source_dirs {
            // No part of a module's name starts with a dot, so below a source directory
            // nothing that does is a module or leads to one. macOS keeps ._Main.elm beside
            // Main.elm on a volume without extended attributes, and it is no text.
            let walk = WalkDir::new(source_dir).into_iter().filter_entry(|entry| {
                entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
            });
            for entry in walk {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(e) => {
                        // What is not there has nothing to read, such as a
                        // source directory that is still to be generated
                        let io = e.io_error();
                        let missing = io.is_some_and(says_nothing_is_there);
                        if let (false, Some(path)) = (missing, e.path()) {
                            let reason = io.map_or_else(|| e.to_string(), |io| io.to_string());
                            hidden.push((path.to_path_buf(), reason));
                        }
                        continue;
                    }
                };
                let path = entry.path();

                if self.is_lamdera_project && self.is_evergreen_path(path) {
                    continue;
                }
                let is_elm = path.extension().is_some_and(|ext| ext == "elm");
                if !is_elm {
                    continue;
                }

                // Links are followed, so a link to nothing is left out, such as one
                // to a module that is still to be generated
                match file_at(path) {
                    Ok(()) => files.push(path.to_path_buf()),
                    Err(Absent::Gone) => {}
                    Err(Absent::Hidden(reason)) => hidden.push((path.to_path_buf(), reason)),
                }
            }
        }

        self.hidden = hidden;
        files
    }

    /// The text of elm.json, or `None` when the project has none. A file
    /// that is there and cannot be read is an error: taking it for a missing
    /// one would index another project than the one on disk.
    fn read_elm_json(&self) -> std::io::Result<Option<String>> {
        match std::fs::read_to_string(self.root_path.join("elm.json")) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Whether elm.json reads differently now than when the index was built.
    /// The source directories and the dependencies come from it, so the index
    /// has to be built anew. The file is small, and its text tells more
    /// reliably than its modification time.
    pub fn elm_json_changed(&self) -> bool {
        !self
            .read_elm_json()
            .is_ok_and(|text| text == self.elm_json_text)
    }

    /// Note that a source file could not be read. It gets no stamp, so the
    /// next comparison reports it again.
    pub fn mark_unreadable(&mut self, path: &Path, reason: String) {
        self.file_stamps.insert(path.to_path_buf(), None);
        self.unreadable.insert(path.to_path_buf(), reason);
    }

    /// Note that a source file was read after all.
    pub fn mark_read(&mut self, path: &Path) {
        self.unreadable.remove(path);
    }

    /// What is missing from the index, in one sentence, or `None` when every
    /// source file was read.
    pub fn unreadable_files(&self) -> Option<String> {
        // A file can be on both lists: hidden from the walk, and then not read
        let mut all: BTreeMap<&PathBuf, &String> = self.unreadable.iter().collect();
        all.extend(self.hidden.iter().map(|(path, reason)| (path, reason)));
        // A directory that cannot be listed speaks for the files in it
        let unread: Vec<(&PathBuf, &String)> = all
            .iter()
            .filter(|(path, _)| {
                !path
                    .ancestors()
                    .skip(1)
                    .any(|above| all.contains_key(&above.to_path_buf()))
            })
            .map(|(path, reason)| (*path, *reason))
            .collect();
        let (path, reason) = unread.first()?;
        let more = match unread.len() - 1 {
            0 => String::new(),
            1 => " One more file or directory cannot be read either.".to_string(),
            n => format!(" {} more files or directories cannot be read either.", n),
        };
        Some(format!(
            "Cannot read {}: {}.{}",
            path.display(),
            reason,
            more
        ))
    }

    /// Compare the source files on disk with what the index last read, and
    /// remember how they look now. The caller brings the index up to date.
    pub fn take_disk_changes(&mut self) -> DiskChanges {
        self.spell_source_directories();
        let mut current: HashMap<PathBuf, Option<FileStamp>> = self
            .source_files()
            .into_iter()
            .map(|path| {
                let stamp = FileStamp::of(&path);
                (path, stamp)
            })
            .collect();

        // A file that the walk does not return is in the index once a document
        // was opened for it: a test or an Evergreen snapshot. It has no stamp
        // until the first comparison, which reads it for that reason. One that
        // could not be read is looked for again in the same way.
        let beyond: Vec<PathBuf> = self
            .modules
            .values()
            .map(|module| &module.path)
            .chain(self.unreadable.keys())
            .chain(self.displaced.keys())
            .filter(|path| !current.contains_key(*path))
            .cloned()
            .collect();
        let mut gone: Vec<PathBuf> = Vec::new();
        for path in beyond {
            match file_at(&path) {
                Ok(()) => {
                    let stamp = FileStamp::of(&path);
                    current.insert(path, stamp);
                }
                Err(Absent::Gone) => gone.push(path),
                // Still there, as far as anyone can tell. Without a stamp it
                // is read at this and every later comparison, and the failed
                // read is what the caller reports.
                Err(Absent::Hidden(_)) => {
                    current.insert(path, None);
                }
            }
        }

        let mut changes = DiskChanges::default();
        for (path, stamp) in &current {
            let known = self.file_stamps.get(path);
            if !known.is_some_and(|before| FileStamp::unchanged(before, stamp)) {
                changes.changed.push(path.clone());
            }
        }
        changes.deleted = self
            .file_stamps
            .keys()
            .filter(|path| !current.contains_key(*path))
            .cloned()
            .chain(gone)
            .collect();
        changes.changed.sort();
        changes.deleted.sort();
        changes.deleted.dedup();
        for path in &changes.deleted {
            self.unreadable.remove(path);
        }

        self.file_stamps = current;
        changes
    }

    /// The indexed files that a walk of the source directories does not
    /// return, such as a test a document was opened for. One of them that
    /// could not be read is in no module, and neither is one whose module
    /// name another file took. Both are files of the index all the same: the
    /// index that is built after this one has to ask for them again.
    pub fn files_beyond_the_walk(&mut self) -> Vec<PathBuf> {
        let walked: std::collections::HashSet<PathBuf> = self.source_files().into_iter().collect();
        let mut beyond: Vec<PathBuf> = self
            .modules
            .values()
            .map(|module| &module.path)
            .chain(self.unreadable.keys())
            .chain(self.displaced.keys())
            .filter(|path| !walked.contains(*path))
            .cloned()
            .collect();
        beyond.sort();
        beyond.dedup();
        beyond
    }

    /// Index files that an earlier index held beyond its walk, so that
    /// building the index anew does not drop them. One that this index has
    /// from its own walk, or that is gone, is passed over.
    pub fn adopt(&mut self, paths: &[PathBuf]) {
        for path in paths {
            if self.modules.values().any(|module| module.path == *path) {
                continue;
            }
            match std::fs::read_to_string(path) {
                Ok(text) => {
                    if let Ok(uri) = Url::from_file_path(path) {
                        self.update_file(&uri, &text);
                    }
                }
                Err(e) if says_nothing_is_there(&e) => {}
                Err(e) => self.mark_unreadable(path, e.to_string()),
            }
        }
    }

    /// The name a module must have to live at `path`: the path below its
    /// source directory, with dots for the separators and every accent as
    /// one letter, whichever form the disk keeps it in. An error when the path
    /// is in no source directory, or a part of it can be no part of a name.
    pub(crate) fn module_name_at(&self, path: &Path) -> anyhow::Result<String> {
        // Of nested source directories, the innermost holds the file
        let below = self
            .source_dirs
            .iter()
            .filter_map(|dir| path.strip_prefix(dir).ok())
            .min_by_key(|below| below.components().count());
        let Some(below) = below else {
            let listed: Vec<String> = self
                .source_dirs
                .iter()
                .map(|dir| {
                    dir.strip_prefix(&self.root_path)
                        .unwrap_or(dir)
                        .display()
                        .to_string()
                })
                .collect();
            anyhow::bail!(
                "{} is in no source directory of elm.json ({})",
                path.display(),
                listed.join(", ")
            );
        };

        match module_name_below(below) {
            Ok(name) => Ok(name),
            Err(Some(odd)) => anyhow::bail!(
                "\"{}\" cannot be part of a module name. Below the source directory, every directory and the file need a name that starts with an upper-case letter and holds only letters, digits and underscores",
                odd
            ),
            Err(None) => anyhow::bail!("{} names no file", path.display()),
        }
    }

    /// Index all .elm files in the workspace
    pub fn index_all_files(&mut self) -> anyhow::Result<()> {
        let files_to_index = self.source_files();
        // Stamped before the files are read, so a change in between shows up as one later
        self.file_stamps = files_to_index
            .iter()
            .map(|path| (path.clone(), FileStamp::of(path)))
            .collect();

        tracing::info!("Indexing {} Elm files", files_to_index.len());

        self.unreadable.clear();
        self.displaced.clear();
        for path in files_to_index {
            if let Err(e) = self.index_file(&path) {
                tracing::warn!("Failed to index {:?}: {}", path, e);
                self.mark_unreadable(&path, e.to_string());
            }
        }

        // Build reference index after all files are parsed
        self.build_reference_index();

        Ok(())
    }

    /// Check if a path is in the Evergreen directory
    fn is_evergreen_path(&self, path: &Path) -> bool {
        path.components().any(|c| {
            if let std::path::Component::Normal(name) = c {
                name == "Evergreen"
            } else {
                false
            }
        })
    }

    /// Index a single file
    pub fn index_file(&mut self, path: &Path) -> anyhow::Result<()> {
        let content = std::fs::read_to_string(path)?;
        let uri = Url::from_file_path(path).map_err(|_| anyhow::anyhow!("Invalid path"))?;

        if let Some(tree) = self.parser.parse(&content) {
            let module_name = self
                .extract_module_name(&tree, &content)
                .unwrap_or_else(|| self.path_to_module_name(path));
            if self.has_to_wait(path, &module_name) {
                self.displaced.insert(path.to_path_buf(), module_name);
                return Ok(());
            }
            let symbols = self.parser.extract_symbols(&tree, &content);
            let imports = self.extract_imports(&tree, &content);
            let exposing = self.extract_exposing(&tree, &content);

            // Index for type checking
            self.type_checker
                .index_file(uri.as_str(), &content, tree.clone());

            // Index references from this file
            self.find_references_in_tree(&tree, &content, &uri, &module_name, &imports);

            // Add symbols to global index
            for symbol in &symbols {
                let qualified_name = format!("{}.{}", module_name, symbol.name);

                let global_symbol = GlobalSymbol {
                    name: symbol.name.clone(),
                    module_name: module_name.clone(),
                    kind: symbol.kind,
                    definition_uri: uri.clone(),
                    definition_range: symbol.definition_range.unwrap_or(symbol.range),
                    signature: symbol.signature.clone(),
                };

                self.symbols
                    .entry(symbol.name.clone())
                    .or_default()
                    .push(global_symbol.clone());

                // Also index by qualified name
                self.symbols
                    .entry(qualified_name)
                    .or_default()
                    .push(global_symbol);
            }

            let module = ElmModule {
                path: path.to_path_buf(),
                module_name: module_name.clone(),
                symbols,
                imports,
                exposing,
            };

            self.enter_module(module);
        }

        Ok(())
    }

    /// True when the file at `path` lies where a module of this name belongs:
    /// below a source directory, at the path that spells the name. That is
    /// where the compiler looks for the module. Source directories can lie
    /// inside one another, and any of them will do: with "src" and "src/Sub"
    /// in elm.json, src/Sub/Utils.elm is the home of Utils and of Sub.Utils.
    fn is_at_home(&self, path: &Path, module_name: &str) -> bool {
        self.source_dirs
            .iter()
            .filter_map(|dir| path.strip_prefix(dir).ok())
            .any(|below| module_name_below(below).is_ok_and(|spelled| spelled == module_name))
    }

    /// True when another file holds this module name with the better claim to
    /// it: that file lies where the name says, and the one at `path` does
    /// not. A copy that still declares the module it was made from is such a
    /// file. The compiler reads the other one and never this.
    fn has_to_wait(&self, path: &Path, module_name: &str) -> bool {
        self.modules.get(module_name).is_some_and(|holder| {
            !is_same_file(&holder.path, path)
                && self.is_at_home(&holder.path, module_name)
                && !self.is_at_home(path, module_name)
        })
    }

    /// True when `path` lies below a source directory of elm.json, where the
    /// compiler finds a file by the module name its path spells.
    pub fn is_in_source_directory(&self, path: &Path) -> bool {
        self.source_dirs.iter().any(|dir| path.starts_with(dir))
    }

    /// The module that the file at `path` declares and waits for, with the
    /// file that holds it. `None` for a file that is in the index, and for one
    /// the index does not know.
    pub fn waits_behind(&self, path: &Path) -> Option<(&str, &Path)> {
        let module_name = self.displaced.get(path)?;
        let holder = self.modules.get(module_name)?;
        Some((module_name.as_str(), holder.path.as_path()))
    }

    /// Take the symbols, the references and the types of one file out of the
    /// index. They are told by the file they come from, not by the name of
    /// their module, which another file can declare as well.
    fn drop_contents(&mut self, uri: &Url) {
        for symbols in self.symbols.values_mut() {
            symbols.retain(|s| s.definition_uri != *uri);
        }
        self.type_checker.invalidate_file(uri.as_str());
        for refs in self.references.values_mut() {
            refs.retain(|r| r.uri != *uri);
        }
        self.references.retain(|_, refs| !refs.is_empty());
    }

    /// Take a file out of the index, with the module name if it holds one,
    /// which is returned.
    fn drop_file(&mut self, uri: &Url, path: &Path) -> Option<String> {
        let module_name = self
            .modules
            .iter()
            .find(|(_, m)| m.path == path)
            .map(|(name, _)| name.clone());
        if let Some(module_name) = &module_name {
            self.modules.remove(module_name);
        }
        self.displaced.remove(path);
        self.drop_contents(uri);
        module_name
    }

    /// Enter a module under its name. A file that held the name until now
    /// leaves the index and is remembered, so that it is read again when
    /// this one lets go of the name. The index holds the symbols of the files
    /// in `modules` and of no other. The same file under another spelling
    /// leaves nothing to remember: it is this one.
    fn enter_module(&mut self, module: ElmModule) {
        let path = module.path.clone();
        if let Some(before) = self.modules.insert(module.module_name.clone(), module) {
            if before.path != path {
                if let Ok(uri) = Url::from_file_path(&before.path) {
                    self.drop_contents(&uri);
                }
                if !is_same_file(&before.path, &path) {
                    self.displaced.insert(before.path, before.module_name);
                }
            }
        }
    }

    /// Give a module name that no file holds any more to a file that waits
    /// for it, one that lies where the name says before any other. A waiting
    /// file did not change on disk, so nothing else would read it, and its
    /// module would be missing from every answer.
    fn restore_displaced(&mut self, module_name: &str) {
        while !self.modules.contains_key(module_name) {
            let waiting = self
                .displaced
                .iter()
                .filter(|(_, name)| name.as_str() == module_name)
                .map(|(path, _)| path.clone())
                .max_by_key(|path| self.is_at_home(path, module_name));
            let Some(path) = waiting else {
                return;
            };
            self.displaced.remove(&path);
            match std::fs::read_to_string(&path) {
                Ok(text) => {
                    if let Ok(uri) = Url::from_file_path(&path) {
                        self.update_file(&uri, &text);
                    }
                }
                Err(e) if says_nothing_is_there(&e) => {}
                Err(e) => self.mark_unreadable(&path, e.to_string()),
            }
        }
    }

    /// Update a file in the index (called on didChange)
    pub fn update_file(&mut self, uri: &Url, content: &str) {
        let path = match uri.to_file_path() {
            Ok(p) => p,
            Err(_) => return,
        };

        let old_module_name = self.drop_file(uri, &path);

        // Re-index the file
        if let Some(tree) = self.parser.parse(content) {
            let module_name = self
                .extract_module_name(&tree, content)
                .unwrap_or_else(|| self.path_to_module_name(&path));

            if self.has_to_wait(&path, &module_name) {
                self.displaced.insert(path, module_name);
            } else {
                let symbols = self.parser.extract_symbols(&tree, content);
                let imports = self.extract_imports(&tree, content);
                let exposing = self.extract_exposing(&tree, content);

                // Re-index for type checking
                self.type_checker
                    .index_file(uri.as_str(), content, tree.clone());

                // Re-index references for this file
                self.find_references_in_tree(&tree, content, uri, &module_name, &imports);

                for symbol in &symbols {
                    let global_symbol = GlobalSymbol {
                        name: symbol.name.clone(),
                        module_name: module_name.clone(),
                        kind: symbol.kind,
                        definition_uri: uri.clone(),
                        definition_range: symbol.definition_range.unwrap_or(symbol.range),
                        signature: symbol.signature.clone(),
                    };

                    self.symbols
                        .entry(symbol.name.clone())
                        .or_default()
                        .push(global_symbol);
                }

                let module = ElmModule {
                    path,
                    module_name: module_name.clone(),
                    symbols,
                    imports,
                    exposing,
                };

                self.enter_module(module);
            }
        }

        // Under another name now, waiting for one, or no module at all
        if let Some(module_name) = old_module_name {
            self.restore_displaced(&module_name);
        }
    }

    /// Remove a file from the index
    pub fn remove_file(&mut self, uri: &Url) {
        let path = match uri.to_file_path() {
            Ok(p) => p,
            Err(_) => return,
        };

        if let Some(module_name) = self.drop_file(uri, &path) {
            self.restore_displaced(&module_name);
        }
    }

    /// Take in that a file was renamed or moved by somebody else: index the
    /// file at its new place, and drop the module of the old place once no
    /// file is there. Told of a move that did not happen, or of a copy, the
    /// index keeps the module whose file still exists.
    pub fn notify_file_renamed(&mut self, old_path: &Path, new_path: &Path) -> anyhow::Result<()> {
        let text = std::fs::read_to_string(new_path)?;
        let new_uri = Url::from_file_path(new_path).map_err(|_| anyhow::anyhow!("Invalid path"))?;

        if !matches!(file_at(old_path), Ok(()) | Err(Absent::Hidden(_))) {
            if let Ok(old_uri) = Url::from_file_path(old_path) {
                self.remove_file(&old_uri);
            }
        }
        self.update_file(&new_uri, &text);

        Ok(())
    }

    fn extract_module_name(&self, tree: &tree_sitter::Tree, source: &str) -> Option<String> {
        let root = tree.root_node();
        let mut cursor = root.walk();

        for child in root.children(&mut cursor) {
            if child.kind() == "module_declaration" {
                let mut inner_cursor = child.walk();
                for inner_child in child.children(&mut inner_cursor) {
                    if inner_child.kind() == "upper_case_qid" {
                        return Some(source[inner_child.byte_range()].to_string());
                    }
                }
            }
        }
        None
    }

    fn extract_imports(&self, tree: &tree_sitter::Tree, source: &str) -> Vec<ImportInfo> {
        let mut imports = Vec::new();
        let root = tree.root_node();
        let mut cursor = root.walk();

        for child in root.children(&mut cursor) {
            if child.kind() == "import_clause" {
                let mut module_name = None;
                let mut alias = None;
                let mut exposing = ExposingInfo::Explicit(Vec::new());

                let mut inner_cursor = child.walk();
                for inner_child in child.children(&mut inner_cursor) {
                    match inner_child.kind() {
                        "upper_case_qid" => {
                            module_name = Some(source[inner_child.byte_range()].to_string());
                        }
                        "as_clause" => {
                            let mut as_cursor = inner_child.walk();
                            for as_child in inner_child.children(&mut as_cursor) {
                                if as_child.kind() == "upper_case_identifier" {
                                    alias = Some(source[as_child.byte_range()].to_string());
                                }
                            }
                        }
                        "exposing_list" => {
                            exposing = self.parse_exposing_list(inner_child, source);
                        }
                        _ => {}
                    }
                }

                if let Some(name) = module_name {
                    imports.push(ImportInfo {
                        module_name: name,
                        alias,
                        exposing,
                    });
                }
            }
        }

        imports
    }

    fn extract_exposing(&self, tree: &tree_sitter::Tree, source: &str) -> ExposingInfo {
        let root = tree.root_node();
        let mut cursor = root.walk();

        for child in root.children(&mut cursor) {
            if child.kind() == "module_declaration" {
                let mut inner_cursor = child.walk();
                for inner_child in child.children(&mut inner_cursor) {
                    if inner_child.kind() == "exposing_list" {
                        return self.parse_exposing_list(inner_child, source);
                    }
                }
            }
        }

        ExposingInfo::Explicit(Vec::new())
    }

    fn parse_exposing_list(&self, node: tree_sitter::Node, source: &str) -> ExposingInfo {
        let mut cursor = node.walk();
        let mut exposed = Vec::new();

        for child in node.children(&mut cursor) {
            match child.kind() {
                "double_dot" => return ExposingInfo::All,
                "exposed_value" => {
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        if inner_child.kind() == "lower_case_identifier" {
                            exposed.push(source[inner_child.byte_range()].to_string());
                        }
                    }
                }
                "exposed_type" => {
                    // Capture the full exposed type including (..) if present
                    // e.g., "EventType(..)" should be stored as "EventType(..)"
                    let mut type_name = String::new();
                    let mut has_all_constructors = false;
                    let mut inner_cursor = child.walk();
                    for inner_child in child.children(&mut inner_cursor) {
                        match inner_child.kind() {
                            "upper_case_identifier" => {
                                type_name = source[inner_child.byte_range()].to_string();
                            }
                            "exposed_union_constructors" => {
                                // Check if it's (..) meaning all constructors
                                let text = &source[inner_child.byte_range()];
                                if text.contains("..") {
                                    has_all_constructors = true;
                                }
                            }
                            _ => {}
                        }
                    }
                    if !type_name.is_empty() {
                        if has_all_constructors {
                            exposed.push(format!("{}(..)", type_name));
                        } else {
                            exposed.push(type_name);
                        }
                    }
                }
                _ => {}
            }
        }

        ExposingInfo::Explicit(exposed)
    }

    fn path_to_module_name(&self, path: &Path) -> String {
        // Convert path like src/Pages/Home.elm to Pages.Home
        for source_dir in &self.source_dirs {
            if let Ok(relative) = path.strip_prefix(source_dir) {
                let module_name = relative
                    .with_extension("")
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, ".");
                return module_name;
            }
        }
        path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown".to_string())
    }

    /// Build the reference index by scanning all files for symbol usages
    fn build_reference_index(&mut self) {
        // Collect module info first to avoid borrow issues
        let module_info: Vec<_> = self
            .modules
            .iter()
            .map(|(name, m)| (name.clone(), m.path.clone(), m.imports.clone()))
            .collect();

        for (module_name, path, imports) in module_info {
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let uri = match Url::from_file_path(&path) {
                Ok(u) => u,
                Err(_) => continue,
            };

            if let Some(tree) = self.parser.parse(&content) {
                self.find_references_in_tree(&tree, &content, &uri, &module_name, &imports);
            }
        }
    }

    fn find_references_in_tree(
        &mut self,
        tree: &tree_sitter::Tree,
        source: &str,
        uri: &Url,
        _current_module: &str,
        imports: &[ImportInfo],
    ) {
        let root = tree.root_node();
        self.walk_for_references(root, source, uri, imports);
    }

    fn walk_for_references(
        &mut self,
        node: tree_sitter::Node,
        source: &str,
        uri: &Url,
        imports: &[ImportInfo],
    ) {
        match node.kind() {
            "value_qid" | "upper_case_qid" => {
                let is_in_import = self.is_module_name_in_import(node);

                if !is_in_import {
                    let text = &source[node.byte_range()];
                    let kind = self.classify_reference_kind(node, text);

                    if text.contains('.') {
                        let symbol_name = text.rsplit('.').next().unwrap_or(text);
                        let symbol_start_col = node.end_position().column - symbol_name.len();

                        let range = Range {
                            start: Position::new(
                                node.end_position().row as u32,
                                symbol_start_col as u32,
                            ),
                            end: Position::new(
                                node.end_position().row as u32,
                                node.end_position().column as u32,
                            ),
                        };

                        let resolved_name = self.resolve_reference(text, imports);

                        self.references
                            .entry(resolved_name)
                            .or_default()
                            .push(SymbolReference {
                                uri: uri.clone(),
                                range,
                                is_definition: false,
                                kind,
                                type_context: None,
                            });
                    } else {
                        let range = Range {
                            start: Position::new(
                                node.start_position().row as u32,
                                node.start_position().column as u32,
                            ),
                            end: Position::new(
                                node.end_position().row as u32,
                                node.end_position().column as u32,
                            ),
                        };

                        let resolved_name = self.resolve_reference(text, imports);

                        self.references
                            .entry(resolved_name)
                            .or_default()
                            .push(SymbolReference {
                                uri: uri.clone(),
                                range,
                                is_definition: false,
                                kind,
                                type_context: None,
                            });
                    }
                }
            }
            "lower_case_identifier" | "upper_case_identifier" => {
                let text = &source[node.byte_range()];
                let in_decl = self.is_in_declaration_context(node);

                if !in_decl {
                    let kind = self.classify_reference_kind(node, text);
                    let range = Range {
                        start: Position::new(
                            node.start_position().row as u32,
                            node.start_position().column as u32,
                        ),
                        end: Position::new(
                            node.end_position().row as u32,
                            node.end_position().column as u32,
                        ),
                    };

                    let resolved_name = self.resolve_reference(text, imports);

                    self.references
                        .entry(resolved_name)
                        .or_default()
                        .push(SymbolReference {
                            uri: uri.clone(),
                            range,
                            is_definition: false,
                            kind,
                            type_context: None,
                        });
                }
            }
            _ => {}
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.walk_for_references(child, source, uri, imports);
        }
    }

    fn classify_reference_kind(
        &self,
        node: tree_sitter::Node,
        text: &str,
    ) -> Option<BoundSymbolKind> {
        let is_uppercase = text.chars().next().is_some_and(|c| c.is_uppercase());

        let mut current = node;
        while let Some(parent) = current.parent() {
            match parent.kind() {
                "type_ref" | "type_expression" => {
                    if is_uppercase {
                        return Some(BoundSymbolKind::Type);
                    }
                    return Some(BoundSymbolKind::TypeVariable);
                }
                "value_expr" | "function_call_expr" => {
                    if is_uppercase {
                        return Some(BoundSymbolKind::UnionConstructor);
                    }
                    return Some(BoundSymbolKind::Function);
                }
                "pattern" | "union_pattern" | "case_of_branch" => {
                    if is_uppercase {
                        return Some(BoundSymbolKind::UnionConstructor);
                    }
                    return Some(BoundSymbolKind::CasePattern);
                }
                "field_access_expr" => {
                    if current.kind() == "lower_case_identifier" {
                        if let Some(prev) = current.prev_sibling() {
                            if prev.kind() == "dot" {
                                return Some(BoundSymbolKind::FieldType);
                            }
                        }
                    }
                    return Some(BoundSymbolKind::Function);
                }
                "record_base_identifier" => {
                    return Some(BoundSymbolKind::Function);
                }
                "field_type" => {
                    return Some(BoundSymbolKind::FieldType);
                }
                "field" => {
                    if current == node {
                        return Some(BoundSymbolKind::FieldType);
                    }
                }
                "port_annotation" => {
                    return Some(BoundSymbolKind::Port);
                }
                "exposed_type" => {
                    return Some(BoundSymbolKind::Type);
                }
                "exposed_value" => {
                    return Some(BoundSymbolKind::Function);
                }
                "file" => break,
                _ => {}
            }
            current = parent;
        }

        if is_uppercase {
            Some(BoundSymbolKind::UnionConstructor)
        } else {
            Some(BoundSymbolKind::Function)
        }
    }

    fn is_module_name_in_import(&self, node: tree_sitter::Node) -> bool {
        // Check if this is a module name directly under import_clause, as_clause, or module_declaration
        // But NOT if it's in an exposing_list
        if let Some(parent) = node.parent() {
            if parent.kind() == "import_clause" {
                return true;
            }
            if parent.kind() == "as_clause" {
                return true;
            }
            if parent.kind() == "module_declaration" {
                return true;
            }
        }
        false
    }

    fn is_in_declaration_context(&self, node: tree_sitter::Node) -> bool {
        let mut current = node.parent();
        while let Some(parent) = current {
            match parent.kind() {
                "function_declaration_left"
                | "type_declaration"
                | "type_alias_declaration"
                | "port_annotation" => return true,
                // If inside a qualified identifier AND we're the first child (module prefix), skip
                // But if we're the last child of a qualified identifier, we ARE the symbol reference
                "value_qid" | "upper_case_qid" => {
                    // Check if we're the last child (the actual symbol) or first child (module prefix)
                    if let Some(last) = parent.child(parent.child_count().saturating_sub(1)) {
                        if last.id() == node.id() {
                            // We're the last child (the symbol itself) - NOT a declaration
                            // But we still need to continue checking parents
                            // (e.g., for type_declaration that might be above)
                        } else {
                            // We're an earlier child (module prefix) - skip
                            return true;
                        }
                    }
                }
                // For module declarations and import clauses, skip the module name but allow exposed items
                "module_declaration" | "import_clause" => {
                    // Check if we're in an exposing_list - those ARE valid references
                    let mut check = node.parent();
                    while let Some(p) = check {
                        if p.kind() == "exposing_list"
                            || p.kind() == "exposed_type"
                            || p.kind() == "exposed_value"
                        {
                            return false; // This is an exposed item, not a declaration
                        }
                        if p.kind() == "module_declaration" || p.kind() == "import_clause" {
                            break;
                        }
                        check = p.parent();
                    }
                    return true; // Module name, skip it
                }
                _ => {}
            }
            current = parent.parent();
        }
        false
    }

    fn resolve_reference(&self, name: &str, imports: &[ImportInfo]) -> String {
        // If already qualified (contains .), return as-is
        if name.contains('.') {
            // Check for alias resolution
            let parts: Vec<&str> = name.splitn(2, '.').collect();
            if parts.len() == 2 {
                for import in imports {
                    if let Some(alias) = &import.alias {
                        if alias == parts[0] {
                            return format!("{}.{}", import.module_name, parts[1]);
                        }
                    }
                }
            }
            return name.to_string();
        }

        // Check if it's exposed from an import
        for import in imports {
            match &import.exposing {
                ExposingInfo::All => {
                    // Could be from this module - we'd need to check
                }
                ExposingInfo::Explicit(exposed) => {
                    // Direct exposure check
                    if exposed.contains(&name.to_string()) {
                        return format!("{}.{}", import.module_name, name);
                    }
                    // Check for TypeName(..) patterns - only match if name equals the type name
                    // (the (..) only exposes constructors, which we can't know without the type def)
                    for exp in exposed {
                        if exp.ends_with("(..)") {
                            // Extract the type name from "TypeName(..)"
                            let type_name = &exp[..exp.len() - 4];
                            if name == type_name {
                                return format!("{}.{}", import.module_name, name);
                            }
                        }
                    }
                }
            }
        }

        // Return unqualified name
        name.to_string()
    }

    /// Find all references to a symbol
    pub fn find_references(
        &self,
        symbol_name: &str,
        module_name: Option<&str>,
    ) -> Vec<SymbolReference> {
        let mut results = Vec::new();

        let base_name = Self::extract_base_name(symbol_name);

        // Search by exact match first
        if let Some(refs) = self.references.get(symbol_name) {
            results.extend(refs.clone());
        }

        // Search by unqualified name
        if let Some(refs) = self.references.get(base_name) {
            results.extend(refs.clone());
        }

        // Search all qualified variants
        for (key, refs) in &self.references {
            if key.ends_with(&format!(".{}", base_name)) {
                // If module_name is specified, only include matching modules
                if let Some(mod_name) = module_name {
                    if key.starts_with(mod_name) {
                        results.extend(refs.clone());
                    }
                } else {
                    results.extend(refs.clone());
                }
            }
        }

        Self::deduplicate_references(&mut results);
        results
    }

    /// Find references to a function using the DefinitionSymbol
    /// Filters references by Function kind to avoid matching types/constructors
    pub fn find_function_references_typed(
        &self,
        symbol: &DefinitionSymbol,
    ) -> Vec<SymbolReference> {
        let all_refs = self.find_references(&symbol.name, symbol.module_name.as_deref());
        all_refs
            .into_iter()
            .filter(|r| {
                match r.kind {
                    Some(BoundSymbolKind::Function) => true,
                    Some(BoundSymbolKind::FunctionParameter) => true,
                    Some(BoundSymbolKind::CasePattern) => true,
                    Some(BoundSymbolKind::AnonymousFunctionParameter) => true,
                    None => {
                        // If kind is unknown, include by default (legacy behavior)
                        // but only if it's lowercase (functions are lowercase)
                        symbol
                            .name
                            .chars()
                            .next()
                            .map(|c| c.is_lowercase())
                            .unwrap_or(false)
                    }
                    _ => false,
                }
            })
            .collect()
    }

    /// Find references to a type (custom type or type alias) using the DefinitionSymbol
    /// Filters references by Type/TypeAlias kind to avoid matching constructors/functions
    pub fn find_type_references_typed(&self, symbol: &DefinitionSymbol) -> Vec<SymbolReference> {
        let all_refs = self.find_references(&symbol.name, symbol.module_name.as_deref());
        all_refs
            .into_iter()
            .filter(|r| {
                match r.kind {
                    Some(BoundSymbolKind::Type) => true,
                    Some(BoundSymbolKind::TypeAlias) => true,
                    Some(BoundSymbolKind::TypeVariable) => true,
                    None => {
                        // If kind is unknown, include by default for uppercase identifiers
                        symbol
                            .name
                            .chars()
                            .next()
                            .map(|c| c.is_uppercase())
                            .unwrap_or(false)
                    }
                    _ => false,
                }
            })
            .collect()
    }

    /// Find references to a union constructor using the DefinitionSymbol
    /// Filters references by UnionConstructor kind to avoid matching type definitions
    pub fn find_constructor_references_typed(
        &self,
        symbol: &DefinitionSymbol,
    ) -> Vec<SymbolReference> {
        let all_refs = self.find_references(&symbol.name, symbol.module_name.as_deref());
        all_refs
            .into_iter()
            .filter(|r| matches!(r.kind, Some(BoundSymbolKind::UnionConstructor) | None))
            .collect()
    }

    /// Find references to a record field using the DefinitionSymbol
    /// This uses the existing type-aware field reference finder
    pub fn find_field_references_typed(
        &self,
        symbol: &DefinitionSymbol,
        content: &str,
    ) -> Vec<SymbolReference> {
        // Get the field definition from the type checker
        if let Some(tree) = self.type_checker.get_tree(symbol.uri.as_str()) {
            let point = tree_sitter::Point::new(
                symbol.range.start.line as usize,
                symbol.range.start.character as usize,
            );
            if let Some(node) = Self::find_node_at_point(tree.root_node(), point) {
                if let Some(field_def) =
                    self.type_checker
                        .find_field_definition(symbol.uri.as_str(), node, content)
                {
                    return self.find_field_references(&symbol.name, &field_def);
                }
            }
        }

        // Fallback: use basic filtering by kind and type_context
        let all_refs = self.find_references(&symbol.name, symbol.module_name.as_deref());
        all_refs
            .into_iter()
            .filter(|r| {
                match r.kind {
                    Some(BoundSymbolKind::FieldType) => {
                        // For fields, also check type_context matches
                        match (&r.type_context, &symbol.type_context) {
                            (Some(ref_ctx), Some(sym_ctx)) => ref_ctx == sym_ctx,
                            (None, None) => true,
                            _ => true, // Be permissive if context is unknown
                        }
                    }
                    None => true, // Include unknown references
                    _ => false,
                }
            })
            .collect()
    }

    /// Find references to a port using the DefinitionSymbol
    pub fn find_port_references_typed(&self, symbol: &DefinitionSymbol) -> Vec<SymbolReference> {
        let all_refs = self.find_references(&symbol.name, symbol.module_name.as_deref());
        all_refs
            .into_iter()
            .filter(|r| matches!(r.kind, Some(BoundSymbolKind::Port) | None))
            .collect()
    }

    /// Find references to a local variable (function parameter, case pattern, let binding)
    /// Only searches within the scope of the variable
    pub fn find_local_references(
        &self,
        symbol: &DefinitionSymbol,
        _content: &str,
    ) -> Vec<SymbolReference> {
        let mut references = Vec::new();

        // Add the definition itself
        references.push(SymbolReference {
            uri: symbol.uri.clone(),
            range: symbol.range,
            kind: Some(symbol.kind),
            is_definition: true,
            type_context: None,
        });

        // If there's no scope range, we can't do scoped searching
        let scope_range = match &symbol.scope_range {
            Some(range) => range,
            None => return references,
        };

        // Get the tree and source for the file
        let source = match self.type_checker.get_source(symbol.uri.as_str()) {
            Some(s) => s.to_string(),
            None => return references,
        };
        let tree = match self.type_checker.get_tree(symbol.uri.as_str()) {
            Some(t) => t,
            None => return references,
        };

        // Find all value_expr nodes that match our symbol name within the scope
        let root = tree.root_node();
        self.find_local_usages_in_scope(
            root,
            &symbol.name,
            scope_range,
            &source,
            &symbol.uri,
            &mut references,
        );

        references
    }

    /// Recursively find usages of a local variable within a scope
    fn find_local_usages_in_scope(
        &self,
        node: tree_sitter::Node,
        name: &str,
        scope_range: &Range,
        source: &str,
        uri: &Url,
        references: &mut Vec<SymbolReference>,
    ) {
        // Check if this node is within the scope
        let node_range = self.node_to_lsp_range(node);
        if !self.ranges_overlap(node_range, *scope_range) {
            return;
        }

        // Check if this is a value_expr or value_qid that matches our name
        if node.kind() == "value_expr" || node.kind() == "value_qid" {
            // Get the identifier name
            let text = &source[node.byte_range()];
            // For value_qid, the text might be qualified (e.g., "Module.name"), we want just the last part
            let simple_name = text.rsplit('.').next().unwrap_or(text);

            if simple_name == name {
                // Make sure this is not a qualified reference (which would be a different symbol)
                if !text.contains('.') {
                    references.push(SymbolReference {
                        uri: uri.clone(),
                        range: node_range,
                        kind: None,
                        is_definition: false,
                        type_context: None,
                    });
                }
            }
        }
        // Also check for record_base_identifier (for record updates like { record | field = value })
        else if node.kind() == "record_base_identifier" {
            let text = &source[node.byte_range()];
            if text == name {
                references.push(SymbolReference {
                    uri: uri.clone(),
                    range: node_range,
                    kind: None,
                    is_definition: false,
                    type_context: None,
                });
            }
        }
        // Check lower_case_identifier directly (used in various contexts)
        else if node.kind() == "lower_case_identifier" {
            let text = &source[node.byte_range()];
            if text == name {
                // Check parent to determine context
                if let Some(parent) = node.parent() {
                    // Skip if this is a field access (the field part, not the record part)
                    if parent.kind() == "field_access_expr" {
                        // Only include if this is the target (record), not the field
                        if let Some(target) = parent.child_by_field_name("target") {
                            if target.id() != node.id() {
                                return; // This is the field name, not the record
                            }
                        }
                    }
                    // Skip if this is a field in a record literal or pattern
                    if parent.kind() == "field" || parent.kind() == "field_type" {
                        return;
                    }
                    // Include if it's part of value_expr
                    if parent.kind() == "value_qid" || parent.kind() == "value_expr" {
                        references.push(SymbolReference {
                            uri: uri.clone(),
                            range: node_range,
                            kind: None,
                            is_definition: false,
                            type_context: None,
                        });
                    }
                }
            }
        }

        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.find_local_usages_in_scope(child, name, scope_range, source, uri, references);
        }
    }

    /// Check if two ranges overlap
    fn ranges_overlap(&self, a: Range, b: Range) -> bool {
        // a ends before b starts
        if a.end.line < b.start.line
            || (a.end.line == b.start.line && a.end.character < b.start.character)
        {
            return false;
        }
        // b ends before a starts
        if b.end.line < a.start.line
            || (b.end.line == a.start.line && b.end.character < a.start.character)
        {
            return false;
        }
        true
    }

    /// Find type-aware references at a position
    /// This is the main entry point for type-aware reference finding
    /// It classifies the symbol at the position and dispatches to the appropriate finder
    pub fn find_references_at_position_typed(
        &self,
        uri: &Url,
        position: Position,
        content: &str,
    ) -> Option<Vec<SymbolReference>> {
        let symbol = self.classify_definition_at_position(uri, position)?;

        let refs = match symbol.kind {
            BoundSymbolKind::Function => self.find_function_references_typed(&symbol),
            BoundSymbolKind::FunctionParameter
            | BoundSymbolKind::CasePattern
            | BoundSymbolKind::AnonymousFunctionParameter => {
                // For local bindings, use scoped search
                self.find_local_references(&symbol, content)
            }
            BoundSymbolKind::Type | BoundSymbolKind::TypeAlias => {
                self.find_type_references_typed(&symbol)
            }
            BoundSymbolKind::TypeVariable => {
                // Type variables are local to a type annotation; basic search for now
                self.find_references(&symbol.name, symbol.module_name.as_deref())
            }
            BoundSymbolKind::UnionConstructor => self.find_constructor_references_typed(&symbol),
            BoundSymbolKind::FieldType | BoundSymbolKind::RecordPatternField => {
                self.find_field_references_typed(&symbol, content)
            }
            BoundSymbolKind::Port => self.find_port_references_typed(&symbol),
            BoundSymbolKind::Operator | BoundSymbolKind::Import => {
                // Use basic find_references for operators and imports
                self.find_references(&symbol.name, symbol.module_name.as_deref())
            }
        };

        Some(refs)
    }

    /// Find module-aware references to a symbol
    /// Only returns references from files that actually import the symbol from the defining module
    pub fn find_module_aware_references(
        &self,
        symbol_name: &str,
        defining_module: &str,
        defining_uri: &Url,
    ) -> Vec<SymbolReference> {
        let mut results = Vec::new();

        let base_name = Self::extract_base_name(symbol_name);

        tracing::debug!(
            "find_module_aware_references: symbol={}, defining_module={}, defining_uri={}",
            base_name,
            defining_module,
            defining_uri.as_str()
        );

        // 1. Get refs stored under the qualified key "DefiningModule.symbol"
        let qualified_key = format!("{}.{}", defining_module, base_name);
        if let Some(refs) = self.references.get(&qualified_key) {
            for r in refs {
                tracing::debug!(
                    "  Including qualified ref (key={}): {} {:?}",
                    qualified_key,
                    r.uri.as_str(),
                    r.range
                );
                results.push(r.clone());
            }
        }

        // 2. Get refs stored under the unqualified key "symbol"
        //    Filter: only include if from defining file OR file imports symbol from defining module
        if let Some(refs) = self.references.get(base_name) {
            for r in refs {
                // Always include refs from the defining file
                if &r.uri == defining_uri {
                    tracing::debug!(
                        "  Including unqualified ref from definition file: {:?}",
                        r.range
                    );
                    results.push(r.clone());
                    continue;
                }

                // For other files, check if they expose the symbol from the defining module
                let file_module = self.get_module_at_uri(&r.uri);
                if let Some(module) = file_module {
                    // Skip if this file defines the same-named symbol (different module)
                    if module.module_name != defining_module {
                        // This ref might be from a local definition or different import
                        // Only include if the file imports this symbol from the defining module
                        let symbol_is_exposed = module.imports.iter().any(|imp| {
                            if imp.module_name != defining_module
                                && imp.alias.as_deref() != Some(defining_module)
                            {
                                return false;
                            }
                            match &imp.exposing {
                                ExposingInfo::All => true,
                                ExposingInfo::Explicit(names) => names.iter().any(|n| {
                                    n == base_name
                                        || n.starts_with(&format!("{}(", base_name))
                                        || n == &format!("{}(..)", base_name)
                                }),
                            }
                        });

                        if symbol_is_exposed {
                            tracing::debug!(
                                "  Including exposed unqualified ref from {}: {:?}",
                                r.uri.as_str(),
                                r.range
                            );
                            results.push(r.clone());
                        } else {
                            tracing::debug!(
                                "  Excluding unqualified ref from {} (not exposed from {}): {:?}",
                                r.uri.as_str(),
                                defining_module,
                                r.range
                            );
                        }
                    }
                }
            }
        }

        Self::deduplicate_references(&mut results);
        results
    }

    /// Get module info for a URI
    fn get_module_at_uri(&self, uri: &Url) -> Option<&ElmModule> {
        self.modules
            .values()
            .find(|m| Url::from_file_path(&m.path).ok().as_ref() == Some(uri))
    }

    /// Find definition of a symbol
    pub fn find_definition(&self, symbol_name: &str) -> Option<&GlobalSymbol> {
        // Try exact match first in local symbols
        if let Some(symbols) = self.symbols.get(symbol_name) {
            if let Some(sym) = symbols.first() {
                return Some(sym);
            }
        }

        let base_name = Self::extract_base_name(symbol_name);

        // Try base name in local symbols
        if let Some(symbols) = self.symbols.get(base_name) {
            if let Some(sym) = symbols.first() {
                return Some(sym);
            }
        }

        // Fall back to external packages
        if let Some(symbols) = self.external_symbols.get(symbol_name) {
            if let Some(sym) = symbols.first() {
                return Some(sym);
            }
        }

        // Try base name in external packages
        if let Some(symbols) = self.external_symbols.get(base_name) {
            if let Some(sym) = symbols.first() {
                return Some(sym);
            }
        }

        None
    }

    /// Get all symbols matching a name (searches both qualified and unqualified)
    pub fn get_symbols(&self, name: &str) -> Vec<&GlobalSymbol> {
        let mut results = Vec::new();

        // Direct lookup
        if let Some(symbols) = self.symbols.get(name) {
            results.extend(symbols.iter());
        }

        // If not qualified, also search qualified names
        if !name.contains('.') {
            for (key, symbols) in &self.symbols {
                if key.ends_with(&format!(".{}", name)) {
                    results.extend(symbols.iter());
                }
            }
        }

        results
    }

    /// Get module by name
    pub fn get_module(&self, name: &str) -> Option<&ElmModule> {
        self.modules.get(name)
    }

    /// Get all module names
    pub fn get_module_names(&self) -> Vec<&String> {
        self.modules.keys().collect()
    }

    /// Convert a file path to its module name
    pub fn path_to_module_name_public(&self, path: &Path) -> String {
        self.path_to_module_name(path)
    }

    /// Find a module by its file path
    fn find_module_by_path(&self, path: &Path) -> Option<&ElmModule> {
        self.modules.values().find(|m| m.path == *path)
    }

    /// Get the module name from a URI
    pub fn get_module_name_from_uri(&self, uri: &Url) -> String {
        let path = match uri.to_file_path() {
            Ok(p) => p,
            Err(_) => return String::new(),
        };

        if let Some(module) = self.find_module_by_path(&path) {
            return module.module_name.clone();
        }

        // Fallback: extract from path
        path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string()
    }

    /// Read file content from a URI
    fn read_file_content(&self, uri: &Url) -> Option<String> {
        let path = uri.to_file_path().ok()?;
        std::fs::read_to_string(&path).ok()
    }

    /// Find a node at a specific point in the tree
    fn find_node_at_point(
        node: tree_sitter::Node,
        point: tree_sitter::Point,
    ) -> Option<tree_sitter::Node> {
        if !Self::point_in_range(point, node.start_position(), node.end_position()) {
            return None;
        }

        // Try to find a more specific child node
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = Self::find_node_at_point(child, point) {
                return Some(found);
            }
        }

        // If no child contains the point, return this node
        Some(node)
    }

    fn point_in_range(
        point: tree_sitter::Point,
        start: tree_sitter::Point,
        end: tree_sitter::Point,
    ) -> bool {
        if point.row < start.row || point.row > end.row {
            return false;
        }
        if point.row == start.row && point.column < start.column {
            return false;
        }
        if point.row == end.row && point.column > end.column {
            return false;
        }
        true
    }

    /// Find a node by its ID
    fn find_node_by_id(node: tree_sitter::Node, target_id: usize) -> Option<tree_sitter::Node> {
        if node.id() == target_id {
            return Some(node);
        }

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = Self::find_node_by_id(child, target_id) {
                return Some(found);
            }
        }

        None
    }

    /// Find the enclosing function scope for a node (value_declaration or let_in_expr)
    fn find_enclosing_scope(node: tree_sitter::Node) -> Option<tree_sitter::Node> {
        let mut current = Some(node);
        while let Some(n) = current {
            match n.kind() {
                "value_declaration" | "let_in_expr" => return Some(n),
                _ => current = n.parent(),
            }
        }
        None
    }

    /// Find all variable usages within a scope that match the given name
    /// Returns a list of (range, node_id) for each usage
    fn find_variable_usages_in_scope(
        &self,
        scope_node: tree_sitter::Node,
        source: &str,
        var_name: &str,
        exclude_node: tree_sitter::Node,
    ) -> Vec<(Range, usize)> {
        let mut usages = Vec::new();
        self.walk_for_variable_usages(scope_node, source, var_name, exclude_node.id(), &mut usages);
        usages
    }

    /// Recursively walk the tree to find variable usages
    fn walk_for_variable_usages(
        &self,
        node: tree_sitter::Node,
        source: &str,
        var_name: &str,
        exclude_id: usize,
        usages: &mut Vec<(Range, usize)>,
    ) {
        // Skip the excluded node (the pattern field itself)
        if node.id() == exclude_id {
            return;
        }

        // Check if this is a value_expr that matches our variable name
        if node.kind() == "value_expr" || node.kind() == "lower_case_identifier" {
            if let Ok(text) = node.utf8_text(source.as_bytes()) {
                if text == var_name {
                    // Check that this is a variable usage, not a field name
                    // Field names would have parent of field_type, field_access_expr, field, etc.
                    let parent_kind = node.parent().map(|p| p.kind());
                    let is_field_context = matches!(
                        parent_kind,
                        Some("field_type")
                            | Some("field_access_expr")
                            | Some("field_accessor_function_expr")
                            | Some("record_pattern")
                    );
                    // Also check if this is the field name in a record field (not the value)
                    let is_field_name_in_field = if parent_kind == Some("field") {
                        // In a `field` node, the first child is the field name
                        node.parent()
                            .and_then(|p| p.child(0))
                            .map(|c| c.id() == node.id())
                            .unwrap_or(false)
                    } else {
                        false
                    };

                    // Also check if this is the function being called in a function_call_expr
                    // e.g., `emailInput userConfig ...` where emailInput is a top-level function
                    // In this case, the identifier is NOT a variable usage of the pattern-bound name
                    let is_function_call_target = if let Some(parent) = node.parent() {
                        if parent.kind() == "function_call_expr" {
                            // Check if this node is the first child (the function being called)
                            parent
                                .child(0)
                                .map(|c| c.id() == node.id())
                                .unwrap_or(false)
                        } else if parent.kind() == "value_expr" {
                            // value_expr might wrap the identifier, check grandparent
                            if let Some(grandparent) = parent.parent() {
                                if grandparent.kind() == "function_call_expr" {
                                    grandparent
                                        .child(0)
                                        .map(|c| c.id() == parent.id())
                                        .unwrap_or(false)
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        } else if parent.kind() == "value_qid" {
                            // value_qid wraps the identifier, check grandparent (value_expr) and great-grandparent (function_call_expr)
                            // Structure: function_call_expr → value_expr → value_qid → lower_case_identifier
                            if let Some(grandparent) = parent.parent() {
                                if grandparent.kind() == "value_expr" {
                                    if let Some(great_grandparent) = grandparent.parent() {
                                        if great_grandparent.kind() == "function_call_expr" {
                                            great_grandparent
                                                .child(0)
                                                .map(|c| c.id() == grandparent.id())
                                                .unwrap_or(false)
                                        } else {
                                            false
                                        }
                                    } else {
                                        false
                                    }
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    };

                    if !is_field_context && !is_field_name_in_field && !is_function_call_target {
                        let range = Range {
                            start: Position::new(
                                node.start_position().row as u32,
                                node.start_position().column as u32,
                            ),
                            end: Position::new(
                                node.end_position().row as u32,
                                node.end_position().column as u32,
                            ),
                        };
                        usages.push((range, node.id()));
                    }
                }
            }
        }

        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.walk_for_variable_usages(child, source, var_name, exclude_id, usages);
        }
    }

    /// Check if a scope contains other bindings for the given variable name
    /// (case patterns, function parameters, let bindings, lambda parameters, etc.)
    /// This is used to avoid renaming variable usages that are bound by something OTHER than
    /// the record pattern we're processing.
    fn scope_has_other_bindings(
        scope_node: tree_sitter::Node,
        source: &str,
        var_name: &str,
        exclude_node_id: usize,
    ) -> bool {
        Self::walk_for_other_bindings(scope_node, source, var_name, exclude_node_id)
    }

    /// Recursively check for variable bindings in patterns
    fn walk_for_other_bindings(
        node: tree_sitter::Node,
        source: &str,
        var_name: &str,
        exclude_node_id: usize,
    ) -> bool {
        // Skip the node we're renaming (the record pattern field itself)
        if node.id() == exclude_node_id {
            return false;
        }

        let node_kind = node.kind();

        // Check for bindings in various pattern types
        let is_binding = match node_kind {
            // Case pattern bindings: `Just x -> ...`
            "pattern" | "union_pattern" | "cons_pattern" => {
                // Look for lower_case_identifier children that match
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "lower_case_identifier" && child.id() != exclude_node_id {
                        if let Ok(text) = child.utf8_text(source.as_bytes()) {
                            if text == var_name {
                                return true;
                            }
                        }
                    }
                }
                false
            }
            // Let bindings: `let x = ... in ...`
            "value_declaration" if node.parent().map(|p| p.kind()) == Some("let_in_expr") => {
                // Check the function name
                if let Some(decl) = node.child_by_field_name("functionDeclarationLeft") {
                    if let Some(name_node) = decl.child(0) {
                        if name_node.id() != exclude_node_id {
                            if let Ok(text) = name_node.utf8_text(source.as_bytes()) {
                                if text == var_name {
                                    return true;
                                }
                            }
                        }
                    }
                }
                false
            }
            // Function parameters (excluding the record pattern itself)
            "function_declaration_left" => {
                // Check all patterns in the function declaration
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "lower_pattern" && child.id() != exclude_node_id {
                        if let Ok(text) = child.utf8_text(source.as_bytes()) {
                            if text == var_name {
                                return true;
                            }
                        }
                    }
                }
                false
            }
            // Lambda parameters: `\x -> ...`
            "anonymous_function_expr" => {
                // Check the patterns before the arrow
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if (child.kind() == "pattern" || child.kind() == "lower_pattern")
                        && child.id() != exclude_node_id
                    {
                        if let Ok(text) = child.utf8_text(source.as_bytes()) {
                            if text == var_name {
                                return true;
                            }
                        }
                    }
                }
                false
            }
            // Lower case identifier in a pattern context (catch-all)
            "lower_pattern" | "lower_case_identifier" => {
                // Check if this is in a pattern context (case, lambda, etc.)
                let parent_kind = node.parent().map(|p| p.kind());
                let is_pattern_context = matches!(
                    parent_kind,
                    Some("pattern")
                        | Some("union_pattern")
                        | Some("cons_pattern")
                        | Some("case_of_branch")
                        | Some("anonymous_function_expr")
                );
                if is_pattern_context && node.id() != exclude_node_id {
                    if let Ok(text) = node.utf8_text(source.as_bytes()) {
                        if text == var_name {
                            return true;
                        }
                    }
                }
                false
            }
            _ => false,
        };

        if is_binding {
            return true;
        }

        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if Self::walk_for_other_bindings(child, source, var_name, exclude_node_id) {
                return true;
            }
        }

        false
    }

    /// Classify the definition at a given position
    /// Returns a DefinitionSymbol if the position is on a valid definition
    pub fn classify_definition_at_position(
        &self,
        uri: &Url,
        position: Position,
    ) -> Option<DefinitionSymbol> {
        let tree = self.type_checker.get_tree(uri.as_str())?;
        let source = self.type_checker.get_source(uri.as_str())?;
        let root = tree.root_node();

        let point = tree_sitter::Point::new(position.line as usize, position.character as usize);
        let node = Self::find_node_at_point(root, point)?;

        let module_name = Some(self.get_module_name_from_uri(uri));

        self.classify_definition_node(uri, node, source, module_name)
    }

    fn classify_definition_node(
        &self,
        uri: &Url,
        node: tree_sitter::Node,
        source: &str,
        module_name: Option<String>,
    ) -> Option<DefinitionSymbol> {
        let mut current = node;

        loop {
            match current.kind() {
                // Function parameter: scope is the function body
                "lower_pattern" => {
                    // Check if we're inside a function_declaration_left (function parameter)
                    if let Some(parent) = current.parent() {
                        if parent.kind() == "function_declaration_left" {
                            let name = self.node_text(source, current);
                            let range = self.node_to_lsp_range(current);

                            // Find the function body (= expr after function_declaration_left)
                            // The structure is: value_declaration -> function_declaration_left -> ... -> expr
                            if let Some(value_decl) = parent.parent() {
                                // Find the expression (function body) which is the last named child
                                let mut scope_range = None;
                                let mut cursor = value_decl.walk();
                                for child in value_decl.children(&mut cursor) {
                                    // Skip function_declaration_left and "="
                                    if child.kind() != "function_declaration_left"
                                        && child.kind() != "="
                                    {
                                        scope_range = Some(self.node_to_lsp_range(child));
                                        break;
                                    }
                                }

                                return Some(DefinitionSymbol {
                                    name,
                                    kind: BoundSymbolKind::FunctionParameter,
                                    uri: uri.clone(),
                                    range,
                                    type_context: None,
                                    module_name,
                                    scope_range,
                                });
                            }
                        }
                        // Check if we're in a case pattern
                        else if parent.kind() == "pattern" {
                            if let Some(case_branch) =
                                self.find_ancestor_of_kind(parent, "case_of_branch")
                            {
                                let name = self.node_text(source, current);
                                let range = self.node_to_lsp_range(current);

                                // The scope is the case branch body (after the ->)
                                let scope_range = case_branch
                                    .child_by_field_name("expr")
                                    .or_else(|| {
                                        case_branch.named_children(&mut case_branch.walk()).last()
                                    })
                                    .map(|body| self.node_to_lsp_range(body));

                                return Some(DefinitionSymbol {
                                    name,
                                    kind: BoundSymbolKind::CasePattern,
                                    uri: uri.clone(),
                                    range,
                                    type_context: None,
                                    module_name,
                                    scope_range,
                                });
                            }
                        }
                        // Check if we're in an anonymous function parameter
                        else if parent.kind() == "anonymous_function_expr" {
                            let name = self.node_text(source, current);
                            let range = self.node_to_lsp_range(current);

                            // The scope is the entire anonymous function body
                            let scope_range = Some(self.node_to_lsp_range(parent));

                            return Some(DefinitionSymbol {
                                name,
                                kind: BoundSymbolKind::AnonymousFunctionParameter,
                                uri: uri.clone(),
                                range,
                                type_context: None,
                                module_name,
                                scope_range,
                            });
                        }
                        // Check if we're in a let binding
                        else if parent.kind() == "value_declaration" {
                            // Check if this is inside a let_in_expr
                            if let Some(let_in) = self.find_ancestor_of_kind(parent, "let_in_expr")
                            {
                                let name = self.node_text(source, current);
                                let range = self.node_to_lsp_range(current);

                                // The scope is the entire let_in_expr (both bindings and body)
                                let scope_range = Some(self.node_to_lsp_range(let_in));

                                return Some(DefinitionSymbol {
                                    name,
                                    kind: BoundSymbolKind::FunctionParameter, // Use FunctionParameter for let bindings too
                                    uri: uri.clone(),
                                    range,
                                    type_context: None,
                                    module_name,
                                    scope_range,
                                });
                            }
                        }
                    }
                }

                "function_declaration_left" => {
                    let name_node = self.get_child_by_kind(current, "lower_case_identifier")?;
                    let name = self.node_text(source, name_node);
                    let range = self.node_to_lsp_range(name_node);
                    return Some(DefinitionSymbol {
                        name,
                        kind: BoundSymbolKind::Function,
                        uri: uri.clone(),
                        range,
                        type_context: None,
                        module_name,
                        scope_range: None,
                    });
                }

                "type_alias_declaration" => {
                    let name_node = self.get_child_by_kind(current, "upper_case_identifier")?;
                    let name = self.node_text(source, name_node);
                    let range = self.node_to_lsp_range(name_node);
                    return Some(DefinitionSymbol {
                        name,
                        kind: BoundSymbolKind::TypeAlias,
                        uri: uri.clone(),
                        range,
                        type_context: None,
                        module_name,
                        scope_range: None,
                    });
                }

                "type_declaration" => {
                    let type_name_node =
                        self.get_child_by_kind(current, "upper_case_identifier")?;
                    let type_name = self.node_text(source, type_name_node);

                    let type_name_range = self.node_to_lsp_range(type_name_node);
                    if self.position_in_range(
                        Position::new(
                            node.start_position().row as u32,
                            node.start_position().column as u32,
                        ),
                        type_name_range,
                    ) {
                        return Some(DefinitionSymbol {
                            name: type_name,
                            kind: BoundSymbolKind::Type,
                            uri: uri.clone(),
                            range: type_name_range,
                            type_context: None,
                            module_name,
                            scope_range: None,
                        });
                    }

                    let mut cursor = current.walk();
                    for child in current.children(&mut cursor) {
                        if child.kind() == "union_variant" {
                            let variant_name_node =
                                self.get_child_by_kind(child, "upper_case_identifier")?;
                            let variant_range = self.node_to_lsp_range(variant_name_node);
                            if self.position_in_range(
                                Position::new(
                                    node.start_position().row as u32,
                                    node.start_position().column as u32,
                                ),
                                variant_range,
                            ) {
                                let variant_name = self.node_text(source, variant_name_node);
                                return Some(DefinitionSymbol {
                                    name: variant_name,
                                    kind: BoundSymbolKind::UnionConstructor,
                                    uri: uri.clone(),
                                    range: variant_range,
                                    type_context: Some(type_name),
                                    module_name,
                                    scope_range: None,
                                });
                            }
                        }
                    }
                    return None;
                }

                "field_type" => {
                    let field_name_node =
                        self.get_child_by_kind(current, "lower_case_identifier")?;
                    let field_name = self.node_text(source, field_name_node);
                    let range = self.node_to_lsp_range(field_name_node);

                    let type_alias_name = self.find_ancestor_type_alias_name(current, source);

                    return Some(DefinitionSymbol {
                        name: field_name,
                        kind: BoundSymbolKind::FieldType,
                        uri: uri.clone(),
                        range,
                        type_context: type_alias_name,
                        module_name,
                        scope_range: None,
                    });
                }

                "port_annotation" => {
                    let name_node = self.get_child_by_kind(current, "lower_case_identifier")?;
                    let name = self.node_text(source, name_node);
                    let range = self.node_to_lsp_range(name_node);
                    return Some(DefinitionSymbol {
                        name,
                        kind: BoundSymbolKind::Port,
                        uri: uri.clone(),
                        range,
                        type_context: None,
                        module_name,
                        scope_range: None,
                    });
                }

                "union_variant" => {
                    let variant_name_node =
                        self.get_child_by_kind(current, "upper_case_identifier")?;
                    let variant_name = self.node_text(source, variant_name_node);
                    let range = self.node_to_lsp_range(variant_name_node);

                    if let Some(type_decl) = current.parent() {
                        if type_decl.kind() == "type_declaration" {
                            if let Some(type_name_node) =
                                self.get_child_by_kind(type_decl, "upper_case_identifier")
                            {
                                let type_name = self.node_text(source, type_name_node);
                                return Some(DefinitionSymbol {
                                    name: variant_name,
                                    kind: BoundSymbolKind::UnionConstructor,
                                    uri: uri.clone(),
                                    range,
                                    type_context: Some(type_name),
                                    module_name,
                                    scope_range: None,
                                });
                            }
                        }
                    }
                    return None;
                }

                "file" => return None,

                _ => {}
            }

            current = current.parent()?;
        }
    }

    fn find_ancestor_of_kind<'a>(
        &self,
        node: tree_sitter::Node<'a>,
        kind: &str,
    ) -> Option<tree_sitter::Node<'a>> {
        let mut current = node.parent();
        while let Some(parent) = current {
            if parent.kind() == kind {
                return Some(parent);
            }
            current = parent.parent();
        }
        None
    }

    fn get_child_by_kind<'a>(
        &self,
        node: tree_sitter::Node<'a>,
        kind: &str,
    ) -> Option<tree_sitter::Node<'a>> {
        let mut cursor = node.walk();
        let result = node
            .children(&mut cursor)
            .find(|child| child.kind() == kind);
        result
    }

    fn node_to_lsp_range(&self, node: tree_sitter::Node) -> Range {
        Range {
            start: Position::new(
                node.start_position().row as u32,
                node.start_position().column as u32,
            ),
            end: Position::new(
                node.end_position().row as u32,
                node.end_position().column as u32,
            ),
        }
    }

    fn position_in_range(&self, pos: Position, range: Range) -> bool {
        if pos.line < range.start.line || pos.line > range.end.line {
            return false;
        }
        if pos.line == range.start.line && pos.character < range.start.character {
            return false;
        }
        if pos.line == range.end.line && pos.character > range.end.character {
            return false;
        }
        true
    }

    fn find_ancestor_type_alias_name(
        &self,
        node: tree_sitter::Node,
        source: &str,
    ) -> Option<String> {
        let mut current = node.parent();
        while let Some(parent) = current {
            if parent.kind() == "type_alias_declaration" {
                if let Some(name_node) = self.get_child_by_kind(parent, "upper_case_identifier") {
                    return Some(self.node_text(source, name_node));
                }
            }
            current = parent.parent();
        }
        None
    }

    fn node_text(&self, source: &str, node: tree_sitter::Node) -> String {
        source[node.byte_range()].to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn create_test_workspace() -> (TempDir, Workspace) {
        let temp_dir = TempDir::new().unwrap();
        let src_dir = temp_dir.path().join("src");
        fs::create_dir_all(&src_dir).unwrap();

        // Create elm.json
        let elm_json = r#"{ "source-directories": ["src"] }"#;
        fs::write(temp_dir.path().join("elm.json"), elm_json).unwrap();

        let mut workspace = Workspace::new(temp_dir.path().to_path_buf());
        workspace.initialize().unwrap();

        (temp_dir, workspace)
    }

    /// Write a source file and date it far enough back for its stamp to count.
    fn write_settled(path: &Path, content: &str) {
        fs::write(path, content).unwrap();
        let a_minute_ago = SystemTime::now() - Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(a_minute_ago)
            .unwrap();
    }

    #[test]
    fn test_disk_changes_are_new_modified_and_deleted_files() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let a = temp_dir.path().join("src").join("A.elm");
        let b = temp_dir.path().join("src").join("B.elm");

        write_settled(&a, "module A exposing (..)\n");
        write_settled(&b, "module B exposing (..)\n");
        assert_eq!(
            workspace.take_disk_changes(),
            DiskChanges {
                changed: vec![a.clone(), b.clone()],
                deleted: vec![]
            }
        );
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());

        // Same length, later modification time
        write_settled(&a, "module A exposing (a)\n\n");
        write_settled(&a, "module A exposing (..)\n");
        fs::remove_file(&b).unwrap();
        assert_eq!(
            workspace.take_disk_changes(),
            DiskChanges {
                changed: vec![a],
                deleted: vec![b]
            }
        );
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());
    }

    #[test]
    fn test_an_indexed_file_outside_the_source_directories_is_compared_too() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let a_test = temp_dir.path().join("tests").join("ATest.elm");
        let uri = Url::from_file_path(&a_test).unwrap();
        fs::create_dir(a_test.parent().unwrap()).unwrap();
        write_settled(&a_test, "module ATest exposing (..)\n");
        // The walk does not reach it
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());

        // A document was opened for it, with a text that the file may not hold any more
        workspace.update_file(&uri, "module ATest exposing (..)\n");
        let only_the_test = || DiskChanges {
            changed: vec![a_test.clone()],
            deleted: vec![],
        };
        assert_eq!(workspace.take_disk_changes(), only_the_test());
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());

        write_settled(&a_test, "module ATest exposing (a)\n");
        assert_eq!(workspace.take_disk_changes(), only_the_test());

        fs::remove_file(&a_test).unwrap();
        assert_eq!(
            workspace.take_disk_changes(),
            DiskChanges {
                changed: vec![],
                deleted: vec![a_test.clone()]
            }
        );
        workspace.remove_file(&uri);
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());
    }

    /// Take every permission from a directory, or return false where that
    /// holds nobody back, as for root. The caller gives them back with `open`.
    #[cfg(unix)]
    fn close(dir: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_dir(dir).is_ok() {
            open(dir);
            return false;
        }
        true
    }

    #[cfg(unix)]
    fn open(dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn test_an_indexed_file_that_cannot_be_looked_at_is_not_taken_for_deleted() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let tests_dir = temp_dir.path().join("tests");
        let a_test = tests_dir.join("ATest.elm");
        fs::create_dir(&tests_dir).unwrap();
        write_settled(&a_test, "module ATest exposing (..)\n");
        workspace.update_file(
            &Url::from_file_path(&a_test).unwrap(),
            "module ATest exposing (..)\n",
        );
        assert_eq!(workspace.take_disk_changes().changed, vec![a_test.clone()]);
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());

        if !close(&tests_dir) {
            return;
        }
        let hidden = workspace.take_disk_changes();
        let again = workspace.take_disk_changes();
        open(&tests_dir);
        // Reported for reading, which fails and tells the caller why. Never as deleted.
        let to_read = DiskChanges {
            changed: vec![a_test.clone()],
            deleted: vec![],
        };
        assert_eq!(hidden, to_read);
        assert_eq!(again, to_read);
        assert!(workspace.modules.contains_key("ATest"));

        // Within reach again, it is read once more
        assert_eq!(workspace.take_disk_changes(), to_read);
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());
    }

    #[cfg(unix)]
    #[test]
    fn test_a_link_whose_file_cannot_be_looked_at_is_missing_from_the_index() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let vault = temp_dir.path().join("vault");
        let link = temp_dir.path().join("src").join("Linked.elm");
        fs::create_dir(&vault).unwrap();
        write_settled(&vault.join("Linked.elm"), "module Linked exposing (..)\n");
        std::os::unix::fs::symlink(vault.join("Linked.elm"), &link).unwrap();
        // A link to nothing, by contrast, is no file at all
        std::os::unix::fs::symlink(
            "../generated/Later.elm",
            temp_dir.path().join("src").join("Later.elm"),
        )
        .unwrap();

        if !close(&vault) {
            return;
        }
        workspace.initialize().unwrap();
        let problem = workspace.unreadable_files();
        let changes = workspace.take_disk_changes();
        let still = workspace.unreadable_files();
        open(&vault);
        let told = Some(format!(
            "Cannot read {}: Permission denied (os error 13).",
            link.display()
        ));
        assert_eq!(problem, told);
        assert_eq!(changes, DiskChanges::default());
        assert_eq!(still, told);

        assert_eq!(workspace.take_disk_changes().changed, vec![link]);
        assert_eq!(workspace.unreadable_files(), None);
    }

    const GREETING: &str = "module Greeting exposing (hello)\n\n\nhello =\n    1\n";

    // The files that define `hello`, as far as the index knows
    fn hello_is_defined_in(workspace: &Workspace) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = workspace.symbols["hello"]
            .iter()
            .filter_map(|symbol| symbol.definition_uri.to_file_path().ok())
            .collect();
        files.sort();
        files
    }

    #[test]
    fn test_a_module_stays_with_the_file_that_spells_its_name() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let src = temp_dir.path().join("src");
        let original = src.join("Greeting.elm");
        // Copies that still declare the module they were made from. One comes before the
        // original in any order of names and one after it, whatever order the walk has.
        let copies = [src.join("Aaa.elm"), src.join("Zzz.elm")];
        for path in [&original, &copies[0], &copies[1]] {
            write_settled(path, GREETING);
        }
        let uri = |path: &PathBuf| Url::from_file_path(path).unwrap();
        let holder =
            |workspace: &Workspace| workspace.modules.get("Greeting").map(|m| m.path.clone());

        workspace.initialize().unwrap();
        assert_eq!(holder(&workspace), Some(original.clone()));
        assert_eq!(hello_is_defined_in(&workspace), vec![original.clone()]);

        // Read again later, as after an edit, a copy does not take the name either
        workspace.update_file(&uri(&copies[0]), GREETING);
        assert_eq!(holder(&workspace), Some(original.clone()));
        assert_eq!(hello_is_defined_in(&workspace), vec![original.clone()]);

        // With a name of its own it is a module like any other
        let renamed = GREETING.replace("module Greeting", "module Zzz");
        workspace.update_file(&uri(&copies[1]), &renamed);
        assert_eq!(workspace.modules["Zzz"].path, copies[1]);
        assert_eq!(
            hello_is_defined_in(&workspace),
            vec![original.clone(), copies[1].clone()]
        );

        // With the original gone, the copy that waits is the one file that declares the module
        fs::remove_file(&original).unwrap();
        workspace.remove_file(&uri(&original));
        assert_eq!(holder(&workspace), Some(copies[0].clone()));
        assert_eq!(hello_is_defined_in(&workspace), copies.to_vec());
        assert!(workspace.displaced.is_empty());

        // The original comes back and takes its name from the copy, which waits again
        write_settled(&original, GREETING);
        workspace.update_file(&uri(&original), GREETING);
        assert_eq!(holder(&workspace), Some(original.clone()));
        assert_eq!(
            hello_is_defined_in(&workspace),
            vec![original, copies[1].clone()]
        );
        assert_eq!(
            workspace.displaced.keys().collect::<Vec<_>>(),
            vec![&copies[0]]
        );
    }

    #[test]
    fn test_a_module_is_at_home_below_any_source_directory_that_spells_its_name() {
        // "src" and "src/Sub" are both source directories. The file in
        // src/Sub can be Utils for the one and Sub.Utils for the other.
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().to_path_buf();
        let sub = root.join("src").join("Sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(
            root.join("elm.json"),
            r#"{ "source-directories": ["src", "src/Sub"] }"#,
        )
        .unwrap();
        let (outer, inner) = (sub.join("Utils.elm"), sub.join("Inner.elm"));
        write_settled(&outer, "module Sub.Utils exposing (..)\n");
        write_settled(&inner, "module Inner exposing (..)\n");
        let mut workspace = Workspace::new(root.clone());
        workspace.initialize().unwrap();

        // A copy of each, made later, waits behind the file that lies where the name says
        for (original, name) in [(&outer, "Sub.Utils"), (&inner, "Inner")] {
            let copy = root
                .join("src")
                .join(format!("Zz{}.elm", name.replace('.', "")));
            let text = fs::read_to_string(original).unwrap();
            write_settled(&copy, &text);
            workspace.update_file(&Url::from_file_path(&copy).unwrap(), &text);
            assert_eq!(
                workspace.waits_behind(&copy),
                Some((name, original.as_path()))
            );
        }
        // A move into the inner directory is still named by that directory
        assert_eq!(
            workspace
                .module_name_at(&sub.join("New.elm"))
                .map_err(|e| e.to_string()),
            Ok("New".to_string())
        );
        // A rename leaves a file in its directory, and its name the parts it had
        for (file, renamed) in [(&outer, "Sub.Renamed"), (&inner, "Renamed")] {
            let uri = Url::from_file_path(file).unwrap();
            assert_eq!(
                workspace
                    .rename_file(&uri, "Renamed.elm")
                    .unwrap()
                    .new_module_name,
                renamed
            );
        }
    }

    #[test]
    fn test_a_copy_waits_whether_it_is_read_before_the_module_or_after() {
        for copy_first in [true, false] {
            let (temp_dir, mut workspace) = create_test_workspace();
            let src = temp_dir.path().join("src");
            let [original, copy] = [src.join("Greeting.elm"), src.join("Backup.elm")];
            write_settled(&original, GREETING);
            write_settled(&copy, GREETING);

            // As at the start, where the order of the walk is the file system's
            let order = if copy_first {
                [&copy, &original]
            } else {
                [&original, &copy]
            };
            for path in order {
                workspace.index_file(path).unwrap();
            }
            assert_eq!(workspace.modules["Greeting"].path, original);
            assert_eq!(hello_is_defined_in(&workspace), vec![original.clone()]);
            assert_eq!(workspace.displaced.keys().collect::<Vec<_>>(), vec![&copy]);
        }
    }

    #[test]
    fn test_a_file_that_waits_for_a_module_name_is_a_file_of_the_index() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let original = temp_dir.path().join("src").join("Greeting.elm");
        // Outside the source directories, where a file enters the index with a document opened for it
        let waiting = temp_dir.path().join("tests").join("Greeting.elm");
        fs::create_dir(waiting.parent().unwrap()).unwrap();
        write_settled(&original, GREETING);
        write_settled(&waiting, GREETING);
        workspace.initialize().unwrap();
        workspace.update_file(&Url::from_file_path(&waiting).unwrap(), GREETING);
        assert_eq!(workspace.modules["Greeting"].path, original);

        // An index that is built anew asks for it again
        assert_eq!(workspace.files_beyond_the_walk(), vec![waiting.clone()]);
        // The comparison with the disk reads it once for its first stamp, and again after an edit
        assert_eq!(workspace.take_disk_changes().changed, vec![waiting.clone()]);
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());
        write_settled(&waiting, &GREETING.replace('1', "22"));
        assert_eq!(workspace.take_disk_changes().changed, vec![waiting.clone()]);
        // And it notices when the file is gone
        fs::remove_file(&waiting).unwrap();
        assert_eq!(workspace.take_disk_changes().deleted, vec![waiting]);
    }

    #[test]
    fn test_a_module_name_goes_to_a_waiting_file_that_can_still_be_read() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let src = temp_dir.path().join("src");
        let original = src.join("Greeting.elm");
        // The waiting files are tried from the last name to the first
        let [sound, gone, no_text] = [
            src.join("Aaa.elm"),
            src.join("Bbb.elm"),
            src.join("Ccc.elm"),
        ];
        for path in [&original, &sound, &gone, &no_text] {
            write_settled(path, GREETING);
        }
        workspace.initialize().unwrap();
        assert_eq!(workspace.displaced.len(), 3);

        // One copy was deleted since and one is no text any more, and the index was told of neither
        fs::remove_file(&gone).unwrap();
        fs::write(&no_text, [0xff, 0xfe]).unwrap();
        fs::remove_file(&original).unwrap();
        workspace.remove_file(&Url::from_file_path(&original).unwrap());

        assert_eq!(workspace.modules["Greeting"].path, sound);
        assert_eq!(hello_is_defined_in(&workspace), vec![sound]);
        assert!(workspace.displaced.is_empty());
        let problem = workspace.unreadable_files().unwrap_or_default();
        assert!(problem.contains("Ccc.elm"), "{}", problem);
    }

    #[test]
    fn test_a_free_module_name_goes_first_to_a_file_that_spells_it() {
        let temp_dir = TempDir::new().unwrap();
        let [src, lib] = [temp_dir.path().join("src"), temp_dir.path().join("lib")];
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&lib).unwrap();
        fs::write(
            temp_dir.path().join("elm.json"),
            r#"{ "source-directories": ["src", "lib"] }"#,
        )
        .unwrap();
        // Two copies wait from the start, one before the module in the order of names and one after
        let original = src.join("Greeting.elm");
        for path in [&original, &src.join("Aaa.elm"), &src.join("Zzz.elm")] {
            write_settled(path, GREETING);
        }
        let mut workspace = Workspace::new(temp_dir.path().to_path_buf());
        workspace.initialize().unwrap();

        // A second source directory gets a file at the very place the name spells. Of two such
        // files the one that was read last holds the name, and the other waits with the copies.
        let twin = lib.join("Greeting.elm");
        write_settled(&twin, GREETING);
        workspace.update_file(&Url::from_file_path(&twin).unwrap(), GREETING);
        assert_eq!(workspace.modules["Greeting"].path, twin);
        assert_eq!(workspace.displaced.len(), 3);

        fs::remove_file(&twin).unwrap();
        workspace.remove_file(&Url::from_file_path(&twin).unwrap());
        assert_eq!(workspace.modules["Greeting"].path, original);
        assert_eq!(hello_is_defined_in(&workspace), vec![original]);
        assert_eq!(workspace.displaced.len(), 2);
    }

    #[test]
    fn test_a_file_beyond_the_source_directories_survives_a_new_index() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let a_test = temp_dir.path().join("tests").join("ATest.elm");
        let gone = temp_dir.path().join("tests").join("Gone.elm");
        fs::create_dir(a_test.parent().unwrap()).unwrap();
        write_settled(
            &temp_dir.path().join("src").join("A.elm"),
            "module A exposing (..)\n",
        );
        for path in [&a_test, &gone] {
            write_settled(path, "module X exposing (..)\n");
        }
        workspace.initialize().unwrap();
        workspace.update_file(
            &Url::from_file_path(&a_test).unwrap(),
            "module ATest exposing (..)\n",
        );
        workspace.update_file(
            &Url::from_file_path(&gone).unwrap(),
            "module Gone exposing (..)\n",
        );
        let beyond = workspace.files_beyond_the_walk();
        assert_eq!(beyond, vec![a_test.clone(), gone.clone()]);

        // elm.json reads differently, so the index is built anew
        fs::remove_file(&gone).unwrap();
        write_settled(&a_test, "module ATest exposing (a)\n");
        let mut fresh = Workspace::new(temp_dir.path().to_path_buf());
        fresh.initialize().unwrap();
        assert!(!fresh.modules.contains_key("ATest"));
        fresh.adopt(&beyond);
        // Read from the file as it is now, not taken over from the old index
        let exposing = fresh
            .modules
            .get("ATest")
            .map(|module| module.exposing.clone());
        assert!(matches!(exposing, Some(ExposingInfo::Explicit(names)) if names == ["a"]));
        assert!(!fresh.modules.contains_key("Gone"));
        assert_eq!(fresh.files_beyond_the_walk(), vec![a_test.clone()]);

        // No text while the next index is built. The one after that still has to ask for it.
        fs::write(&a_test, [0xff, 0xfe]).unwrap();
        let mut unread = Workspace::new(temp_dir.path().to_path_buf());
        unread.initialize().unwrap();
        unread.adopt(&fresh.files_beyond_the_walk());
        assert!(!unread.modules.contains_key("ATest"));
        assert!(unread.unreadable_files().is_some());
        assert_eq!(unread.files_beyond_the_walk(), vec![a_test]);
    }

    #[test]
    fn test_a_source_directory_outside_the_project_has_one_spelling() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().join("app");
        let shared = temp_dir.path().join("shared").join("Shared.elm");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir(shared.parent().unwrap()).unwrap();
        fs::write(
            root.join("elm.json"),
            r#"{ "source-directories": ["./src", "../shared", "src/../lib/"] }"#,
        )
        .unwrap();
        write_settled(&shared, "module Shared exposing (..)\n");
        let mut workspace = Workspace::new(root.clone());
        workspace.initialize().unwrap();

        assert_eq!(
            workspace.source_dirs,
            vec![
                root.join("src"),
                temp_dir.path().join("shared"),
                root.join("lib")
            ]
        );
        // The path a client names the file by, with no ".." in it
        assert_eq!(
            workspace
                .modules
                .get("Shared")
                .map(|module| module.path.clone()),
            Some(shared.clone())
        );
        workspace.update_file(
            &Url::from_file_path(&shared).unwrap(),
            "module Shared exposing (..)\n",
        );
        assert_eq!(workspace.files_beyond_the_walk(), Vec::<PathBuf>::new());
    }

    #[test]
    fn test_a_source_directory_is_spelled_as_the_disk_spells_it() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().join("app");
        let shared = temp_dir.path().join("shared");
        fs::create_dir_all(root.join("src").join("Page")).unwrap();
        fs::create_dir(&shared).unwrap();
        let home = root.join("src").join("Page").join("Home.elm");
        write_settled(&home, "module Page.Home exposing (..)\n");
        fs::write(
            root.join("elm.json"),
            r#"{ "source-directories": ["SRC", "../Shared", "Lib"] }"#,
        )
        .unwrap();
        let mut workspace = Workspace::new(root.clone());
        workspace.initialize().unwrap();

        if !root.join("SRC").exists() {
            // This file system tells SRC from src, so elm.json names directories that are not there
            assert_eq!(
                workspace.source_dirs,
                vec![
                    root.join("SRC"),
                    temp_dir.path().join("Shared"),
                    root.join("Lib")
                ]
            );
            return;
        }
        // One spelling, the disk's. What is not on the disk stays as elm.json has it.
        assert_eq!(
            workspace.source_dirs,
            vec![root.join("src"), shared, root.join("Lib")]
        );
        assert_eq!(
            workspace
                .modules
                .get("Page.Home")
                .map(|module| module.path.clone()),
            Some(home.clone())
        );
        assert_eq!(
            workspace.module_name_at(&home).map_err(|e| e.to_string()),
            Ok("Page.Home".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_a_source_directory_beside_a_linked_root_is_where_the_file_system_finds_it() {
        // home/app is a link to data/app, and elm.json lists "../shared". The
        // compiler reads data/shared. home/shared is another directory.
        let temp_dir = TempDir::new().unwrap();
        let temp = temp_dir.path().canonicalize().unwrap();
        let (home, data) = (temp.join("home"), temp.join("data"));
        fs::create_dir_all(data.join("app").join("src")).unwrap();
        fs::create_dir_all(data.join("shared")).unwrap();
        fs::create_dir_all(home.join("shared")).unwrap();
        fs::write(
            data.join("app").join("elm.json"),
            r#"{ "source-directories": ["src", "../shared", "src/../../shared/deep"] }"#,
        )
        .unwrap();
        write_settled(
            &data.join("shared").join("Shared.elm"),
            "module Shared exposing (..)\n",
        );
        write_settled(
            &home.join("shared").join("Other.elm"),
            "module Other exposing (..)\n",
        );
        std::os::unix::fs::symlink(data.join("app"), home.join("app")).unwrap();
        let root = home.join("app");
        let mut workspace = Workspace::new(root.clone());
        workspace.initialize().unwrap();

        // What lies below the root keeps the root's spelling, link and all.
        // ".." leaves the link for the place it leads to.
        assert_eq!(
            workspace.source_dirs,
            vec![
                root.join("src"),
                data.join("shared"),
                data.join("shared").join("deep")
            ]
        );
        assert_eq!(
            workspace
                .modules
                .get("Shared")
                .map(|module| module.path.clone()),
            Some(data.join("shared").join("Shared.elm"))
        );
        assert!(!workspace.modules.contains_key("Other"));
    }

    #[test]
    fn test_a_source_directory_made_later_is_spelled_as_the_disk_spells_it() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path().to_path_buf();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(
            root.join("elm.json"),
            r#"{ "source-directories": ["src", "GEN"] }"#,
        )
        .unwrap();
        let mut workspace = Workspace::new(root.clone());
        workspace.initialize().unwrap();
        // Nothing is there yet to say how the name is spelled
        assert_eq!(
            workspace.source_dirs,
            vec![root.join("src"), root.join("GEN")]
        );

        // A build writes its generated code into "gen"
        fs::create_dir(root.join("gen")).unwrap();
        let api = root.join("gen").join("Api.elm");
        write_settled(&api, "module Api exposing (..)\n");
        if !root.join("GEN").exists() {
            // This file system tells GEN from gen, and elm.json still names a directory that is not there
            return;
        }
        assert_eq!(workspace.take_disk_changes().changed, vec![api.clone()]);
        assert_eq!(
            workspace.source_dirs,
            vec![root.join("src"), root.join("gen")]
        );
        assert_eq!(
            workspace.module_name_at(&api).map_err(|e| e.to_string()),
            Ok("Api".to_string())
        );
    }

    #[test]
    fn test_a_source_directory_is_found_in_the_form_the_disk_keeps_its_accent_in() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        // The disk keeps the accent as a letter and a mark, and elm.json writes it as one letter
        let on_disk = root.join("co\u{301}digo");
        fs::create_dir(&on_disk).unwrap();
        write_settled(&on_disk.join("A.elm"), "module A exposing (..)\n");
        fs::write(
            root.join("elm.json"),
            "{ \"source-directories\": [\"c\u{f3}digo\"] }",
        )
        .unwrap();
        if !root.join("c\u{f3}digo").exists() {
            // This file system tells the two forms apart, and elm.json names a directory that is not there
            return;
        }
        let mut workspace = Workspace::new(root.to_path_buf());
        workspace.initialize().unwrap();

        assert_eq!(workspace.source_dirs, vec![on_disk.clone()]);
        assert_eq!(
            workspace.modules.get("A").map(|module| module.path.clone()),
            Some(on_disk.join("A.elm"))
        );
    }

    #[test]
    fn test_a_file_is_no_copy_of_itself_under_another_spelling() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let src = temp_dir.path().join("src");
        fs::create_dir(src.join("Api")).unwrap();
        let on_disk = src.join("Api").join("Utils.elm");
        let as_called = src.join("API").join("Utils.elm");
        let text = "module API.Utils exposing (..)\n";
        write_settled(&on_disk, text);
        if !as_called.exists() {
            // This file system tells API from Api: two paths are two files
            return;
        }
        // A client called the file by a spelling the disk does not have, and
        // there the path spells the module's name
        workspace.update_file(&Url::from_file_path(&as_called).unwrap(), text);
        assert_eq!(
            workspace
                .modules
                .get("API.Utils")
                .map(|module| module.path.clone()),
            Some(as_called.clone())
        );

        // Called as the disk spells it, it is the same file, and no copy of it
        // that waits for the module's name
        workspace.update_file(&Url::from_file_path(&on_disk).unwrap(), text);
        assert_eq!(workspace.waits_behind(&on_disk), None);
        assert_eq!(
            workspace
                .modules
                .get("API.Utils")
                .map(|module| module.path.clone()),
            Some(on_disk.clone())
        );
        // And the other spelling is no file that waits behind this one
        assert!(workspace.displaced.is_empty());
    }

    #[test]
    fn test_a_module_is_named_by_its_path_below_its_source_directory() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();
        fs::write(
            root.join("elm.json"),
            r#"{ "source-directories": ["src", "lib", "src/Generated"] }"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        let mut workspace = Workspace::new(root.to_path_buf());
        workspace.initialize().unwrap();
        let name = |path: &str| {
            workspace
                .module_name_at(&root.join(path))
                .map_err(|e| e.to_string())
        };

        assert_eq!(name("src/Utils/Helper.elm"), Ok("Utils.Helper".to_string()));
        assert_eq!(name("lib/Utils.elm"), Ok("Utils".to_string()));
        // Of two source directories that hold the file, the inner one names it
        assert_eq!(name("src/Generated/Api.elm"), Ok("Api".to_string()));
        // The compiler takes letters of any script, the digits 0 to 9 and underscores
        assert_eq!(name("src/Élan/Café2_b.elm"), Ok("Élan.Café2_b".to_string()));
        // Behind the first letter: one that is two capitals in one, one that only modifies, one without case
        for letters in ["A\u{1c5}", "A\u{2b0}", "A\u{5d0}"] {
            assert_eq!(name(&format!("src/{letters}.elm")), Ok(letters.to_string()));
        }
        // A disk can keep an accent as a letter and a mark. The name has it as one letter.
        assert_eq!(
            name("src/Foo/E\u{301}lan/Cafe\u{301}.elm"),
            Ok("Foo.\u{c9}lan.Caf\u{e9}".to_string())
        );
        assert_eq!(
            name("tests/X.elm"),
            Err(format!(
                "{} is in no source directory of elm.json (src, lib, src/Generated)",
                root.join("tests/X.elm").display()
            ))
        );
        // The compiler takes the first, a name that starts with two capitals in
        // one letter, and the parser of the index does not read it. Each one
        // from the fifth on is refused by the compiler as well: a lower-case
        // letter in front, a numeral in front, a numeral inside, a digit of
        // another script, two marks that join the letter before them and
        // compose with nothing, a letter in a square
        for odd in [
            "src/\u{1c5}ungla.elm",
            "src/helpers/Utils.elm",
            "src/utils.elm",
            "src/My-Module.elm",
            "src/été.elm",
            "src/Ⅷx.elm",
            "src/Aⅷ.elm",
            "src/A٣.elm",
            "src/A\u{345}.elm",
            "src/A\u{5b0}.elm",
            "src/\u{1F130}x.elm",
        ] {
            let error = name(odd).unwrap_err();
            assert!(
                error.contains("cannot be part of a module name"),
                "{odd}: {error}"
            );
        }
    }

    #[test]
    fn test_a_new_file_and_a_new_directory_are_spelled_as_the_module_name_is() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let src = temp_dir.path().join("src");
        fs::write(src.join("Utils.elm"), "module Utils exposing (..)\n").unwrap();
        workspace.initialize().unwrap();
        let uri = Url::from_file_path(src.join("Utils.elm")).unwrap();

        // The caller writes each accent as a letter and a mark. A file system
        // that tells the two forms apart would keep that, and the compiler
        // looks for the module under the form its name has, one letter.
        let renamed = workspace
            .rename_file(&uri, "E\u{301}te\u{301}.elm")
            .unwrap();
        assert_eq!(renamed.new_module_name, "\u{c9}t\u{e9}");
        assert_eq!(
            renamed.new_path,
            src.join("\u{c9}t\u{e9}.elm").to_string_lossy()
        );
        let moved = workspace
            .move_file(&uri, "src/Cafe\u{301}/E\u{301}te\u{301}.elm")
            .unwrap();
        assert_eq!(moved.new_module_name, "Caf\u{e9}.\u{c9}t\u{e9}");
        assert_eq!(
            moved.new_path,
            src.join("Caf\u{e9}/\u{c9}t\u{e9}.elm").to_string_lossy()
        );

        // A directory that is there keeps the spelling it was called by
        fs::create_dir(src.join("Cafe\u{301}")).unwrap();
        let into = workspace
            .move_file(&uri, "src/Cafe\u{301}/E\u{301}te\u{301}.elm")
            .unwrap();
        assert_eq!(
            into.new_path,
            src.join("Cafe\u{301}/\u{c9}t\u{e9}.elm").to_string_lossy()
        );
    }

    #[test]
    fn test_a_file_indexed_at_startup_is_not_a_disk_change() {
        let (temp_dir, mut workspace) = create_test_workspace();
        write_settled(
            &temp_dir.path().join("src").join("A.elm"),
            "module A exposing (..)\n",
        );

        workspace.initialize().unwrap();
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());
    }

    #[test]
    fn test_a_file_written_moments_ago_is_read_again_until_it_settles() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let a = temp_dir.path().join("src").join("A.elm");
        let only_a = || DiskChanges {
            changed: vec![a.clone()],
            deleted: vec![],
        };

        // Its modification time may be rounded, so a second write could look the same
        fs::write(&a, "module A exposing (..)\n").unwrap();
        assert_eq!(workspace.take_disk_changes(), only_a());
        assert_eq!(workspace.take_disk_changes(), only_a());

        write_settled(&a, "module A exposing (..)\n");
        assert_eq!(workspace.take_disk_changes(), only_a());
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());
    }

    #[test]
    fn test_a_file_dated_ahead_of_the_clock_settles_too() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let a = temp_dir.path().join("src").join("A.elm");
        fs::write(&a, "module A exposing (..)\n").unwrap();
        let in_an_hour = SystemTime::now() + Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&a)
            .unwrap()
            .set_modified(in_an_hour)
            .unwrap();

        assert_eq!(workspace.take_disk_changes().changed, vec![a]);
        // Read once. A later write would date it back to now, which shows.
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());
    }

    #[test]
    fn test_a_file_below_what_is_no_directory_any_more_is_gone() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let sub = temp_dir.path().join("src").join("Sub");
        let x = sub.join("X.elm");
        let beyond = temp_dir.path().join("tests").join("Sub").join("XTest.elm");
        for path in [&x, &beyond] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            write_settled(path, "module X exposing (..)\n");
        }
        workspace.initialize().unwrap();
        workspace.update_file(
            &Url::from_file_path(&beyond).unwrap(),
            "module XTest exposing (..)\n",
        );
        workspace.take_disk_changes();

        // A plain file takes the place of each directory. Nothing can be below it.
        for directory in [&sub, &beyond.parent().unwrap().to_path_buf()] {
            fs::remove_dir_all(directory).unwrap();
            fs::write(directory, "no directory").unwrap();
        }
        assert_eq!(
            workspace.take_disk_changes(),
            DiskChanges {
                changed: vec![],
                deleted: vec![x, beyond]
            }
        );
        assert_eq!(workspace.unreadable_files(), None);
    }

    #[test]
    fn test_elm_json_counts_as_changed_when_it_reads_differently() {
        let (temp_dir, workspace) = create_test_workspace();
        let elm_json = temp_dir.path().join("elm.json");
        assert!(!workspace.elm_json_changed());

        // Written again with the same text, which only moves its modification time
        fs::write(&elm_json, r#"{ "source-directories": ["src"] }"#).unwrap();
        assert!(!workspace.elm_json_changed());

        fs::write(&elm_json, r#"{ "source-directories": ["src", "lib"] }"#).unwrap();
        assert!(workspace.elm_json_changed());
        fs::remove_file(&elm_json).unwrap();
        assert!(workspace.elm_json_changed());
    }

    #[test]
    fn test_a_file_that_could_not_be_read_at_startup_is_looked_at_again() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let a = temp_dir.path().join("src").join("A.elm");
        let b = temp_dir.path().join("src").join("B.elm");
        write_settled(&a, "module A exposing (..)\n");
        // No text at all. A file without read permission fails the same way.
        fs::write(&b, [0xff, 0xfe, 0xfd]).unwrap();
        let long_ago = SystemTime::now() - Duration::from_secs(60);
        let dated = |path: &Path| {
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(long_ago)
                .unwrap()
        };
        dated(&b);

        workspace.initialize().unwrap();
        assert!(!workspace.modules.contains_key("B"));
        assert_eq!(
            workspace.unreadable_files(),
            Some(format!(
                "Cannot read {}: stream did not contain valid UTF-8.",
                b.display()
            ))
        );

        // Readable now, with the length and the date it had: only a forgotten stamp gives it away
        fs::write(&b, "--\n").unwrap();
        dated(&b);
        assert_eq!(workspace.take_disk_changes().changed, vec![b.clone()]);
        workspace.mark_read(&b);
        assert_eq!(workspace.unreadable_files(), None);
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());

        // Unreadable again, and gone before anyone repaired it
        workspace.mark_unreadable(&b, "no".to_string());
        workspace.mark_unreadable(&a, "no".to_string());
        assert_eq!(
            workspace.unreadable_files(),
            Some(format!(
                "Cannot read {}: no. One more file or directory cannot be read either.",
                a.display()
            ))
        );
        fs::remove_file(&b).unwrap();
        fs::remove_file(&a).unwrap();
        workspace.take_disk_changes();
        assert_eq!(workspace.unreadable_files(), None);
    }

    #[cfg(unix)]
    #[test]
    fn test_a_directory_that_cannot_be_listed_is_missing_from_the_index() {
        use std::os::unix::fs::PermissionsExt;

        let (temp_dir, mut workspace) = create_test_workspace();
        let hidden = temp_dir.path().join("src").join("Hidden");
        let a = hidden.join("A.elm");
        fs::create_dir(&hidden).unwrap();
        write_settled(&a, "module Hidden.A exposing (..)\n");
        let allow =
            |mode: u32| fs::set_permissions(&hidden, fs::Permissions::from_mode(mode)).unwrap();

        allow(0o000);
        if fs::read_dir(&hidden).is_ok() {
            // Root lists every directory, whatever its permissions say
            allow(0o755);
            return;
        }
        workspace.initialize().unwrap();
        let problem = workspace.unreadable_files();
        allow(0o755);
        assert_eq!(
            problem,
            Some(format!(
                "Cannot read {}: Permission denied (os error 13).",
                hidden.display()
            ))
        );

        assert_eq!(workspace.take_disk_changes().changed, vec![a]);
        assert_eq!(workspace.unreadable_files(), None);
    }

    #[test]
    fn test_an_elm_json_that_is_there_and_cannot_be_read_is_an_error() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let elm_json = temp_dir.path().join("elm.json");

        // Not text. Reading it fails as it does without read permission.
        fs::write(&elm_json, [0xff, 0xfe]).unwrap();
        assert!(workspace.elm_json_changed());
        let error = workspace.initialize().unwrap_err();
        assert_eq!(error.to_string(), "stream did not contain valid UTF-8");

        // A project without elm.json is a different matter: its modules are taken to be in src
        fs::remove_file(&elm_json).unwrap();
        workspace.initialize().unwrap();
        assert!(!workspace.elm_json_changed());
    }

    #[test]
    fn test_a_source_directory_made_after_startup_is_walked() {
        let temp_dir = TempDir::new().unwrap();
        fs::write(
            temp_dir.path().join("elm.json"),
            r#"{ "source-directories": ["src", "generated"] }"#,
        )
        .unwrap();
        fs::create_dir(temp_dir.path().join("src")).unwrap();
        let mut workspace = Workspace::new(temp_dir.path().to_path_buf());
        workspace.initialize().unwrap();
        assert_eq!(workspace.take_disk_changes(), DiskChanges::default());

        // A code generator writes its directory later, and elm.json stays as it is
        let generated = temp_dir.path().join("generated").join("Api.elm");
        fs::create_dir(generated.parent().unwrap()).unwrap();
        write_settled(&generated, "module Api exposing (..)\n");
        assert_eq!(
            workspace.take_disk_changes(),
            DiskChanges {
                changed: vec![generated],
                deleted: vec![]
            }
        );
    }

    #[test]
    fn test_a_package_keeps_its_modules_in_src() {
        let temp_dir = TempDir::new().unwrap();
        let a = temp_dir.path().join("src").join("A.elm");
        // A package's elm.json has no source-directories
        fs::write(temp_dir.path().join("elm.json"), r#"{ "type": "package" }"#).unwrap();
        let mut workspace = Workspace::new(temp_dir.path().to_path_buf());
        workspace.initialize().unwrap();

        // src need not be there when the server starts
        fs::create_dir(a.parent().unwrap()).unwrap();
        write_settled(&a, "module A exposing (..)\n");
        assert_eq!(
            workspace.take_disk_changes(),
            DiskChanges {
                changed: vec![a],
                deleted: vec![]
            }
        );
    }

    #[test]
    #[cfg(unix)]
    fn test_source_files_leave_out_dead_links_and_evergreen_snapshots() {
        let temp_dir = TempDir::new().unwrap();
        let src = temp_dir.path().join("src");
        fs::create_dir_all(src.join("Evergreen").join("V1")).unwrap();
        fs::write(
            temp_dir.path().join("elm.json"),
            r#"{ "source-directories": ["src"], "dependencies": { "direct": { "lamdera/core": "1.0.0" } } }"#,
        )
        .unwrap();
        fs::write(src.join("Main.elm"), "module Main exposing (..)\n").unwrap();
        fs::write(
            src.join("Evergreen").join("V1").join("Types.elm"),
            "module Evergreen.V1.Types exposing (..)\n",
        )
        .unwrap();
        // The lock file Emacs keeps beside a buffer with unsaved changes
        std::os::unix::fs::symlink("someone@host.1234", src.join(".#Main.elm")).unwrap();
        // What macOS keeps beside Main.elm on a volume without extended attributes. It is no text.
        fs::write(src.join("._Main.elm"), [0x00, 0x05, 0x16, 0x07, 0xff, 0xfe]).unwrap();
        // And a directory that no module's name can lead through
        fs::create_dir(src.join(".cache")).unwrap();
        fs::write(
            src.join(".cache").join("Old.elm"),
            "module Old exposing (..)\n",
        )
        .unwrap();
        let mut workspace = Workspace::new(temp_dir.path().to_path_buf());
        workspace.initialize().unwrap();

        assert_eq!(workspace.source_files(), vec![src.join("Main.elm")]);
    }

    #[test]
    fn test_extract_module_name_from_content() {
        let content = "module MyModule exposing (..)";
        assert_eq!(
            file_operations::extract_module_name_from_content(content),
            Some("MyModule".to_string())
        );

        let content2 = "module Utils.Helper exposing (helper)";
        assert_eq!(
            file_operations::extract_module_name_from_content(content2),
            Some("Utils.Helper".to_string())
        );

        let accented = "module Été.Modèle exposing (..)";
        assert_eq!(
            file_operations::extract_module_name_from_content(accented),
            Some("Été.Modèle".to_string())
        );

        let content3 = "-- no module declaration";
        assert_eq!(
            file_operations::extract_module_name_from_content(content3),
            None
        );

        let ports = "port module Ports exposing (send)\n\n\nport send : String -> Cmd msg\n";
        assert_eq!(
            file_operations::extract_module_name_from_content(ports),
            Some("Ports".to_string())
        );

        let laid_out = "module  Data.RataDie\n    exposing\n        ( RataDie\n        )\n";
        assert_eq!(
            file_operations::extract_module_name_from_content(laid_out),
            Some("Data.RataDie".to_string())
        );

        // A line in a comment that reads like a declaration is none
        let below_a_comment =
            "{- Once this was\nmodule Notes exposing (..)\n-}\nmodule Main exposing (..)\n";
        assert_eq!(
            file_operations::extract_module_name_from_content(below_a_comment),
            Some("Main".to_string())
        );
    }

    #[test]
    fn test_every_name_that_a_tool_gives_a_module_is_one_the_parser_reads() {
        for name in [
            "Utils",
            "\u{c9}t\u{e9}",
            "Caf\u{e9}2_b",
            "A\u{1c5}",
            "A\u{2b0}",
            "A\u{5d0}",
        ] {
            assert!(is_module_segment(name), "{name}");
            assert_eq!(
                file_operations::extract_module_name_from_content(&format!(
                    "module {name} exposing (..)\n"
                )),
                Some(name.to_string())
            );
        }
        // The compiler takes a name that starts with two capitals in one letter. The parser does not.
        let two_in_one = "\u{1c5}ungla";
        assert!(!is_module_segment(two_in_one));
        assert_eq!(
            file_operations::extract_module_name_from_content(&format!(
                "module {two_in_one} exposing (..)\n"
            )),
            None
        );
    }

    #[test]
    fn test_an_import_is_found_however_it_is_laid_out() {
        let (temp_dir, mut workspace) = create_test_workspace();
        let src = temp_dir.path().join("src");
        fs::write(
            src.join("Utils.elm"),
            "module Utils exposing (helper)\n\n\nhelper =\n    1\n",
        )
        .unwrap();
        let importer = |name: &str, top: &str| {
            let path = src.join(format!("{name}.elm"));
            let text = format!("module {name} exposing (..)\n\n{top}\n\n\nvalue =\n    1\n");
            fs::write(&path, text).unwrap();
            Url::from_file_path(path).unwrap()
        };
        // Two spaces, and "exposing" on a line of its own. The compiler takes both.
        let spaced = importer("Spaced", "import  Utils exposing (helper)");
        let split = importer("Split", "import Utils\n    exposing (helper)");
        // A line in a comment or in a string that reads like an import is none
        let quoted = importer(
            "Quoted",
            "{- import Utils -}\n-- import Utils\ntext =\n    \"\"\"\nimport Utils\n\"\"\"",
        );
        workspace.initialize().unwrap();

        let utils = Url::from_file_path(src.join("Utils.elm")).unwrap();
        let result = workspace.rename_file(&utils, "Helpers.elm").unwrap();
        let edits = |uri: &Url| {
            result.changes.get(uri).map(|edits| {
                edits
                    .iter()
                    .map(|edit| {
                        let Range { start, end } = edit.range;
                        (start.line, start.character, end.character)
                    })
                    .collect::<Vec<_>>()
            })
        };
        assert_eq!(edits(&spaced), Some(vec![(2, 8, 13)]));
        assert_eq!(edits(&split), Some(vec![(2, 7, 12)]));
        assert_eq!(edits(&quoted), None);
        assert_eq!(result.files_updated, 2);
    }

    #[test]
    fn test_path_to_module_name() {
        let (temp_dir, workspace) = create_test_workspace();
        let src_dir = temp_dir.path().join("src");

        // Create nested directories for testing
        fs::create_dir_all(src_dir.join("Utils")).unwrap();
        fs::create_dir_all(src_dir.join("Pages").join("Home")).unwrap();

        // Use absolute paths that match the workspace's source_dirs
        assert_eq!(
            workspace.path_to_module_name(&src_dir.join("Main.elm")),
            "Main"
        );

        assert_eq!(
            workspace.path_to_module_name(&src_dir.join("Utils").join("Helper.elm")),
            "Utils.Helper"
        );

        assert_eq!(
            workspace.path_to_module_name(&src_dir.join("Pages").join("Home").join("View.elm")),
            "Pages.Home.View"
        );

        drop(temp_dir);
    }

    #[test]
    fn test_rename_file_updates_module_declaration() {
        let (temp_dir, mut workspace) = create_test_workspace();

        // Create a test file
        let src_dir = temp_dir.path().join("src");
        let old_content = r#"module OldName exposing (..)

value : Int
value = 42
"#;
        fs::write(src_dir.join("OldName.elm"), old_content).unwrap();

        // Re-initialize to pick up the new file
        workspace.initialize().unwrap();

        let uri = Url::from_file_path(src_dir.join("OldName.elm")).unwrap();
        let result = workspace.rename_file(&uri, "NewName.elm").unwrap();

        assert_eq!(result.old_module_name, "OldName");
        assert_eq!(result.new_module_name, "NewName");
        assert!(result.new_path.ends_with("NewName.elm"));

        // Check that we have changes for the module declaration
        assert!(result.changes.contains_key(&uri));

        drop(temp_dir);
    }

    #[test]
    fn test_rename_file_updates_imports() {
        let (temp_dir, mut workspace) = create_test_workspace();

        // Create files
        let src_dir = temp_dir.path().join("src");

        let helper_content = r#"module Helper exposing (help)

help : Int
help = 42
"#;
        fs::write(src_dir.join("Helper.elm"), helper_content).unwrap();

        let main_content = r#"module Main exposing (..)

import Helper exposing (help)

value : Int
value = help
"#;
        fs::write(src_dir.join("Main.elm"), main_content).unwrap();

        // Re-initialize to pick up the new files
        workspace.initialize().unwrap();

        let helper_uri = Url::from_file_path(src_dir.join("Helper.elm")).unwrap();
        let result = workspace.rename_file(&helper_uri, "NewHelper.elm").unwrap();

        assert_eq!(result.old_module_name, "Helper");
        assert_eq!(result.new_module_name, "NewHelper");

        // Should have updates in Main.elm for the import
        assert!(result.files_updated > 0);

        drop(temp_dir);
    }

    #[test]
    fn test_move_file_to_subdirectory() {
        let (temp_dir, mut workspace) = create_test_workspace();

        // Create a test file in src root
        let src_dir = temp_dir.path().join("src");
        let old_content = r#"module Helper exposing (..)

value : Int
value = 42
"#;
        fs::write(src_dir.join("Helper.elm"), old_content).unwrap();

        // Re-initialize to pick up the new file
        workspace.initialize().unwrap();

        let uri = Url::from_file_path(src_dir.join("Helper.elm")).unwrap();
        let result = workspace.move_file(&uri, "src/Utils/Helper.elm").unwrap();

        assert_eq!(result.old_module_name, "Helper");
        assert_eq!(result.new_module_name, "Utils.Helper");
        assert!(result.new_path.contains("Utils"));

        // Check that we have changes for the module declaration
        assert!(result.changes.contains_key(&uri));

        drop(temp_dir);
    }

    #[test]
    fn test_move_file_updates_imports() {
        let (temp_dir, mut workspace) = create_test_workspace();

        // Create files
        let src_dir = temp_dir.path().join("src");

        let helper_content = r#"module Helper exposing (help)

help : Int
help = 42
"#;
        fs::write(src_dir.join("Helper.elm"), helper_content).unwrap();

        let main_content = r#"module Main exposing (..)

import Helper exposing (help)

value : Int
value = help
"#;
        fs::write(src_dir.join("Main.elm"), main_content).unwrap();

        // Re-initialize
        workspace.initialize().unwrap();

        let helper_uri = Url::from_file_path(src_dir.join("Helper.elm")).unwrap();
        let result = workspace
            .move_file(&helper_uri, "src/Utils/Helper.elm")
            .unwrap();

        assert_eq!(result.old_module_name, "Helper");
        assert_eq!(result.new_module_name, "Utils.Helper");

        // Should have updates in Main.elm for the import
        assert!(result.files_updated > 0);

        drop(temp_dir);
    }

    #[test]
    fn test_find_module_name_range() {
        let range = |content: &str| {
            file_operations::find_module_name_range(content)
                .map(|range| (range.start.line, range.start.character, range.end.character))
        };
        assert_eq!(
            range("module MyModule exposing (..)\n\nvalue = 42"),
            Some((0, 7, 15))
        );
        assert_eq!(
            range("port module Ports exposing (send)\n"),
            Some((0, 12, 17))
        );
        // Columns count bytes, as everywhere in the language server: "Été" is five of them
        assert_eq!(range("module Été exposing (..)\n"), Some((0, 7, 12)));
        // The compiler takes any number of spaces, and the word "exposing" on
        // the next line, where an old elm-format put it
        assert_eq!(range("module  Utils   exposing (..)\n"), Some((0, 8, 13)));
        assert_eq!(
            range("-- a date\nmodule RataDie\n    exposing\n        ( RataDie\n        )\n"),
            Some((1, 7, 14))
        );
        // A line in a comment above the declaration that reads like one
        assert_eq!(
            range("{-\nmodule Notes exposing (..)\n-}\nmodule Main exposing (..)\n"),
            Some((3, 7, 11))
        );
        // A line that only begins like a module line
        assert_eq!(range("module Utils is the one to read\n"), None);
        assert_eq!(range("module Utils\n\nexposing nothing\n"), None);
        assert_eq!(range("module utils exposing (..)\n"), None);
    }

    #[test]
    fn test_rename_file_rejects_invalid_extension() {
        let (temp_dir, mut workspace) = create_test_workspace();

        let src_dir = temp_dir.path().join("src");
        let old_content = r#"module OldName exposing (..)"#;
        fs::write(src_dir.join("OldName.elm"), old_content).unwrap();
        workspace.initialize().unwrap();

        let uri = Url::from_file_path(src_dir.join("OldName.elm")).unwrap();
        let result = workspace.rename_file(&uri, "NewName.txt");

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains(".elm"));

        drop(temp_dir);
    }
}
