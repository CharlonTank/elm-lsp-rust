/**
 * The Elm tools, defined once and independent of how they are served.
 *
 * Each entry of `tools` has a name, a title, a description, a zod input shape
 * and a `run(args)` function that resolves with the result text. `run` throws
 * ToolError when the request cannot be carried out. `readOnly` is true for a
 * tool that never edits a source file. `openWorld` marks the one tool that
 * can reach the network.
 */

import { execFile } from "child_process";
import { mkdir, rename } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { z } from "zod";
import { ToolError } from "./errors.mjs";
import { ensureClient } from "./lsp-client.mjs";
import { moveFunction, sharedLinesError, signatureBelowError, unreadError } from "./move-function.mjs";
import {
  applyWorkspaceEdit,
  asSpelledOnDisk,
  assertInProject,
  findWorkspaceRoot,
  projectToolsHint,
  toFileUri,
  toolPath,
} from "./workspace.mjs";

const execFileAsync = promisify(execFile);

// LSP SymbolKind values the server reports
const SYMBOL_KIND_NAMES = {
  1: "File",
  2: "Module",
  5: "Class",
  6: "Method",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  22: "Struct",
  23: "Event",
  24: "Operator",
  25: "TypeParameter",
};

const elmFile = (description = "Path to the Elm file") => z.string().describe(description);

// How many errors in other files elm_diagnostics lists before it only counts them
const MAX_ERRORS_ELSEWHERE = 20;

// A line, a column or a count. The server reads these as unsigned integers.
const wholeNumber = (description) => z.number().int().min(0).describe(description);

// A column that the caller passes. The language server counts it in UTF-8 bytes, as it counts
// the columns in its results.
const column = (description) =>
  wholeNumber(`${description} (0-indexed), counted in UTF-8 bytes on a line with non-ASCII text before it`);

// The `line` and `character` fields that point at a symbol.
function position(subject) {
  return {
    line: wholeNumber(subject ? `Line number of the ${subject} (0-indexed)` : "Line number (0-indexed)"),
    character: column(subject ? `Character position within the ${subject}` : "Character position"),
  };
}

// The `start_*` and `end_*` fields that select a range.
const rangeFields = {
  start_line: wholeNumber("Start line (0-indexed)"),
  start_char: column("Start character"),
  end_line: wholeNumber("End line (0-indexed)"),
  end_char: column("End character"),
};

// The path in the message shows the caller how a relative path was resolved.
const noProject = (absPath) => `No elm.json found in the parent directories of ${absPath}`;

// Resolve a path to the absolute path of a file that is there.
function existingFile(filePath) {
  const given = resolve(filePath);
  const stats = statSync(given, { throwIfNoEntry: false });
  if (!stats?.isFile()) {
    throw new ToolError(`Cannot read ${given}: ${stats ? "it is not a file" : "it does not exist"}`);
  }
  return given;
}

// Resolve a file to an absolute path and the Elm project that contains it.
function locate(filePath) {
  const absPath = asSpelledOnDisk(existingFile(filePath));
  const workspaceRoot = findWorkspaceRoot(absPath);
  if (!workspaceRoot) {
    throw new ToolError(noProject(absPath));
  }
  return { absPath, workspaceRoot };
}

// locate(), plus a language server running for that project.
async function connect(filePath) {
  const { absPath, workspaceRoot } = locate(filePath);
  const client = await ensureClient(workspaceRoot);
  return { client, uri: toFileUri(absPath), absPath, workspaceRoot };
}

// connect(), then send the file's current content to the language server.
async function openElmFile(filePath) {
  const context = await connect(filePath);
  const content = readFileSync(context.absPath, "utf-8");
  await context.client.openDocument(context.uri, content);
  return { ...context, content };
}

// documentSymbol answers with SymbolInformation (location.range) or DocumentSymbol (range)
const symbolRange = (symbol) => symbol.location?.range ?? symbol.range;
const symbolLine = (symbol) => symbolRange(symbol)?.start?.line;

function formatLocation({ uri, range }) {
  return `${fileURLToPath(uri)}:${range.start.line + 1}:${range.start.character}`;
}

// Refactoring tools take the symbol's current name next to its position, so a
// position that went stale after an earlier edit cannot hit another symbol.
// `found` is the name the server saw at the position. It is undefined when the
// server saw no such symbol there, and `reason` is then the server's explanation.
function assertExpectedName(kind, expected, found, line, reason) {
  if (found === undefined) {
    throw new ToolError(reason ? `Error: ${reason}` : `No ${kind} found at line ${line + 1}. Expected: ${expected}`);
  }
  if (found !== expected) {
    throw new ToolError(
      `Safety check failed: Expected ${kind} '${expected}' but found '${found}' at line ${line + 1}.\n` +
        `The line number may have shifted. Please verify the correct line for '${expected}'.`
    );
  }
}

// A new name is written into every file that uses the old one, so what is no name stops here.
// The compiler takes a first letter of the right case, then letters of any script, the digits 0
// to 9 and underscores. It keeps fourteen words for itself, and none of them names anything.
const NAMES = {
  lower: [/^\p{Ll}[\p{L}0-9_]*$/u, "a lower-case letter"],
  upper: [/^\p{Lu}[\p{L}0-9_]*$/u, "an upper-case letter"],
};
const RESERVED_WORDS = new Set(["if", "then", "else", "case", "of", "let", "in", "type", "module", "where", "import", "exposing", "as", "port"]);
function assertName(kind, name, letterCase) {
  const [pattern, first] = NAMES[letterCase];
  if (!pattern.test(name)) {
    throw new ToolError(`"${name}" is no name for a ${kind}. It has to start with ${first} and hold only letters, digits and underscores`);
  }
  if (RESERVED_WORDS.has(name)) {
    throw new ToolError(`"${name}" is no name for a ${kind}. It is one of Elm's reserved words`);
  }
}

