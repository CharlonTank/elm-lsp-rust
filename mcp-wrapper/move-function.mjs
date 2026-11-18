/**
 * Text-based implementation of elm_move_function.
 *
 * Moves one top-level function between two modules by editing lines: it cuts
 * the function out of the source file, appends it to the target file, fixes
 * both exposing lists, and rewrites imports in every other file that exposed
 * the function from the source module.
 */

import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { ToolError } from "./errors.mjs";
import { projectDirectories, readForEdit, toFileUri, writeEdited } from "./workspace.mjs";

function extractModuleName(content) {
  const match = content.match(/^module\s+([A-Za-z.]+)\s+exposing/m);
  return match ? match[1] : "Unknown";
}

// First and last line of the function, including its type signature.
function functionBounds(lines, functionName, funcLine) {
  let start = funcLine;
  let end = funcLine;

  // Look backwards for the type signature
  for (let i = funcLine - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") break;
    if (line.startsWith(`${functionName} :`)) {
      start = i;
      break;
    }
    if (line.includes(" =") && !line.startsWith(`${functionName} `)) break;
  }

  // Look forwards until a blank line is followed by a new top-level definition
  for (let i = funcLine + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length) {
        const nextLine = lines[j].trim();
        if (nextLine.match(/^[a-z]/) || nextLine.startsWith("type ") || nextLine.startsWith("port ")) {
          end = i - 1;
          break;
        }
      }
    }
    end = i;
  }

  while (end > start && lines[end].trim() === "") {
    end--;
  }

  return { start, end };
}

// Index for a new import line. It goes before the first import, or two lines
// below the module declaration when the file has no imports yet.
function importInsertIndex(lines) {
  const firstImport = lines.findIndex((line) => line.trim().startsWith("import "));
  if (firstImport > 0) return firstImport;

  const moduleLine = lines.findIndex((line) => line.includes("module "));
  return moduleLine === -1 ? 0 : moduleLine + 2;
}

// Index of the single-line module declaration with an explicit exposing list,
// or -1 when the module exposes everything or has no such line.
function exposingLineIndex(lines) {
  const index = lines.findIndex((line) => line.includes("module ") && line.includes(" exposing "));
  return index !== -1 && !lines[index].includes("exposing (..)") ? index : -1;
}

// What the disk knows a regular file by, whatever name leads to it: a link to a file and a
// second name of it are that file. Nothing for what is no file.
function fileAt(path) {
  try {
    const stats = statSync(path, { bigint: true });
    return stats.isFile() ? `${stats.dev}:${stats.ino}` : undefined;
  } catch (error) {
    // A link to nothing, such as the one an editor keeps as a lock
    if (error.code === "ENOENT") return undefined;
    // Anything else can be a module that is there and out of reach, which the move must not pass over
    throw new ToolError(`Cannot read ${path}, so no file was changed. ${error.message}`);
  }
}

function entriesOf(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new ToolError(`Cannot read ${dir}, so no file was changed. ${error.message}`);
  }
}

// The Elm files under dir, found the way the language server finds them: a
// link to a file counts as that file, a link to a directory is not followed,
// and nothing whose name starts with a dot is a module or leads to one. A file
// that `seen` holds is left out, and each file that is found joins it, so a
// file with several names is listed once.
function elmFilesIn(dir, seen) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of entriesOf(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && entry.name !== "elm-stuff" && entry.name !== "node_modules") {
        files.push(...elmFilesIn(fullPath, seen));
      }
    } else if (entry.name.endsWith(".elm") && !entry.name.startsWith(".")) {
      const file = fileAt(fullPath);
      if (file && !seen.has(file)) {
        seen.add(file);
        files.push(fullPath);
      }
    }
  }
  return files;
}

// Point an importing file at the function's new module. Returns the new
// content, or null when the file does not expose the function from the source.
function retargetImport(content, functionName, sourceModuleName, targetModuleName) {
  const importRegex = new RegExp(`import\\s+${sourceModuleName}\\s+exposing\\s*\\(([^)]+)\\)`);
  const match = content.match(importRegex);
  const exposed = match ? match[1].split(",").map((s) => s.trim()) : [];
  if (!exposed.includes(functionName)) return null;

  let newContent = content;

  // Drop the function from the source import, or the whole line if it was alone
  const remaining = exposed.filter((s) => s !== functionName);
  if (remaining.length > 0) {
    newContent = newContent.replace(importRegex, `import ${sourceModuleName} exposing (${remaining.join(", ")})`);
  } else {
    newContent = newContent.replace(new RegExp(`import\\s+${sourceModuleName}\\s+exposing\\s*\\([^)]+\\)\\n?`), "");
  }

  // Expose it from the target import, adding that import when missing
  const targetImportRegex = new RegExp(`import\\s+${targetModuleName}\\s+exposing\\s*\\(([^)]+)\\)`);
  const targetMatch = newContent.match(targetImportRegex);
  if (!targetMatch) {
    const lines = newContent.split("\n");
    lines.splice(importInsertIndex(lines), 0, `import ${targetModuleName} exposing (${functionName})`);
    return lines.join("\n");
  }

  const targetItems = targetMatch[1].split(",").map((s) => s.trim());
  if (!targetItems.includes(functionName)) {
    targetItems.push(functionName);
    newContent = newContent.replace(targetImportRegex, `import ${targetModuleName} exposing (${targetItems.join(", ")})`);
  }
  return newContent;
}

