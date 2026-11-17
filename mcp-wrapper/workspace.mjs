/**
 * Finding the Elm project a file belongs to, and writing edits into it.
 */

import { dirname, join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { ToolError } from "./errors.mjs";

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

// Write the text edits of an LSP WorkspaceEdit to disk and tell the language
// server about the new contents. Returns one { path, edits } entry per file.
export async function applyWorkspaceEdit(changes, client, workspaceRoot) {
  const applied = [];
  const changedFiles = [];

  for (const [fileUri, edits] of Object.entries(changes)) {
    const filePath = new URL(fileUri).pathname;

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
    changedFiles.push({ uri: fileUri, content: newContent });
  }

  for (const { uri, content } of changedFiles) {
    await client.notifyFileChanged(uri, content);
  }

  return applied;
}
