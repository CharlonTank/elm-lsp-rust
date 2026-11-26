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
import { indexOfColumn, projectDirectories, readForEdit, toFileUri, writeEdited } from "./workspace.mjs";

// A module declaration up to the parenthesis that opens its exposing list, for a module and for
// a port module. A part of the name holds letters of any script, digits and underscores.
const MODULE_DECLARATION = /^(?:port\s+)?module\s+([\p{L}\d_.]+)\s+exposing\s*\(/mu;

// The text with every comment turned into spaces, so that each character keeps its place. A
// block comment can hold another, and a line comment ends with its line. What a comment holds is
// then no part of what is read: a parenthesis, a comma, a line that reads like an import. A
// string is not told from code, which does no harm here, because the module declaration and the
// imports stand above the first string of a file, and nothing below them is read.
function withoutComments(text) {
  let code = "";
  let depth = 0;
  let at = 0;
  while (at < text.length) {
    if (text.startsWith("{-", at)) {
      depth++;
      code += "  ";
      at += 2;
    } else if (depth > 0 && text.startsWith("-}", at)) {
      depth--;
      code += "  ";
      at += 2;
    } else if (depth === 0 && text.startsWith("--", at)) {
      const lineEnd = text.indexOf("\n", at);
      const end = lineEnd === -1 ? text.length : lineEnd;
      code += " ".repeat(end - at);
      at = end;
    } else {
      code += depth > 0 && text[at] !== "\n" ? " " : text[at];
      at++;
    }
  }
  return code;
}

// The name that a file declares, as a module or as a port module.
function moduleNameOf(content, file) {
  const match = withoutComments(content).match(MODULE_DECLARATION);
  if (!match) throw new ToolError(`Cannot move function: ${file} declares no module`);
  return match[1];
}

// The exposing list whose parenthesis opens at `open` in `code`, a text without its comments:
// where its parentheses stand, and each item with the place it takes up between the commas and
// the place of its name in there. The list can lie on one line or on several, and an item such
// as Msg(..) has parentheses of its own. Nothing where the list does not close.
function listAt(code, open) {
  const items = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open; at < code.length; at++) {
    if (code[at] === "(") depth++;
    if (code[at] === ")") depth--;
    if (depth === 0 || (depth === 1 && code[at] === ",")) {
      const text = code.slice(start, at);
      items.push({ start, end: at, name: text.trim(), nameStart: at - text.trimStart().length, nameEnd: start + text.trimEnd().length });
      start = at + 1;
    }
    if (depth === 0) return { open, close: at, items };
  }
  return null;
}

// The exposing list of a module declaration, in a text without its comments
function declaredListIn(code) {
  const declaration = code.match(MODULE_DECLARATION);
  return declaration ? listAt(code, declaration.index + declaration[0].length - 1) : null;
}

// The exposing list of a file's module declaration
const declaredList = (content) => declaredListIn(withoutComments(content));

// A line that begins an import
const IMPORT = /^import(\s|$)/;

// Where the imports of a file stand, in a text without its comments: its lines, the first one
// below the module declaration, which ends where its exposing list closes, and the one on which
// the first declaration begins. That one starts in the first column and is no import. A line
// further down that reads like an import stands in a string.
function importLines(code) {
  const lines = code.split("\n");
  const list = declaredListIn(code);
  const from = list ? code.slice(0, list.close).split("\n").length : 0;
  const to = lines.findIndex((line, at) => at >= from && /^\S/.test(line) && !IMPORT.test(line));
  return { lines, from, to: to === -1 ? lines.length : to };
}

// The exposing lists of a file's imports of a module, each with the place where the word
// "exposing" stands. A file can import a module more than once, and an import can give the
// module another name on the way. One without such a list is none of these.
function importedLists(content, moduleName) {
  const code = withoutComments(content);
  const { lines, to } = importLines(code);
  const name = moduleName.replaceAll(".", "\\.");
  const imports = lines.slice(0, to).join("\n").matchAll(new RegExp(`^import\\s+${name}(?:\\s+as\\s+[\\p{L}\\d_]+)?\\s+(exposing\\s*\\()`, "gmu"));
  return [...imports].flatMap((found) => {
    const list = listAt(code, found.index + found[0].length - 1);
    return list ? [{ ...list, exposing: found.index + found[0].length - found[1].length }] : [];
  });
}