/**
 * Move the function whose definition starts on funcLine of absPath into
 * absTargetModule. Resolves with the summary shown to the agent.
 */
export async function moveFunction({ client, workspaceRoot, absPath, absTargetModule, sourceContent, functionName, funcLine }) {
  const sourceLines = sourceContent.split("\n");
  const targetContent = readForEdit(absTargetModule);
  const targetLines = targetContent.split("\n");

  const { start, end } = functionBounds(sourceLines, functionName, funcLine);
  const functionText = sourceLines.slice(start, end + 1).join("\n");
  const sourceModuleName = extractModuleName(sourceContent);
  const targetModuleName = extractModuleName(targetContent);

  const targetUri = toFileUri(absTargetModule);
  await client.openDocument(targetUri, targetContent);
  const targetSymbols = await client.getSymbols(targetUri);
  if (targetSymbols?.some((s) => s.name === functionName)) {
    throw new ToolError(
      `Cannot move function: Target module '${targetModuleName}' already has a function named '${functionName}'`
    );
  }

  // Target: append the function after the last non-empty line and expose it
  let insertLine = targetLines.length;
  while (insertLine > 0 && targetLines[insertLine - 1].trim() === "") {
    insertLine--;
  }
  const newTargetLines = [...targetLines];
  newTargetLines.splice(insertLine, 0, "", "", functionText, "");

  const targetExposing = exposingLineIndex(newTargetLines);
  if (targetExposing !== -1) {
    const line = newTargetLines[targetExposing];
    const closeParenIdx = line.lastIndexOf(")");
    if (closeParenIdx !== -1) {
      newTargetLines[targetExposing] = line.slice(0, closeParenIdx) + ", " + functionName + ")";
    }
  }

  // Source: cut the function, collapse the blank lines it leaves behind,
  // stop exposing it, and import it from the target instead
  const newSourceLines = [...sourceLines];
  newSourceLines.splice(start, end - start + 1);
  while (newSourceLines[start]?.trim() === "" && newSourceLines[start + 1]?.trim() === "") {
    newSourceLines.splice(start, 1);
  }

  const sourceExposing = exposingLineIndex(newSourceLines);
  if (sourceExposing !== -1) {
    const match = newSourceLines[sourceExposing].match(/exposing\s*\(([^)]+)\)/);
    if (match) {
      const items = match[1].split(",").map((s) => s.trim()).filter((s) => s !== functionName);
      if (items.length > 0) {
        newSourceLines[sourceExposing] = newSourceLines[sourceExposing].replace(
          /exposing\s*\([^)]+\)/,
          `exposing (${items.join(", ")})`
        );
      }
    }
  }

  newSourceLines.splice(importInsertIndex(newSourceLines), 0, `import ${targetModuleName} exposing (${functionName})`);

  // Every other file that exposed the function from the source module. All of
  // them are read before the first file is written, so that a file that cannot
  // be read stops the move while nothing has changed yet.
  // A source directory can lie outside the project root, and one inside it is walked with the root.
  // The two modules of the move are no other files, under any of their names: what is written for
  // a link to the target would put the target back as it was, and the function would be in no file.
  const seen = new Set([fileAt(absPath), fileAt(absTargetModule)]);
  const others = projectDirectories(workspaceRoot).flatMap((directory) => elmFilesIn(directory, seen));
  const retargeted = others
    .map((elmFile) => [elmFile, retargetImport(readForEdit(elmFile), functionName, sourceModuleName, targetModuleName)])
    .filter(([, newContent]) => newContent !== null);
  const filesUpdated = retargeted.length;

  const written = [[absPath, newSourceLines.join("\n")], [absTargetModule, newTargetLines.join("\n")], ...retargeted];
  writeEdited(written);
  for (const [filePath, content] of written) {
    await client.notifyFileChanged(toFileUri(filePath), content);
  }

  return (
    `Successfully moved "${functionName}" from ${sourceModuleName} to ${targetModuleName}.\n` +
    `- Removed function from source file\n` +
    `- Added function to target file\n` +
    `- Updated source module's exposing list\n` +
    `- Updated target module's exposing list\n` +
    `- Updated imports in ${filesUpdated} other file(s).`
  );
}