async function applyEdits(changes, client, workspaceRoot) {
  const applied = await applyWorkspaceEdit(changes, client, workspaceRoot);
  return {
    fileCount: applied.length,
    totalEdits: applied.reduce((sum, a) => sum + a.edits, 0),
    summary: applied.slice(0, 20).map((a) => `  ${a.path}: ${a.edits} edits`).join("\n"),
  };
}

// Constructor usages that block or survive a variant removal, with call chains.
function formatConstructorUsages(usages) {
  const shown = usages.slice(0, 10).map((usage, index) => {
    let text = `  ${index + 1}. ${usage.module_name}.${usage.function_name || "(top-level)"}:${usage.line + 1}\n`;
    text += `     Context: "${usage.context}"\n`;

    if (usage.call_chain && usage.call_chain.length > 0) {
      text += `     Call chain:\n`;
      usage.call_chain.forEach((call, depth) => {
        const marker = call.is_entry_point ? " [ENTRY]" : "";
        text += `${"       " + "  ".repeat(depth)}→ ${call.module_name}.${call.function}:${call.line + 1}${marker}\n`;
      });
    }
    return text;
  });

  const more = usages.length > 10 ? `\n  ... and ${usages.length - 10} more usages` : "";
  return shown.join("\n") + more;
}

// elm_rename_variant, elm_rename_type and elm_rename_function differ only in
// the server command and in wording.
function renameTool({ kind, command, description, fileDescription }) {
  return {
    name: `elm_rename_${kind}`,
    title: `Rename ${kind}`,
    readOnly: false,
    description,
    input: {
      file_path: elmFile(fileDescription),
      ...position(`${kind} name`),
      old_name: z.string().describe(`Expected current ${kind} name (must match what's at the position)`),
      newName: z.string().describe(`The new name for the ${kind}`),
    },
    async run({ file_path, line, character, old_name, newName }) {
      assertName(kind, newName, kind === "function" ? "lower" : "upper");
      const { client, uri, workspaceRoot } = await openElmFile(file_path);

      const result = await client.executeCommand(command, [uri, line, character, newName]);
      assertExpectedName(kind, old_name, result?.oldName, line, result?.error);
      if (!result.success) {
        throw new ToolError(`Error: ${result.error}`);
      }
      if (!result.changes) {
        return result.message || `${kind[0].toUpperCase()}${kind.slice(1)} renamed successfully`;
      }

      const { fileCount, totalEdits, summary } = await applyEdits(result.changes, client, workspaceRoot);
      const owner = kind === "variant" ? ` in type ${result.typeName}` : "";
      return (
        `Renamed ${kind} "${result.oldName}" to "${result.newName}"${owner}\n` +
        `Applied ${totalEdits} edit(s) in ${fileCount} file(s):\n${summary}`
      );
    },
  };
}

// True when something is at `path` and it is not the entry at `original`. On
// a file system that ignores case, Api.elm and API.elm name one file, and
// renaming it from one spelling to the other must stay possible: the disk
// spells the two alike. Two links to one file are two entries, and so are two
// names of one file. Neither may replace the other.
function isAnotherFile(path, original) {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined && asSpelledOnDisk(path) !== asSpelledOnDisk(original);
}

// Taking an entry out of a directory and putting one into another both need
// write and search permission on the directory. The target directory may not
// exist yet, and then its nearest ancestor that does has to take a new entry.
function assertCanRelocate(oldPath, newPath, verb) {
  let target = dirname(newPath);
  while (!existsSync(target) && dirname(target) !== target) {
    target = dirname(target);
  }
  for (const directory of new Set([dirname(oldPath), target])) {
    try {
      if (!statSync(directory).isDirectory()) throw new Error("it is not a directory");
      accessSync(directory, constants.W_OK | constants.X_OK);
    } catch (error) {
      throw new ToolError(`Cannot ${verb} file: nothing can be changed in ${directory}, so no file was changed. ${error.message}`);
    }
  }
}

// Shared by elm_rename_file and elm_move_file. The server returns the edits
// for the module declaration and every import, then the file itself is moved
// here. `verb` and `done` word the messages, as in "rename" and "Renamed".
async function relocateFile({ file_path, command, target, verb, done }) {
  const { client, uri, workspaceRoot } = await openElmFile(file_path);

  const result = await client.executeCommand(command, [uri, target]);
  if (!result) {
    throw new ToolError(`Failed to ${verb} file`);
  }
  if (!result.success) {
    throw new ToolError(`Error: ${result.error}`);
  }
  if (!result.changes) {
    return "No changes needed";
  }
  // rename() below would replace another file without a word
  if (isAnotherFile(result.newPath, result.oldPath)) {
    throw new ToolError(`Cannot ${verb} file: ${result.newPath} already exists`);
  }
  // The file itself moves last, after the edits. Whether it can move is found out now, while nothing has changed.
  assertCanRelocate(result.oldPath, result.newPath, verb);

  const { fileCount, totalEdits } = await applyEdits(result.changes, client, workspaceRoot);

  try {
    await mkdir(dirname(result.newPath), { recursive: true });
    await rename(result.oldPath, result.newPath);
  } catch (err) {
    throw new ToolError(
      `Applied ${totalEdits} edit(s) but failed to ${verb} file: ${err.message}\n` +
        `Please manually ${verb} ${result.oldPath} to ${result.newPath}`
    );
  }
  await client.executeCommand("elm.notifyFileRenamed", [result.oldPath, result.newPath]);

  return (
    `${done} ${result.oldModuleName} to ${result.newModuleName}\n` +
    `- ${done} file: ${result.oldPath} → ${result.newPath}\n` +
    `- Updated module declaration\n` +
    `- Updated ${result.filesUpdated} import(s) in ${fileCount} file(s)`
  );
}