const indexIn = (list, name) => list.items.findIndex((item) => item.name === name);

// The text with `name` at the end of a list, or nothing where the list needs no change: it
// exposes everything, or the name already. Where the closing parenthesis has a line to itself,
// as elm-format lays out a long list, the name gets a line of its own above it. Elsewhere it
// follows the last name, in front of whatever stands between that one and the parenthesis.
function withItem(content, list, name) {
  if (list.items.some((item) => item.name === ".." || item.name === name)) return null;
  const lineStart = content.lastIndexOf("\n", list.close) + 1;
  const indent = content.slice(lineStart, list.close);
  const { nameEnd } = list.items.at(-1);
  return lineStart > list.open && indent.trim() === ""
    ? `${content.slice(0, lineStart)}${indent}, ${name}\n${content.slice(lineStart)}`
    : `${content.slice(0, nameEnd)}, ${name}${content.slice(nameEnd)}`;
}

// The text without the item at `index` of a list that holds more than this one. The comma in
// front of the item goes with it. Where the two have a line to themselves, as elm-format lays
// out a long list, that line goes too, with a comment that stands behind the name on it. The
// lines below stay: a list can hold comments, such as names that are commented out or the title
// of a group. An item that shares its line with another leaves the line and its end as they
// were, so that a list in groups keeps its groups. The first item of a list has no comma in
// front, so the comma behind it goes, and the next item moves up to the parenthesis. Where
// comments stand between the two, they stay on their lines, and so does the next item.
// Where the comma in front stands on a line above the name, what follows it there stays, as
// the other comment lines do: a comment behind the name above, in a list with its commas at
// the ends of the lines, or a comment that the comma puts in front of the name. The comma
// behind the name goes instead where it stands on the line of the name, and the comma in front
// stays with the name above. Elsewhere the comma in front goes after all: at the last name of
// such a list, and where the comma behind begins the line below, as in a list whose commas end
// some lines and begin others.
function withoutItem(content, list, index) {
  const item = list.items[index];
  // Where the line of the name ends, if the name is the last on it. A block comment that opens
  // behind the name and closes further down keeps the line in place.
  const lineEnd = content.indexOf("\n", item.nameEnd);
  const endsLine = lineEnd !== -1 && lineEnd < item.end && depthBehind(content.slice(item.nameEnd, lineEnd), 0) === 0;
  if (index === 0) {
    const next = list.items[1];
    const between = content.slice(endsLine ? lineEnd : item.nameEnd, item.end);
    if (between.trim() === "") return content.slice(0, item.nameStart) + content.slice(next.start).trimStart();
    return content.slice(0, item.nameStart).replace(/[ \t]+$/, "") + between + " " + content.slice(next.start);
  }
  const comma = item.start - 1;
  const lineStart = content.lastIndexOf("\n", comma) + 1;
  const nameLine = content.lastIndexOf("\n", item.nameStart) + 1;
  if (endsLine && nameLine === lineStart && content.slice(lineStart, comma).trim() === "") return content.slice(0, lineStart) + content.slice(lineEnd + 1);
  if (nameLine <= comma) return content.slice(0, comma) + content.slice(item.nameEnd);

  const next = list.items[index + 1];
  const commaBehind = next !== undefined && (lineEnd === -1 || item.end < lineEnd);
  const above = commaBehind ? content.slice(0, nameLine) : content.slice(0, comma) + content.slice(comma + 1, nameLine);
  // Nothing else on the line of the name: no other name in front of it or behind it, and no parenthesis
  const alone = content.slice(nameLine, item.nameStart).trim() === "" && lineEnd !== -1 && lineEnd < (next?.nameStart ?? list.close);
  if (alone && depthBehind(content.slice(item.nameEnd, lineEnd), 0) === 0) return above + content.slice(lineEnd + 1);
  const inFront = content.slice(nameLine, item.nameStart);
  return commaBehind ? above + inFront + content.slice(next.start).replace(/^[ \t]+/, "") : above + inFront + content.slice(item.nameEnd);
}

