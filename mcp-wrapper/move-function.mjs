/**
 * Text-based implementation of elm_move_function.
 *
 * Moves one top-level function between two modules by editing lines: it cuts
 * the function out of the source file, appends it to the target file, fixes
 * both exposing lists, and rewrites imports in every other file that exposed
 * the function from the source module.
 */

import { join } from "path";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { ToolError } from "./errors.mjs";

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

function elmFilesIn(dir, excluded) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      if (!entry.startsWith(".") && entry !== "elm-stuff" && entry !== "node_modules") {
        files.push(...elmFilesIn(fullPath, excluded));
      }
    } else if (entry.endsWith(".elm") && !excluded.includes(fullPath)) {
      files.push(fullPath);
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
  const targetContent = readFileSync(absTargetModule, "utf-8");
  const targetLines = targetContent.split("\n");

  const { start, end } = functionBounds(sourceLines, functionName, funcLine);
  const functionText = sourceLines.slice(start, end + 1).join("\n");
  const sourceModuleName = extractModuleName(sourceContent);
  const targetModuleName = extractModuleName(targetContent);

  const targetUri = `file://${absTargetModule}`;
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

  writeFileSync(absPath, newSourceLines.join("\n"));
  writeFileSync(absTargetModule, newTargetLines.join("\n"));
  const changedFiles = [absPath, absTargetModule];

  // Every other file that exposed the function from the source module
  let filesUpdated = 0;
  for (const elmFile of elmFilesIn(workspaceRoot, [absPath, absTargetModule])) {
    const newContent = retargetImport(readFileSync(elmFile, "utf-8"), functionName, sourceModuleName, targetModuleName);
    if (newContent !== null) {
      writeFileSync(elmFile, newContent);
      changedFiles.push(elmFile);
      filesUpdated++;
    }
  }

  for (const filePath of changedFiles) {
    await client.notifyFileChanged(`file://${filePath}`, readFileSync(filePath, "utf-8"));
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