// The arguments that name a file of the project a call is about. Every tool has one of them.
export const PATH_ARGUMENTS = ["file_path", "new_path", "old_path"];

// The Elm project a call is about, from the file it names. Null when it names none.
// A project that is reached through a link is the same project under another spelling,
// so it is known by where it really is.
function projectOf(args) {
  for (const path of PATH_ARGUMENTS.map((name) => args[name]).filter((path) => typeof path === "string")) {
    const root = findWorkspaceRoot(resolve(path));
    // As the disk spells it, so that two spellings of one root take turns
    if (root) return realpathSync.native(root);
  }
  return null;
}

// How long elm-format may take. It runs in its project's turn, and a hung one would hold every later call.
const FORMAT_TIMEOUT_MS = 30_000;

// The last call for each project, by the real path of its root
const turns = new Map();

/**
 * Run a tool with its arguments. The calls for one project run one at a time,
 * in the order they came. Each one brings the index in step with the disk,
 * computes its edits from that and writes them. A second call that did the
 * same in between would write its edits into text the first has just changed.
 * A harness may send calls together, and an HTTP server has several clients.
 */
export function runInTurn(tool, args) {
  const root = projectOf(args);
  if (root === null) return tool.run(args);

  const call = (turns.get(root) ?? Promise.resolve()).then(() => tool.run(args));
  const over = call.then(
    () => {},
    () => {}
  );
  turns.set(root, over);
  over.then(() => {
    if (turns.get(root) === over) turns.delete(root);
  });
  return call;
}