// The line on which the doc comment of the declaration at line `first` opens, or `first` where
// it has none. The doc comment of a declaration is the last one above it, with nothing but blank
// lines and other comments in between. `before` is where the declaration before it ends, which
// the language server gives. Without one this is the first declaration of its file, whose doc
// comment has to be told from the module's.
function withDocComment(lines, first, before) {
  if (before) return docCommentsIn(lines, before.line + 1, first, depthBehindToken(lines, before)).at(-1)?.open ?? first;
  const head = headOf(lines);
  return head.to === first ? (head.firstDoc?.open ?? first) : first;
}

// The last line of a function with the comments that close its body. The language server ends a
// function at its last token, a line and a column that it counts in bytes. Nothing but a comment
// can stand behind that in a file that compiles. A branch that is commented out below, or a
// note, is indented like the body and belongs to it. A block comment is taken whole, whatever
// column its later lines start in, and it can open behind the last token on that token's line.
// A comment that opens in the first column belongs to what follows.
function withClosingComments(lines, last) {
  let end = last.line;
  let depth = depthBehindToken(lines, last);
  for (let at = last.line + 1; at < lines.length; at++) {
    if (depth === 0 && lines[at].trim() === "") continue;
    if (depth === 0 && /^\S/.test(lines[at])) break;
    depth = depthBehind(lines[at], depth);
    end = at;
  }
  return end;
}

// How deep in block comments a line ends that begins `depth` deep. A block comment can hold
// another, and outside of one "--" makes a comment of the rest of the line.
function depthBehind(line, depth) {
  for (let at = 0; at < line.length; at++) {
    if (line.startsWith("{-", at)) {
      depth++;
      at++;
    } else if (depth > 0 && line.startsWith("-}", at)) {
      depth--;
      at++;
    } else if (depth === 0 && line.startsWith("--", at)) {
      break;
    }
  }
  return depth;
}

// How deep in block comments a line ends behind a token on it. The language server gives the
// end of the token by its line and a column in bytes. Nothing but a comment can open there.
const depthBehindToken = (lines, { line, character }) => depthBehind(lines[line].slice(indexOfColumn(lines[line], character)), 0);

// The doc comments that open in the lines `from` to `to`, a stretch that holds nothing but
// comments and begins `depth` deep in block comments. A doc comment opens with "{-|" in the
// first column, outside of any other comment. Each is told by the lines on which it opens and
// closes.
function docCommentsIn(lines, from, to, depth = 0) {
  const docs = [];
  for (let at = from; at < to; at++) {
    const open = depth === 0 && lines[at].startsWith("{-|") ? at : -1;
    depth = depthBehind(lines[at], depth);
    if (open === -1) continue;
    while (depth > 0 && at + 1 < to) {
      depth = depthBehind(lines[++at], depth);
    }
    docs.push({ open, close: at });
  }
  return docs;
}

// Whether a place in a file lies before another. The language server gives a place by its line
// and a column on it.
const liesBefore = (one, other) => one.line < other.line || (one.line === other.line && one.character < other.character);

// How an answer names the lines `low` to `high` of a file. An agent counts lines from 1 when it reads one.
const linesOf = (low, high) => (low === high ? `line ${low + 1}` : `lines ${low + 1} to ${high + 1}`);

// What a move answers where the language server could not read the lines `low` to `high` of a
// file, which holds the function
export function unreadError(file, functionName, low, high) {
  return new ToolError(
    `Cannot move function: the language server could not read ${linesOf(low, high)} of ${file}, so it cannot tell where "${functionName}" begins and ends. ` +
      "No file was changed. Run elm_diagnostics on the file. Where it compiles, those lines are laid out in a way that the parser does not know, and elm_format rewrites them"
  );
}

