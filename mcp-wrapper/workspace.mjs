/**
 * Finding the Elm project a file belongs to, and writing edits into it.
 */

import { delimiter, dirname, join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
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

function isInWorkspace(absPath, workspaceRoot) {
  const path = resolve(absPath);
  const root = resolve(workspaceRoot);
  return path === root || path.startsWith(root + "/");
}

export function assertInWorkspace(absPath, workspaceRoot) {
  if (!isInWorkspace(absPath, workspaceRoot)) {
    throw new ToolError(`Path ${resolve(absPath)} is outside workspace ${resolve(workspaceRoot)}`);
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

// Write the text edits of an LSP WorkspaceEdit to disk and tell the language
// server about the new contents. Returns one { path, edits } entry per file.
export async function applyWorkspaceEdit(changes, client, workspaceRoot) {
  const applied = [];
  const changedFiles = [];

  for (const [filePath, edits] of editsByPath(changes)) {
    if (!isInWorkspace(filePath, workspaceRoot)) {
      console.error(`Skipping edit outside workspace: ${filePath}`);
      continue;
    }

    if (!existsSync(filePath)) continue;

    const lines = readFileSync(filePath, "utf-8").split("\n");

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

    const newContent = lines.join("\n");
    writeFileSync(filePath, newContent, "utf-8");
    applied.push({ path: filePath, edits: edits.length });
    changedFiles.push({ uri: toFileUri(filePath), content: newContent });
  }

  for (const { uri, content } of changedFiles) {
    await client.notifyFileChanged(uri, content);
  }

  return applied;
}