export const tools = [
  {
    name: "elm_definition",
    title: "Go to definition",
    readOnly: true,
    description: "Go to the definition of a symbol",
    input: { file_path: elmFile(), ...position() },
    async run({ file_path, line, character }) {
      const { client, uri } = await openElmFile(file_path);

      const result = await client.getDefinition(uri, line, character);
      const location = Array.isArray(result) ? result[0] : result;
      return location ? `Definition at ${formatLocation(location)}` : "No definition found";
    },
  },

  {
    name: "elm_references",
    title: "Find references",
    readOnly: true,
    description: "Find all references to a symbol across the project",
    input: { file_path: elmFile(), ...position() },
    async run({ file_path, line, character }) {
      const { client, uri } = await openElmFile(file_path);

      const result = await client.getReferences(uri, line, character);
      if (!result || result.length === 0) {
        return "No references found";
      }

      const refs = result.map(formatLocation);
      const more = refs.length > 50 ? `\n... and ${refs.length - 50} more` : "";
      return `Found ${refs.length} references:\n${refs.slice(0, 50).join("\n")}${more}`;
    },
  },

  {
    name: "elm_symbols",
    title: "List file symbols",
    readOnly: true,
    description: "Get all symbols in an Elm file with optional pagination",
    input: {
      file_path: elmFile(),
      offset: wholeNumber("Number of symbols to skip (default: 0)").optional(),
      limit: wholeNumber("Maximum number of symbols to return (default: 50)").optional(),
    },
    async run({ file_path, offset = 0, limit = 50 }) {
      const { client, uri } = await openElmFile(file_path);

      const result = await client.getSymbols(uri);
      if (!result || result.length === 0) {
        return "No symbols found";
      }

      const total = result.length;
      const symbols = result.slice(offset, offset + limit).map((s) => {
        const kind = SYMBOL_KIND_NAMES[s.kind] || `Kind${s.kind}`;
        return `${s.name} (${kind}) at line ${(symbolLine(s) ?? 0) + 1}`;
      });

      let text = `Found ${total} symbols`;
      if (offset > 0 || total > limit) {
        text += ` (showing ${offset + 1}-${Math.min(offset + limit, total)})`;
      }
      text += `:\n${symbols.join("\n")}`;
      if (offset + limit < total) {
        text += `\n... use offset=${offset + limit} to see more`;
      }
      return text;
    },
  },

  {
    name: "elm_format",
    title: "Format file",
    readOnly: false,
    description: "Format an Elm file using elm-format",
    input: { file_path: elmFile() },
    async run({ file_path }) {
      // elm-format formats every Elm file below a directory, and needs no project for a file. It
      // gets an absolute path, which it cannot read as an option.
      const absPath = existingFile(file_path);
      if (!absPath.endsWith(".elm")) {
        throw new ToolError(`Cannot format ${absPath}: the name of an Elm file ends in .elm`);
      }
      // The server does not implement formatting. execFile keeps the path out of a shell.
      const directory = dirname(absPath);
      const env = { ...process.env, PATH: toolPath(directory) };
      try {
        await execFileAsync("elm-format", ["--yes", absPath], { env, timeout: FORMAT_TIMEOUT_MS });
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new ToolError(`elm-format is not on PATH.${projectToolsHint(directory, ["elm-format"])}`);
        }
        if (error.killed) {
          throw new ToolError(`Error formatting: elm-format did not finish within ${FORMAT_TIMEOUT_MS / 1000} seconds`);
        }
        throw new ToolError(`Error formatting: ${error.message}`);
      }
      return `Successfully formatted ${absPath}`;
    },
  },

  {
    name: "elm_diagnostics",
    title: "Compiler diagnostics",
    readOnly: true,
    // The compiler downloads packages that are not in its cache yet
    openWorld: true,
    description:
      "Compile an Elm file and the modules it imports, and get the file's errors. Errors in other files that stop the build are listed by file, line and title. " +
      "Modules that import the file are not compiled, so ask for the project's entry module to check the whole project.",
    input: { file_path: elmFile() },
    async run({ file_path }) {
      const { client, uri, workspaceRoot } = await connect(file_path);

      const result = await client.getDiagnostics(uri);
      // Without a verdict from the compiler the answer must not read like a clean build
      if (!result || result.error) {
        const hint = result?.noCompiler ? projectToolsHint(workspaceRoot, ["elm", "lamdera"]) : "";
        throw new ToolError((result?.error ?? "The language server sent no diagnostics") + hint);
      }

      const own = result.diagnostics.map((d) => {
        const line = d.range?.start?.line ?? 0;
        const col = d.range?.start?.character ?? 0;
        return `Line ${line + 1}:${col + 1} - ${d.message}`;
      });
      // The compiler stops at the first modules that fail, which need not include this file
      const elsewhere = (result.elsewhere ?? []).map((p) => `  ${p.path}:${p.line} - ${p.title}`);
      if (elsewhere.length === 0) {
        return own.length > 0 ? own.join("\n\n") : "No errors or warnings";
      }

      const listed = elsewhere.slice(0, MAX_ERRORS_ELSEWHERE);
      if (elsewhere.length > listed.length) {
        listed.push(`  ... and ${elsewhere.length - listed.length} more`);
      }
      const heading =
        own.length > 0
          ? "Errors in other files:"
          : "No errors in this file, but the project does not compile. Errors in other files:";
      return [...own, [heading, ...listed].join("\n")].join("\n\n");
    },
  },

  {
    name: "elm_code_actions",
    title: "List code actions",
    readOnly: true,
    description: "Get available code actions for a range in an Elm file",
    input: { file_path: elmFile(), ...rangeFields },
    async run({ file_path, start_line, start_char, end_line, end_char }) {
      const { client, uri } = await openElmFile(file_path);

      const result = await client.getCodeActions(uri, start_line, start_char, end_line, end_char);
      if (!result || result.length === 0) {
        return "No code actions available";
      }
      return `Available code actions:\n${result.map((a) => `- ${a.title}`).join("\n")}`;
    },
  },

  {
    name: "elm_apply_code_action",
    title: "Apply code action",
    readOnly: false,
    description: "Apply a code action to an Elm file",
    input: {
      file_path: elmFile(),
      ...rangeFields,
      action_title: z.string().describe("Title of the code action to apply"),
    },
    async run({ file_path, start_line, start_char, end_line, end_char, action_title }) {
      const { client, uri, workspaceRoot } = await openElmFile(file_path);

      const result = await client.getCodeActions(uri, start_line, start_char, end_line, end_char);
      if (!result || result.length === 0) {
        throw new ToolError("No code actions available");
      }

      const action = result.find((a) => a.title === action_title);
      if (!action) {
        const available = result.map((a) => a.title).join(", ");
        throw new ToolError(`Action "${action_title}" not found. Available: ${available}`);
      }
      if (!action.edit?.changes) {
        throw new ToolError(`Action "${action_title}" has no edits to apply`);
      }

      const applied = await applyWorkspaceEdit(action.edit.changes, client, workspaceRoot);
      const summary = applied.map((a) => `${a.path}: ${a.edits} edits`).join("\n");
      return `Applied "${action_title}":\n${summary}`;
    },
  },

  renameTool({
    kind: "variant",
    command: "elm.renameVariant",
    description:
      "Rename a custom type variant (constructor) across the entire project. Fails if position is not on a variant.",
    fileDescription: "Path to the Elm file containing the type definition",
  }),

  renameTool({
    kind: "type",
    command: "elm.renameType",
    description:
      "Rename a type (custom type or type alias) across the entire project. Fails if position is not on a type definition.",
    fileDescription: "Path to the Elm file containing the type definition",
  }),

  renameTool({
    kind: "function",
    command: "elm.renameFunction",
    description: "Rename a function across the entire project. Fails if position is not on a function definition.",
    fileDescription: "Path to the Elm file containing the function",
  }),

  {
    name: "elm_rename_field",
    title: "Rename field",
    readOnly: false,
    description: "Rename a record field across the entire project (type-aware). Fails if position is not on a field.",
    input: {
      file_path: elmFile(),
      line: wholeNumber("Line number of the field (0-indexed)"),
      character: column("Character position within the field name"),
      old_name: z.string().describe("Expected current field name (must match what's at the position)"),
      newName: z.string().describe("The new name for the field"),
    },
    async run({ file_path, line, character, old_name, newName }) {
      assertName("field", newName, "lower");
      const { client, uri, workspaceRoot } = await openElmFile(file_path);

      // prepareRename reports what sits at the position without changing anything
      const prepared = await client.prepareRename(uri, line, character);
      if (!prepared) {
        throw new ToolError(`No field found at line ${line + 1}. Expected: ${old_name}`);
      }
      assertExpectedName("field", old_name, prepared.placeholder || "", line);

      // The standard LSP rename detects fields by itself
      const result = await client.rename(uri, line, character, newName);
      if (!result || !result.changes) {
        throw new ToolError("No field found at this position or rename not possible");
      }

      const { fileCount, totalEdits, summary } = await applyEdits(result.changes, client, workspaceRoot);
      return `Renamed field "${old_name}" to "${newName}" in ${fileCount} files (${totalEdits} total edits):\n${summary}`;
    },
  },

  {
    name: "elm_move_function",
    title: "Move function",
    readOnly: false,
    description:
      "Move a function from one module to another. Imports that list it by name, as in " +
      "`import Utils exposing (greet)`, are pointed at the new module. Uses by qualified name, " +
      "through an alias or through `exposing (..)` stay as they were, and so do the target module's " +
      "own import of the function, the imports the function needs and the functions of its old module that it calls. " +
      "The move also reports success where a name in the function and one in the target shadow each other, which the compiler refuses, " +
      "as moving `f` into a module with `x f = f 0` does. Run elm_diagnostics on the project's entry module afterwards",
    input: {
      file_path: elmFile("Path to the source file containing the function"),
      line: wholeNumber("A line of the function, from its type signature to the end of its body (0-indexed)"),
      character: wholeNumber("Character position on that line (0-indexed). Not needed: the function is found by its line").optional(),
      function_name: z.string().describe("Expected function name (must match the function on that line)"),
      target_module: z.string().describe('Path to the target module file (e.g., "src/Utils/Helpers.elm")'),
    },
    async run({ file_path, line, function_name, target_module }) {
      // Spelled as the disk spells it before anything is asked of it, as file_path is
      const absTargetModule = asSpelledOnDisk(resolve(target_module));
      const { workspaceRoot } = locate(file_path);
      assertInProject(absTargetModule, workspaceRoot);
      if (!existsSync(absTargetModule)) {
        throw new ToolError(`Target module does not exist: ${target_module}`);
      }

      const { client, uri, absPath, content } = await openElmFile(file_path);
      const symbols = (await client.getSymbols(uri)) ?? [];
      // In lines that the parser could not read, the symbols lack a function, or give its lines to another
      // one. A bracket that is left open can leave a whole file without a symbol.
      const unread = await client.getUnreadRanges(uri);
      const around = symbols.length === 0 ? unread : unread.filter(({ start, end }) => start.line <= line && line <= end.line);
      if (around.length > 0) {
        throw unreadError(absPath, function_name, around[0].start.line, around.at(-1).end.line);
      }
      if (symbols.length === 0) {
        throw new ToolError("No symbols found in file");
      }

      // A function is found by any of its lines, from its type signature to the end of its body.
      // Only one that is declared at the top of the file can move. A type is none, and neither is
      // a binding of a let, which the language server lists as a function too.
      const func = symbols.find((s) => {
        const { start, end } = symbolRange(s);
        return SYMBOL_KIND_NAMES[s.kind] === "Function" && start.character === 0 && start.line <= line && line <= end.line;
      });
      if (!func) {
        // A function whose type signature stands below its definition begins below where it ends,
        // so none of its lines is found
        const below = symbols.find((s) => {
          const { start, end } = symbolRange(s);
          return SYMBOL_KIND_NAMES[s.kind] === "Function" && s.name === function_name && start.character === 0 && end.line < start.line;
        });
        if (below) throw signatureBelowError(absPath, function_name, symbolLine(below));
        throw new ToolError(`No function found at line ${line + 1}. Expected: ${function_name}`);
      }
      assertExpectedName("function", function_name, func.name, line);

      // The language server puts a function together from its type signature and its definition by
      // their name, wherever in the file the two stand. Where the signature stands apart from the
      // definition, or the file defines the name twice, the function reaches over the declarations in
      // between. No file that compiles has two declarations that share a line.
      const { start, end } = symbolRange(func);
      const sharing = symbols.find((other) => {
        const range = symbolRange(other);
        return other !== func && range.start.character === 0 && range.start.line <= end.line && start.line <= range.end.line;
      });
      if (sharing) {
        throw sharedLinesError(absPath, func.name, sharing.name, symbolRange(sharing));
      }

      // Where the declaration above it ends. The comments of this one stand between the two.
      const before = symbols
        .map(symbolRange)
        .filter(({ start, end }) => start.character === 0 && end.line < symbolLine(func))
        .map(({ end }) => end)
        .sort((one, other) => one.line - other.line || one.character - other.character)
        .at(-1);

      return moveFunction({
        client,
        workspaceRoot,
        absPath,
        absTargetModule,
        sourceContent: content,
        functionName: func.name,
        first: symbolLine(func),
        last: symbolRange(func).end,
        before,
        unread,
      });
    },
  },

  {
    name: "elm_prepare_remove_variant",
    title: "Preview variant removal",
    readOnly: true,
    description:
      "Check if a variant can be removed from a custom type. Returns variant info, usage count, and other variants for reference. Constructor usages will be replaced with Debug.todo.",
    input: {
      file_path: elmFile("Path to the Elm file containing the type definition"),
      ...position("variant name"),
      variant_name: z
        .string()
        .optional()
        .describe("Expected variant name (if provided, validates it matches what's at the position)"),
    },
    async run({ file_path, line, character, variant_name }) {
      const { client, uri } = await openElmFile(file_path);

      const result = await client.executeCommand("elm.prepareRemoveVariant", [uri, line, character]);
      if (!result || !result.success) {
        throw new ToolError(result?.error || `No variant found at line ${line + 1}`);
      }
      if (variant_name) {
        assertExpectedName("variant", variant_name, result.variantName, line);
      }

      const blockingUsages = result.blockingUsages || [];
      const patternUsages = result.patternUsages || [];
      const blockingCount = result.blockingCount || 0;
      const patternCount = result.patternCount || 0;

      let text =
        `Variant: ${result.variantName} (${result.variantIndex + 1}/${result.totalVariants} in type ${result.typeName})\n` +
        `Other variants: [${result.otherVariants?.join(", ") || "none"}]\n`;

      if (blockingCount > 0) {
        text += `Constructor usages (replaced with Debug.todo): ${blockingCount}\n`;
      }
      if (patternCount > 0) {
        text += `Pattern usages (auto-removable): ${patternCount}\n`;
      }
      if (blockingCount === 0 && patternCount === 0) {
        text += `Usages: 0\n`;
      }

      text += `Can remove: ${result.canRemove ? "Yes" : "No"}`;
      if (!result.canRemove && result.totalVariants <= 1) {
        text += " (only variant)";
      }
      text += `\nLine: ${result.range.start.line + 1}:${result.range.start.character}`;

      if (blockingUsages.length > 0) {
        text += `\n\nConstructor usages (will be replaced with Debug.todo):\n`;
        text += formatConstructorUsages(blockingUsages);
      }

      if (patternUsages.length > 0 && result.canRemove) {
        text += `\n\nPattern branches to auto-remove:\n`;
        text += patternUsages
          .slice(0, 10)
          .map((u, idx) => `  ${idx + 1}. ${u.module_name}.${u.function_name || "(top-level)"}:${u.line + 1} → "${u.context}"`)
          .join("\n");
        if (patternUsages.length > 10) {
          text += `\n  ... and ${patternUsages.length - 10} more branches`;
        }
      }

      return text;
    },
  },

  {
    name: "elm_remove_variant",
    title: "Remove variant",
    readOnly: false,
    description:
      "Remove a variant from a custom type. Constructor usages are replaced with Debug.todo, pattern matches are removed.",
    input: {
      file_path: elmFile("Path to the Elm file containing the type definition"),
      ...position("variant name"),
      variant_name: z.string().describe("Expected variant name (must match what's at the position)"),
    },
    async run({ file_path, line, character, variant_name }) {
      const { client, uri, workspaceRoot } = await openElmFile(file_path);

      const result = await client.executeCommand("elm.removeVariant", [uri, line, character]);
      assertExpectedName("variant", variant_name, result?.variantName, line, result?.error);

      if (!result.success) {
        throw new ToolError(
          `Cannot remove variant '${result.variantName}' from type ${result.typeName}\n` +
            `Reason: ${result.error}\n\n` +
            `Other variants you can use instead: [${result.otherVariants?.join(", ") || "none"}]\n\n` +
            `Blocking usages:\n${formatConstructorUsages(result.blockingUsages || [])}`
        );
      }
      if (!result.changes) {
        return result.message || "Variant removed successfully";
      }

      const { fileCount, totalEdits } = await applyEdits(result.changes, client, workspaceRoot);
      const message = result.message || `Removed variant '${result.variantName}' from type ${result.typeName}`;
      return `Successfully: ${message}\nApplied ${totalEdits} edit(s) in ${fileCount} file(s)`;
    },
  },

  {
    name: "elm_rename_file",
    title: "Rename file",
    readOnly: false,
    description: "Rename an Elm file and update its module declaration + all imports across the project",
    input: {
      file_path: elmFile("Path to the Elm file to rename"),
      new_name: z.string().describe('New filename (just the name, e.g., "NewName.elm")'),
    },
    async run({ file_path, new_name }) {
      if (!new_name.endsWith(".elm")) {
        throw new ToolError("New name must end with .elm");
      }
      // The file stays in its directory. A path here could also lead out of the project.
      if (basename(new_name) !== new_name) {
        throw new ToolError("New name must be a file name without a directory. elm_move_file moves a file to another directory.");
      }
      return relocateFile({ file_path, command: "elm.renameFile", target: new_name, verb: "rename", done: "Renamed" });
    },
  },

  {
    name: "elm_move_file",
    title: "Move file",
    readOnly: false,
    description:
      "Move an Elm file to a new location and update its module declaration + all imports across the project",
    input: {
      file_path: elmFile("Path to the Elm file to move"),
      target_path: z
        .string()
        .describe('Where the file goes: an absolute path, or one relative to the project root, the directory with elm.json (e.g., "src/Utils/Helper.elm")'),
    },
    async run({ file_path, target_path }) {
      if (!target_path.endsWith(".elm")) {
        throw new ToolError("Target path must end with .elm");
      }

      // A relative target starts at the project root, unlike every other path, so
      // that "src/Utils/Helper.elm" means the same wherever the server was started.
      // One with ".." in it, or through a linked directory, could lead out of the project.
      const { workspaceRoot } = locate(file_path);
      // The directories on the way are spelled as the disk has them, so that "src/API" names the
      // module Api where the directory is src/Api. The file's own name is the caller's to choose.
      const given = resolve(workspaceRoot, target_path);
      const absTarget = join(asSpelledOnDisk(dirname(given)), basename(given));
      assertInProject(absTarget, workspaceRoot);
      return relocateFile({ file_path, command: "elm.moveFile", target: absTarget, verb: "move", done: "Moved" });
    },
  },

  {
    name: "elm_notify_file_changed",
    title: "Notify of moved file",
    readOnly: true,
    description: "Notify the LSP that a file was renamed/moved (updates internal index without restarting)",
    input: {
      old_path: z.string().describe("Original file path"),
      new_path: z.string().describe("New file path"),
    },
    async run({ old_path, new_path }) {
      const absOldPath = asSpelledOnDisk(resolve(old_path));
      const absNewPath = asSpelledOnDisk(resolve(new_path));
      const workspaceRoot = findWorkspaceRoot(absNewPath) || findWorkspaceRoot(absOldPath);
      if (!workspaceRoot) {
        throw new ToolError(noProject(absNewPath));
      }

      const client = await ensureClient(workspaceRoot);
      const result = await client.executeCommand("elm.notifyFileRenamed", [absOldPath, absNewPath]);
      if (!result?.success) {
        throw new ToolError(`Error: ${result?.error ?? "the language server did not take the change"}`);
      }
      return `Notified LSP about file change: ${old_path} → ${new_path}`;
    },
  },

  {
    name: "elm_generate_erd",
    title: "Generate ERD",
    readOnly: false,
    description:
      "Generate a Mermaid ERD (Entity-Relationship Diagram) from an Elm type alias. " +
      "Recursively includes all referenced types with inferred cardinality relationships. " +
      "List/Dict/Set → one-to-many, Maybe → optional, direct reference → one-to-one.",
    input: {
      file_path: elmFile("Path to the Elm file containing the type definition"),
      type_name: z.string().describe("Name of the type to generate ERD for (e.g., 'BackendModel')"),
    },
    async run({ file_path, type_name }) {
      const { client, uri, workspaceRoot } = await openElmFile(file_path);

      const result = await client.executeCommand("elm.generateErd", [uri, type_name]);
      if (!result?.success) {
        throw new ToolError(`Failed to generate ERD: ${result?.error || "Unknown error"}`);
      }

      const erdPath = join(workspaceRoot, "erd.mmd");
      writeFileSync(erdPath, result.mermaid, "utf-8");

      let summary = `ERD saved to: ${erdPath}\n\n`;
      summary += `**Entities:** ${result.entities} | **Relationships:** ${result.relationships}`;
      if (result.warnings && result.warnings.length > 0) {
        summary += `\n\n**Warnings:**\n${result.warnings.map((w) => `- ${w}`).join("\n")}`;
      }
      return summary;
    },
  },

  {
    name: "elm_prepare_remove_field",
    title: "Preview field removal",
    readOnly: true,
    description:
      "Check if a field can be removed from a type alias. Returns field info, usage count, and other fields for reference. " +
      "Field accesses will be replaced with Debug.todo, record patterns will have the field removed or become _ if it's the only field.",
    input: {
      file_path: elmFile("Path to the Elm file containing the type definition"),
      ...position("field name"),
      field_name: z
        .string()
        .optional()
        .describe("Expected field name (if provided, validates it matches what's at the position)"),
    },
    async run({ file_path, line, character, field_name }) {
      const { client, uri } = await openElmFile(file_path);

      const result = await client.executeCommand("elm.prepareRemoveField", [uri, line, character]);
      if (!result || !result.success) {
        throw new ToolError(result?.error || `No field found at line ${line + 1}`);
      }
      if (field_name) {
        assertExpectedName("field", field_name, result.fieldName, line);
      }

      let summary = `**Type:** ${result.typeName}\n`;
      summary += `**Field:** ${result.fieldName}\n`;
      summary += `**Other fields:** ${result.otherFields?.join(", ") || "none"}\n`;
      summary += `**Can remove:** ${result.canRemove ? "Yes" : "No (only field)"}\n\n`;

      summary += `**Usage Summary:**\n`;
      summary += `- Definition: ${result.definitionCount || 0}\n`;
      summary += `- Field accesses (.field): ${result.fieldAccessCount || 0} (will be replaced with Debug.todo)\n`;
      summary += `- Field accessors (.field as function): ${result.fieldAccessorCount || 0} (will be replaced with Debug.todo)\n`;
      summary += `- Record patterns ({ field }): ${result.recordPatternCount || 0} (will be removed from pattern)\n`;
      summary += `- Record literals ({ field = value }): ${result.recordLiteralCount || 0} (will be removed)\n`;
      summary += `- Record updates ({ x | field = value }): ${result.recordUpdateCount || 0} (will be removed)\n`;
      summary += `- **Total:** ${result.totalUsages || 0}\n`;

      summary += result.canRemove
        ? `\n✓ Ready to remove. Use elm_remove_field to execute.`
        : `\n⚠️ Cannot remove: This is the only field in the type alias.`;
      return summary;
    },
  },

  {
    name: "elm_remove_field",
    title: "Remove field",
    readOnly: false,
    description:
      "Remove a field from a type alias. Field accesses are replaced with Debug.todo, record patterns have the field removed " +
      "(or become _ if it's the only field), and record literals/updates have the field removed.",
    input: {
      file_path: elmFile("Path to the Elm file containing the type definition"),
      ...position("field name"),
      field_name: z.string().describe("Expected field name (must match what's at the position)"),
    },
    async run({ file_path, line, character, field_name }) {
      const { client, uri, workspaceRoot } = await openElmFile(file_path);

      const result = await client.executeCommand("elm.removeField", [uri, line, character]);
      assertExpectedName("field", field_name, result?.fieldName, line, result?.error);

      if (!result.success) {
        throw new ToolError(
          `Cannot remove field '${result.fieldName}' from '${result.typeName}'.\n` +
            `Reason: ${result.error}\n` +
            `Other fields: ${result.otherFields?.join(", ") || "none"}`
        );
      }
      if (!result.changes) {
        return result.message || "Field removed successfully";
      }

      const { fileCount, totalEdits } = await applyEdits(result.changes, client, workspaceRoot);
      const message = result.message || `Removed field '${result.fieldName}'`;
      return `Successfully: ${message}\nApplied ${totalEdits} edit(s) in ${fileCount} file(s)`;
    },
  },

  {
    name: "elm_prepare_add_variant",
    title: "Preview variant addition",
    readOnly: true,
    description:
      "Check what would happen when adding a variant to a custom type. Returns existing variants and case expressions that would need new branches.",
    input: {
      file_path: elmFile("Path to the Elm file containing the type definition"),
      type_name: z.string().describe("Name of the custom type (e.g., 'Color')"),
      new_variant_name: z.string().describe("Name of the new variant to add (e.g., 'Purple')"),
    },
    async run({ file_path, type_name, new_variant_name }) {
      assertName("variant", new_variant_name, "upper");
      const { client, uri } = await openElmFile(file_path);

      const result = await client.executeCommand("elm.prepareAddVariant", [uri, type_name, new_variant_name]);
      if (!result || !result.success) {
        throw new ToolError(result?.message || `Type '${type_name}' not found`);
      }

      const caseExpressions = result.caseExpressions || [];
      const casesNeedingBranch = result.casesNeedingBranch || 0;

      let text =
        `Type: ${result.typeName}\n` +
        `New variant: ${result.variantName}\n` +
        `Existing variants: [${result.existingVariants?.join(", ") || "none"}]\n` +
        `Case expressions found: ${caseExpressions.length}\n` +
        `Cases needing new branch: ${casesNeedingBranch}\n`;

      if (caseExpressions.length > 0) {
        text += `\nCase expressions:\n`;
        caseExpressions.forEach((c, idx) => {
          const wildcard = c.has_wildcard ? " (has wildcard, no change needed)" : " (needs new branch)";
          text += `  ${idx + 1}. ${c.module_name}:${c.line + 1}${wildcard}\n`;
          text += `     Context: "${c.context}"\n`;
        });
      }

      if (casesNeedingBranch > 0) {
        text += `\n✓ Ready to add. Use elm_add_variant to execute.`;
      } else if (caseExpressions.length > 0) {
        text += `\nAll case expressions have wildcards - no pattern changes needed.`;
      }
      return text;
    },
  },

  {
    name: "elm_add_variant",
    title: "Add variant",
    readOnly: false,
    description:
      "Add a new variant to a custom type. Adds the variant to the type definition and inserts branches in case expressions. " +
      "Use branches to provide code and imports for each case expression (indexed by prepare_add_variant output). " +
      "If branches is provided, it must have exactly the same count as casesNeedingBranch from prepare_add_variant. " +
      "Branch format: 'AddDebug' for Debug.todo, {AddCode: 'expr'} for code, {AddCodeWithImports: {imports: [...], code: 'expr'}} for code + imports.",
    input: {
      file_path: elmFile("Path to the Elm file containing the type definition"),
      type_name: z.string().describe("Name of the custom type (e.g., 'Color')"),
      new_variant_name: z.string().describe("Name of the new variant to add (e.g., 'Purple')"),
      variant_args: z
        .string()
        .optional()
        .describe("Optional variant arguments (e.g., 'Int String' for 'Purple Int String')"),
      branches: z
        .array(
          z.union([
            z.literal("AddDebug").describe("Insert Debug.todo for this branch"),
            z.object({ AddCode: z.string() }).describe("Insert custom code expression"),
            z
              .object({
                AddCodeWithImports: z.object({
                  imports: z.array(z.string()).describe("Import statements (without 'import ' prefix)"),
                  code: z.string().describe("Code expression"),
                }),
              })
              .describe("Insert code with imports"),
          ])
        )
        .optional()
        .describe("Array of branch configs. Must match casesNeedingBranch count exactly."),
    },
    async run({ file_path, type_name, new_variant_name, variant_args, branches }) {
      // What the variant holds goes into variant_args, and a name with it in would be written as it is
      assertName("variant", new_variant_name, "upper");
      const { client, uri, workspaceRoot } = await openElmFile(file_path);

      // The server reads its arguments by position, so branches needs variant_args before it
      const args = [uri, type_name, new_variant_name];
      if (variant_args !== undefined || branches !== undefined) {
        args.push(variant_args || "");
      }
      if (branches !== undefined) {
        args.push(branches);
      }

      const result = await client.executeCommand("elm.addVariant", args);
      if (!result) {
        throw new ToolError(`Failed to add variant '${new_variant_name}' to type '${type_name}'`);
      }

      if (!result.success) {
        let text = `Cannot add variant '${new_variant_name}' to type '${type_name}'\nReason: ${result.message}`;
        // A branch count mismatch comes with the case expressions that need a branch
        if (result.prepareInfo) {
          text += `\n\nPrepare info (casesNeedingBranch: ${result.prepareInfo.casesNeedingBranch}):`;
          (result.prepareInfo.caseExpressions || []).forEach((c, i) => {
            if (!c.hasWildcard) {
              text += `\n  [${i}] ${c.moduleName}: ${c.context}`;
            }
          });
        }
        throw new ToolError(text);
      }
      if (!result.changes) {
        return result.message || "Variant added successfully";
      }

      const { fileCount, totalEdits } = await applyEdits(result.changes, client, workspaceRoot);
      return `Successfully: ${result.message}\nApplied ${totalEdits} edit(s) in ${fileCount} file(s)`;
    },
  },
];
