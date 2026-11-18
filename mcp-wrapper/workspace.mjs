/**
 * Finding the Elm project a file belongs to, and writing edits into it.
 */

import { delimiter, dirname, join, relative, resolve } from "path";
import { accessSync, constants, existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
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
  return [root, ...listed.filter((directory) => typeof directory === "string").map((directory) => resolve(root, directory))];
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
      const before = (lines[start.line] || "").substring(0, start.character);
      const after = (lines[end.line] || "").substring(end.character);

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
