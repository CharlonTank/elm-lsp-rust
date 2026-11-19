/**
 * Finding the Elm project a file belongs to, and writing edits into it.
 */

import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { ToolError } from "./errors.mjs";

/**
 * The file URI of an absolute path, spelled the way the language server
 * spells it. The server builds the URIs of its index with Rust's url crate and
 * compares URIs as text, so a URI that escapes other characters names a second
 * document for the same file. Node's pathToFileURL is such a spelling: it also
 * escapes ~ ^ | [ and ].
 */
export function toFileUri(absPath) {
  return "file://" + absPath.replace(/[\0-\x20"#%<>?\\`{}\x7f]|[^\0-\x7f]+/g, encodeURIComponent);
}

// The nearest ancestor directory of filePath that holds an elm.json, or null.
export function findWorkspaceRoot(filePath) {
  let dir = dirname(resolve(filePath));
  while (dir !== "/") {
    if (existsSync(join(dir, "elm.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

// Whether the compiler and elm-format may come from a project's node_modules.
// Off unless the person who starts the server or the CLI turns it on, because
// it lets a repository choose the program that a tool runs.
let projectToolsAllowed = false;

export function allowProjectTools() {
  projectToolsAllowed = true;
}

// Every node_modules/.bin from `dir` up to the file system root, nearest first.
function projectBins(dir) {
  const bins = [];
  for (let current = resolve(dir); ; current = dirname(current)) {
    bins.push(join(current, "node_modules", ".bin"));
    if (dirname(current) === current) break;
  }
  return bins;
}

/**
 * The PATH for programs that are run on behalf of the project in `dir`.
 * After allowProjectTools(), the project's node_modules/.bin directories come
 * first. npm scripts find a project's own tools the same way, so the versions
 * a project pins win over global ones.
 */
export function toolPath(dir) {
  if (!projectToolsAllowed) return process.env.PATH;
  return [...projectBins(dir), process.env.PATH].filter(Boolean).join(delimiter);
}

/**
 * What to add to the error when none of `names` was found on PATH: where the
 * project in `dir` keeps its own copy, and how to allow it. Empty when the
 * project has none or its tools are allowed already.
 */
export function projectToolsHint(dir, names) {
  if (projectToolsAllowed) return "";
  for (const bin of projectBins(dir)) {
    const name = names.find((candidate) => existsSync(join(bin, candidate)));
    if (name) return ` This project has ${name} in ${bin}. Pass --project-tools to use it.`;
  }
  return "";
}

const isInside = (path, directory) => path === directory || path.startsWith(directory + "/");

// A path with every part of it that exists spelled as the disk spells it. A file system that
// ignores letter case takes src/utils.elm for src/Utils.elm, and the language server knows a file
// by one spelling. A link on the way keeps its place in the path and its own name. What is not
// there yet, as in the target of a move, stays as it is written.
export function asSpelledOnDisk(absPath) {
  const parts = absPath.split(sep).filter(Boolean);
  let spelled = sep;
  for (const [at, part] of parts.entries()) {
    const here = join(spelled, part);
    const entry = entryAt(here);
    if (!entry) return join(spelled, ...parts.slice(at));
    // What is there says under its real name how that is spelled. The real name of a link is
    // the name of what it leads to, so a link's own name is read from the directory it lies in.
    spelled = join(spelled, entry.isSymbolicLink() ? nameListedIn(spelled, part, entry) : basename(realpathSync.native(here)));
  }
  return spelled;
}

// What is at a path, a link counted as itself, or nothing: where no entry of that name is, and
// where the path goes on below a file, as a mistyped target of a move can.
function entryAt(path) {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (error.code === "ENOTDIR") return undefined;
    throw error;
  }
}

// The name that a directory lists for `entry`, which was found in it under `name`. A file system
// can find an entry under spellings it does not list. The given name stands where the directory
// cannot be listed.
function nameListedIn(directory, name, entry) {
  let names = [];
  try {
    names = readdirSync(directory);
  } catch {
    return name;
  }
  if (names.includes(name)) return name;
  const isIt = (listed) => {
    const other = lstatSync(join(directory, listed), { throwIfNoEntry: false });
    return other?.ino === entry.ino && other?.dev === entry.dev;
  };
  return names.find(isIt) ?? name;
}

// The place that a source directory of elm.json names, as the language server works it out, so
// that the two agree on which files belong to a project. ".." is read as the file system reads
// it: behind a link it is the directory above the one the link leads to. With home/app a link to
// data/app, "../shared" is data/shared, which is where the compiler looks. A link to nothing leads
// to no directory, and ".." behind it is read from the text of the path.
function sourceDirectory(root, listed) {
  let place = isAbsolute(listed) ? sep : root;
  for (const part of listed.split(sep)) {
    if (part === "" || part === ".") continue;
    if (part !== "..") place = join(place, part);
    else {
      if (entryAt(place)?.isSymbolicLink()) place = realPlaceOf(place) ?? place;
      place = dirname(place);
    }
  }
  return asSpelledOnDisk(place);
}

// Where a link leads in the end, or nothing for a link that leads nowhere
function realPlaceOf(link) {
  try {
    return realpathSync.native(link);
  } catch {
    return undefined;
  }
}

/**
 * The directories that hold a project's files: its root, and the source
 * directories of its elm.json. One of those can lie outside the root, as
 * "../shared" does in a repository of several applications.
 */
export function projectDirectories(workspaceRoot) {
  const root = resolve(workspaceRoot);
  let listed = [];
  try {
    listed = JSON.parse(readFileSync(join(root, "elm.json"), "utf-8"))["source-directories"] ?? [];
  } catch {
    // The language server reports an elm.json that cannot be read. The root is all there is to go by.
  }
  return [root, ...listed.filter((directory) => typeof directory === "string").map((directory) => sourceDirectory(root, directory))];
}

// The real place of a path whose last parts may not exist yet: links in the part that exists are followed.
function realPlace(absPath) {
  let existing = absPath;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    existing = dirname(existing);
  }
  return join(realpathSync(existing), relative(existing, absPath));
}

/**
 * Throw unless a path lies in the project, both as it is spelled and where it
 * really is. A directory in the project can be a link to one outside it, and
 * a file moved "into" it would leave the project.
 */
export function assertInProject(absPath, workspaceRoot) {
  const path = resolve(absPath);
  const directories = projectDirectories(workspaceRoot);
  if (!directories.some((directory) => isInside(path, directory))) {
    throw new ToolError(`Path ${path} is outside workspace ${resolve(workspaceRoot)}`);
  }
  const real = realPlace(path);
  if (!directories.some((directory) => isInside(real, realPlace(directory)))) {
    throw new ToolError(`Path ${path} leads out of workspace ${resolve(workspaceRoot)}, through a link to ${real}`);
  }
}

// The edits of an LSP WorkspaceEdit per file path. Two URIs that spell the same
// path are one file, and an edit listed under both is applied once.
function editsByPath(changes) {
  const byPath = new Map();
  for (const [fileUri, edits] of Object.entries(changes)) {
    const filePath = fileURLToPath(fileUri);
    const known = byPath.get(filePath) ?? new Map();
    for (const edit of edits) {
      known.set(JSON.stringify([edit.range, edit.newText]), edit);
    }
    byPath.set(filePath, known);
  }
  return [...byPath].map(([filePath, known]) => [filePath, [...known.values()]]);
}

// The text of a file that a refactoring is about to change.
export function readForEdit(filePath) {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new ToolError(`Cannot read ${filePath}, so no file was changed. ${error.message}`);
  }
}

// Write the files of a refactoring, given as [path, content] pairs. One that
// stops after its first file leaves a project that does not compile, so a file
// without write permission is found before anything has changed.
export function writeEdited(files) {
  for (const [filePath] of files) {
    try {
      accessSync(filePath, constants.W_OK);
    } catch (error) {
      throw new ToolError(`Cannot write ${filePath}, so no file was changed. ${error.message}`);
    }
  }
  for (const [filePath, content] of files) {
    writeFileSync(filePath, content, "utf-8");
  }
}

// The place in a line that the language server means by a column. It counts a column in bytes
// of UTF-8, and a string is indexed in UTF-16 code units. The two part ways behind the first
// character outside ASCII on a line: in `"café " ++ name`, `name` is at column 12 and index 11.
export function indexOfColumn(line, column) {
  let bytes = 0;
  let index = 0;
  for (const character of line) {
    if (bytes >= column) break;
    bytes += Buffer.byteLength(character);
    index += character.length;
  }
  return index;
}

// Write the text edits of an LSP WorkspaceEdit to disk and tell the language
// server about the new contents. Returns one { path, edits } entry per file.
// Every file is read before the first is written.
export async function applyWorkspaceEdit(changes, client, workspaceRoot) {
  const applied = [];
  const edited = [];
  const perFile = editsByPath(changes);

  // A change that names a file outside the project is not one to carry out in
  // part. Leaving that file as it is would break the build as surely as a
  // file that cannot be written.
  const directories = projectDirectories(workspaceRoot);
  const strangers = perFile.map(([filePath]) => filePath).filter((filePath) => !directories.some((directory) => isInside(filePath, directory)));
  if (strangers.length > 0) {
    const others = strangers.length > 1 ? ` and ${strangers.length - 1} more` : "";
    throw new ToolError(
      `The change reaches ${strangers[0]}${others}, outside the project and the source directories of its elm.json, so no file was changed.`
    );
  }

  for (const [filePath, edits] of perFile) {
    const lines = readForEdit(filePath).split("\n");

    // Apply bottom to top, right to left, so earlier edits keep their positions.
    const sortedEdits = [...edits].sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return b.range.start.line - a.range.start.line;
      }
      return b.range.start.character - a.range.start.character;
    });

    for (const edit of sortedEdits) {
      const { start, end } = edit.range;
      const [first, last] = [lines[start.line] || "", lines[end.line] || ""];
      const before = first.substring(0, indexOfColumn(first, start.character));
      const after = last.substring(indexOfColumn(last, end.character));

      lines[start.line] = before + edit.newText + after;
      if (end.line > start.line) {
        lines.splice(start.line + 1, end.line - start.line);
      }
    }

    applied.push({ path: filePath, edits: edits.length });
    edited.push([filePath, lines.join("\n")]);
  }

  writeEdited(edited);
  for (const [filePath, content] of edited) {
    await client.notifyFileChanged(toFileUri(filePath), content);
  }

  return applied;
}