// What a move answers where the lines `low` to `high` above a function hold what the parser read
// and the symbols lack: a type signature that has no definition, in a file that is being edited,
// or what only a module of the core library declares, an operator or its effects. No layout is
// to blame there, and elm-format changes nothing about it.
function unlistedError(file, functionName, low, high) {
  return new ToolError(
    `Cannot move function: the language server finds no declaration in ${linesOf(low, high)} of ${file}, above "${functionName}", so it cannot tell where the function begins. ` +
      "No file was changed. Run elm_diagnostics on the file. Where it compiles, those lines declare what only the core library can, an operator for one"
  );
}

// What a move answers where the lines of a function hold another declaration, which the
// language server reads as the lines `start` to `end`.
export function sharedLinesError(file, functionName, otherName, { start, end }) {
  return new ToolError(
    `Cannot move function: "${functionName}" shares lines of ${file} with "${otherName}", which the language server reads as ${linesOf(start.line, end.line)}. ` +
      `A type signature there stands apart from its definition, or a name is defined twice, so it cannot tell where "${functionName}" begins and ends. ` +
      "No file was changed. Run elm_diagnostics on the file"
  );
}

// What a move answers where the type signature of a function stands below its definition, at
// line `signature`. The language server begins the function there and ends it with the
// definition, above where it begins, so no line of the file lies in between.
export function signatureBelowError(file, functionName, signature) {
  return new ToolError(
    `Cannot move function: the type signature of "${functionName}" stands below its definition, at line ${signature + 1} of ${file}, ` +
      `so the language server cannot tell where "${functionName}" begins and ends. No file was changed. Run elm_diagnostics on the file`
  );
}

// Stops the move of a function that the language server cannot place. Its parser does not know
// every layout that the compiler accepts, and it reads on through a file that does not compile.
// Around what it could not read, a declaration can run on into the next ones, lose its type
// signature and its doc comment to the one above, or be missing from the symbols, and a move
// by them would take the wrong lines. `unread` holds those stretches. One counts from the
// declaration before the function down to the function's end. That declaration can be the
// stretch itself, which then ends where the parser gave up. For the first declaration of a file
// everything above it counts, since its doc comment is told from the module's by those lines.
// Between the declaration before and the function nothing but comments can stand, so anything
// else is a declaration that the symbols lack, and so is one above the first of them.
function assertPlaced(lines, file, functionName, { first, last, before, unread }) {
  const from = before ?? { line: 0, character: 0 };
  const reached = unread
    .filter(({ start, end }) => !liesBefore(end, from) && !liesBefore(last, start))
    .flatMap(({ start, end }) => [start.line, end.line]);
  const unlisted = [];
  if (before) {
    const above = [lines[before.line].slice(indexOfColumn(lines[before.line], before.character)), ...lines.slice(before.line + 1, first)];
    unlisted.push(...withoutComments(above.join("\n")).split("\n").flatMap((line, at) => (line.trim() === "" ? [] : [before.line + at])));
  } else {
    const { to } = headOf(lines);
    if (to !== first) unlisted.push(Math.min(to, first));
  }
  if (reached.length > 0) {
    throw unreadError(file, functionName, Math.min(...reached, ...unlisted), Math.max(...reached, ...unlisted));
  }
  if (unlisted.length > 0) {
    throw unlistedError(file, functionName, Math.min(...unlisted), Math.max(...unlisted));
  }
}

// Where a module's doc comment lists names for the docs of a package
const DOCS = /@docs(?![\p{L}\d_])/u;

