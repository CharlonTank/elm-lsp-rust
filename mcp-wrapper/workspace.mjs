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

// PATH with every node_modules/.bin from dir up to the file system root put
// first, nearest first. npm scripts find a project's own tools the same way,
// so the Elm compiler and elm-format that a project pins win over global ones.
export function pathWithLocalTools(dir) {
  const bins = [];
  let current = resolve(dir);
  while (true) {
    const bin = join(current, "node_modules", ".bin");
    if (existsSync(bin)) {
      bins.push(bin);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...bins, process.env.PATH].filter(Boolean).join(delimiter);
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