// What a file holds above its first declaration, which begins on line `to`: the module
// declaration, the imports, and comments. `firstImport` is the line of the first import, and
// `below` the line that an import can follow where there is none: the last one of the module
// declaration, or of a comment that it opens. Of the doc comments, the compiler takes the first
// one above the imports for the module's, and the last one above a declaration for that
// declaration's. With no import in between, the compiler takes a single doc comment for the
// module's as well. One that holds "@docs" documents the module, and a move takes it for the
// module's too. The compiler reads "@docs" anywhere in the comment, where no letter, digit or
// underscore follows it. Any other comment is taken for the declaration's where the
// declaration starts right below it, and for the module's where anything stands in between.
// That rule goes by the layout, the only sign there of what the author meant, and is a choice
// where the compiler reads the comment as the module's.
function headOf(lines) {
  const code = withoutComments(lines.join("\n"));
  const { lines: codeLines, from, to } = importLines(code);
  const firstImport = codeLines.findIndex((line, at) => at >= from && at < to && IMPORT.test(line));
  const lastImport = codeLines.findLastIndex((line, at) => at >= from && at < to && line.trim() !== "");

  let [below, depth] = [from - 1, 0];
  if (from > 0) {
    const close = declaredListIn(code).close;
    depth = depthBehind(lines[below].slice(close - code.lastIndexOf("\n", close)), 0);
    while (depth > 0 && below + 1 < to) {
      depth = depthBehind(lines[++below], depth);
    }
  }
  if (lastImport !== -1) {
    // No import holds a string, so the comments among the imports are counted as they stand
    for (let at = below + 1; at <= lastImport; at++) {
      depth = depthBehind(lines[at], depth);
    }
    return { to, firstImport, below, firstDoc: docCommentsIn(lines, lastImport + 1, to, depth).at(-1) };
  }
  const docs = docCommentsIn(lines, below + 1, to);
  const listsDocs = docs[0] !== undefined && DOCS.test(lines.slice(docs[0].open, docs[0].close + 1).join("\n"));
  const ofDeclaration = from === 0 || (docs[0]?.close + 1 === to && !listsDocs);
  return { to, firstImport, below, moduleDoc: ofDeclaration ? undefined : docs[0], firstDoc: ofDeclaration || docs.length > 1 ? docs.at(-1) : undefined };
}

// The lines with one more import. It goes in front of the first import. In a file that has
// none it goes below the module declaration and below the doc comment of the module: an import
// above that comment would make it the comment of the first declaration. A blank line stands
// in between. A caller that has changed the lines since hands in what headOf found before:
// without its first declaration, a file can read otherwise.
function withImport(lines, importLine, { firstImport, below, moduleDoc } = headOf(lines)) {
  if (firstImport !== -1) return [...lines.slice(0, firstImport), importLine, ...lines.slice(firstImport)];
  if (below === -1) return [importLine, ...lines];
  const last = moduleDoc?.close ?? below;
  return [...lines.slice(0, last + 1), "", importLine, ...lines.slice(last + 1)];
}

// The text with a name exposed from an import of a module: in the first exposing list of such
// an import, unless one of them has the name or everything already, and in an import of its own
// where the file has no such list.
function withExposed(content, moduleName, name, head) {
  const lists = importedLists(content, moduleName);
  if (lists.length === 0) return withImport(content.split("\n"), `import ${moduleName} exposing (${name})`, head).join("\n");
  return lists.map((list) => withItem(content, list, name)).includes(null) ? content : withItem(content, lists[0], name);
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
  const listing = (text) => importedLists(text, sourceModuleName).find((list) => indexIn(list, functionName) !== -1);
  if (!listing(content)) return null;

  // Drop the function from every import of the source that lists it, since a file can import a
  // module more than once. One that exposed nothing else stays without its list, because the
  // file can name the module by itself as well, as in Utils.greet.
  let without = content;
  for (let source = listing(without); source; source = listing(without)) {
    without =
      source.items.length > 1
        ? withoutItem(without, source, indexIn(source, functionName))
        : without.slice(0, source.exposing).trimEnd() + without.slice(source.close + 1);
  }

  // Expose it from an import of the target instead
  return withExposed(without, targetModuleName, functionName);
}

/**
 * Move the function that stands in absPath from the line `first` to the
 * place `last`, the end of its last token, into absTargetModule. `before`
 * is where the declaration before it ends, if there is one, and `unread`
 * holds the stretches of the file that the parser could not read. Resolves
 * with the summary shown to the agent.
 *
 * All four are the language server's, which reads them from the parse
 * tree, type signature included. A blank line inside the body ends nothing
 * there, and neither does a comment in the first column, while the function
 * that follows, its doc comment and a comment between sections are no part
 * of it. The function's own doc comment is, and moves with it, and so does
 * a comment that closes its body.
 */
export async function moveFunction({ client, workspaceRoot, absPath, absTargetModule, sourceContent, functionName, first, last, before, unread }) {
  const sourceLines = sourceContent.split("\n");
  assertPlaced(sourceLines, absPath, functionName, { first, last, before, unread });
  const targetContent = readForEdit(absTargetModule);
  const targetLines = targetContent.split("\n");

  const [start, end] = [withDocComment(sourceLines, first, before), withClosingComments(sourceLines, last)];
  const functionText = sourceLines.slice(start, end + 1).join("\n");
  const sourceModuleName = moduleNameOf(sourceContent, absPath);
  const targetModuleName = moduleNameOf(targetContent, absTargetModule);

  const targetUri = toFileUri(absTargetModule);
  await client.openDocument(targetUri, targetContent);
  const targetSymbols = await client.getSymbols(targetUri);
  if (targetSymbols?.some((s) => s.name === functionName)) {
    throw new ToolError(
      `Cannot move function: Target module '${targetModuleName}' already has a function named '${functionName}'`
    );
  }

  // Target: append the function two blank lines below the last line that holds something, and expose it
  let insertLine = targetLines.length;
  while (insertLine > 0 && targetLines[insertLine - 1].trim() === "") {
    insertLine--;
  }
  const appended = [...targetLines.slice(0, insertLine), "", "", functionText, ""].join("\n");
  const targetList = declaredList(appended);
  const exposed = targetList && withItem(appended, targetList, functionName);

  // Source: cut the function, import it from the target instead, and stop exposing it. The
  // blank lines above the function and below it meet where it stood. The longer of the two runs
  // stays, and at the end of the file no more than its last line end.
  const newSourceLines = [...sourceLines];
  newSourceLines.splice(start, end - start + 1);
  let [above, below] = [start, start];
  while (above > 0 && newSourceLines[above - 1].trim() === "") {
    above--;
  }
  while (below < newSourceLines.length && newSourceLines[below].trim() === "") {
    below++;
  }
  const blank = below === newSourceLines.length ? Math.min(below - start, 1) : Math.max(start - above, below - start);
  newSourceLines.splice(above, below - above, ...Array(blank).fill(""));
  // The head is read from the file as it was. With its first function gone, the doc comment of
  // the next one could pass for the module's, and the import would part the two.
  const cut = withExposed(newSourceLines.join("\n"), targetModuleName, functionName, headOf(sourceLines));
  const sourceList = declaredList(cut);
  const exposedAt = sourceList ? indexIn(sourceList, functionName) : -1;
  // A list has to hold something, so the only name in one stays
  const stays = exposedAt !== -1 && sourceList.items.length === 1;
  const hidden = exposedAt === -1 || stays ? cut : withoutItem(cut, sourceList, exposedAt);

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

  const written = [[absPath, hidden], [absTargetModule, exposed ?? appended], ...retargeted];
  writeEdited(written);
  for (const [filePath, content] of written) {
    await client.notifyFileChanged(toFileUri(filePath), content);
  }

  // A list that needed no change gets no line, such as one that exposes everything or one that never held the function
  const left = `- Left "${functionName}" in source module's exposing list, where it is the only name. A list cannot be empty, so change it yourself`;
  return [
    `Successfully moved "${functionName}" from ${sourceModuleName} to ${targetModuleName}.`,
    "- Removed function from source file",
    "- Added function to target file",
    exposedAt !== -1 && (stays ? left : "- Updated source module's exposing list"),
    exposed && "- Updated target module's exposing list",
    `- Updated imports in ${filesUpdated} other file(s).`,
  ]
    .filter(Boolean)
    .join("\n");
}
