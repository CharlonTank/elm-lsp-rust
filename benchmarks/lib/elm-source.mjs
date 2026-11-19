/**
 * A reading of Elm source files that needs no compiler and no language server.
 *
 * The benchmark picks its tasks and checks their outcome with this module, on
 * purpose without the language server it measures. It knows the few things it
 * has to: where comments and string literals are, that a top-level declaration
 * starts in column 0, and how a custom type and a record alias are put
 * together. How a declaration is spread over lines makes no difference.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { asSpelledOnDisk } from "../../mcp-wrapper/workspace.mjs";

// A name as the compiler takes it. Inside it stand letters of any script, the digits 0 to 9 and
// underscores. A module, a type and a variant start with an upper-case letter, a function and a
// field with a lower-case one. Café and été are names like any other.
const INNER = "[\\p{L}0-9_]";
export const UPPER_NAME = `[\\p{Lu}\\p{Lt}]${INNER}*`;
const LOWER_NAME = `\\p{Ll}${INNER}*`;
// Where a name starts and where it ends: no character of a name stands in front of it, or behind it
const NAME_START = `(?<!${INNER})`;
export const NAME_END = `(?!${INNER})`;
const MODULE_NAME = `${UPPER_NAME}(?:\\.${UPPER_NAME})*`;

// The head of a declaration: its first word in column 0, and its name behind any space, also on
// a line below. The colon of a type annotation can stand on a line below the name as well.
const MODULE_LINE = new RegExp(`^(?:port\\s+|effect\\s+)?module\\s+(${MODULE_NAME})`, "mu");
const IMPORT_LINE = new RegExp(`^import\\s+(${MODULE_NAME})`, "gmu");
const IMPORT_HEAD = new RegExp(`^import\\s+(${MODULE_NAME})`, "u");
const ANNOTATION = new RegExp(`^(${LOWER_NAME})\\s*:`, "gmu");
const TYPE_HEAD = new RegExp(`^type\\s+(alias\\s+)?(${UPPER_NAME})`, "u");
const VARIANT = new RegExp(`^\\s*(${UPPER_NAME})`, "u");
const FIELD = new RegExp(`^\\s*(${LOWER_NAME})\\s*:`, "u");

/**
 * @typedef {object} ElmFile
 * @property {string} file         Path relative to the Elm project root
 * @property {string} module       Module name, for example "Page.Home"
 * @property {string} text         The whole source
 * @property {string} code         The source with comments and literals blanked out
 * @property {string[]} imports    Names of the modules it imports
 * @property {Map<string, { qualifier: string, everything: boolean, names: string[], constructorsOf: string[] }>} imported
 *   How it imports each of them: the qualifier it refers to the module by, and what it may name without one
 * @property {string} codeWithoutImports  The code with every import taken out, where the uses of names are
 * @property {string[]} functions  Top-level values that have a type annotation
 * @property {string[]} exposedFunctions  The ones of them that another module can name
 * @property {string[]} typeNames  Every custom type and type alias it declares
 * @property {{ name: string, variants: string[] }[]} types
 * @property {{ name: string, fields: string[] }[]} aliases  Record type aliases
 * @property {string[]} openFields  Fields that an extensible record type names, as in { a | name : String }
 */

const blank = (text) => text.replace(/[^\n]/g, " ");

/**
 * The pieces of a source text in order, each as [kind, start, end]: what is
 * code, what is a string or character literal, and what is a comment.
 * @returns {["code" | "literal" | "comment", number, number][]}
 */
function pieces(text) {
  const found = [];
  let at = 0;
  let codeFrom = 0;
  const take = (kind, end) => {
    if (at > codeFrom) found.push(["code", codeFrom, at]);
    found.push([kind, at, end]);
    at = end;
    codeFrom = end;
  };
  while (at < text.length) {
    if (text.startsWith('"""', at)) {
      // A backslash takes the character behind it along, a quote for one
      let end = at + 3;
      while (end < text.length && !text.startsWith('"""', end)) {
        end += text[end] === "\\" ? 2 : 1;
      }
      take("literal", Math.min(end + 3, text.length));
    } else if (text[at] === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"' && text[end] !== "\n") {
        end += text[end] === "\\" ? 2 : 1;
      }
      take("literal", Math.min(end + 1, text.length));
    } else if (text[at] === "'") {
      const literal = /^'(?:\\(?:u\{[0-9a-fA-F]+\}|.)|[^'\\\n])'/.exec(text.slice(at, at + 14));
      take("literal", at + (literal ? literal[0].length : 1));
    } else if (text.startsWith("--", at)) {
      const lineEnd = text.indexOf("\n", at);
      take("comment", lineEnd < 0 ? text.length : lineEnd);
    } else if (text.startsWith("{-", at)) {
      // Block comments nest
      let depth = 1;
      let end = at + 2;
      while (end < text.length && depth > 0) {
        if (text.startsWith("{-", end)) {
          depth++;
          end += 2;
        } else if (text.startsWith("-}", end)) {
          depth--;
          end += 2;
        } else {
          end++;
        }
      }
      take("comment", end);
    } else {
      at++;
    }
  }
  if (at > codeFrom) found.push(["code", codeFrom, at]);
  return found;
}

/**
 * The source with every comment, string and character literal replaced by
 * spaces. Line breaks stay, so positions and line numbers still hold. A name
 * in a comment or in a string is not a use of that name.
 */
export function codeOnly(text) {
  return pieces(text)
    .map(([kind, start, end]) => (kind === "code" ? text.slice(start, end) : blank(text.slice(start, end))))
    .join("");
}

/**
 * Where the code and the literals of each line begin, which is what Elm's
 * layout rule reads: the source with every comment replaced by spaces, and
 * every literal by its first character and spaces. A line that begins inside
 * a literal that started further up is blank then, as a line of a comment is.
 */
export function layoutOf(text) {
  return pieces(text)
    .map(([kind, start, end]) => {
      const piece = text.slice(start, end);
      if (kind === "code") return piece;
      return kind === "literal" ? piece[0] + blank(piece.slice(1)) : blank(piece);
    })
    .join("");
}

/** Line numbers, starting at zero, whose start lies inside a literal. */
export function literalLineStarts(text) {
  const inside = new Set();
  let line = 0;
  for (const [kind, start, end] of pieces(text)) {
    const breaks = text.slice(start, end).split("\n").length - 1;
    if (kind === "literal") {
      for (let offset = 1; offset <= breaks; offset++) inside.add(line + offset);
    }
    line += breaks;
  }
  return inside;
}

// A name or keyword, a number, or any other single character that is not space
const TOKEN = new RegExp(`[\\p{L}_]${INNER}*|\\d[\\p{L}0-9_.]*|\\S`, "gu");

/**
 * The tokens of a source text: names, numbers, symbols and whole literals.
 * Layout and comments are left out, so two texts with the same tokens say
 * the same thing. `body` has the tokens of the declarations in order.
 * `header` has the module line and each import apart, as its tokens. A
 * formatter sorts the imports and what each exposes, so their order says
 * nothing, while an alias or an exposed name belongs to its own import.
 * @returns {{ header: string[][], body: string[] }}
 */
export function tokensOf(text) {
  // One list per top-level statement, each of which starts in column 0
  const statements = [[]];
  for (const [kind, start, end] of pieces(text)) {
    if (kind === "comment") continue;
    if (kind === "literal") {
      statements.at(-1).push(text.slice(start, end));
      continue;
    }
    for (const token of text.slice(start, end).matchAll(TOKEN)) {
      const at = start + token.index;
      if (at === 0 || text[at - 1] === "\n") statements.push([]);
      statements.at(-1).push(token[0]);
    }
  }
  const isHeader = ([first, second]) => first === "import" || first === "module" || ((first === "port" || first === "effect") && second === "module");
  return {
    header: statements.filter(isHeader),
    body: statements.filter((statement) => !isHeader(statement)).flat(),
  };
}

/**
 * A module line or an import in a form that is the same whatever order its
 * exposed items come in: `import A as B exposing (c, D(..))`, with the items
 * sorted.
 * @param {string[]} statement  Its tokens, as tokensOf gives them
 */
export function headerLine(statement) {
  // "import Page . Home" reads as "import Page.Home"
  const words = (tokens) => tokens.join(" ").replaceAll(" . ", ".");
  const exposing = statement.indexOf("exposing");
  if (exposing === -1) return words(statement);

  // The items stand between the outer brackets, with commas between them and brackets of their own inside
  const items = [];
  let item = "";
  let depth = 0;
  for (const token of statement.slice(exposing + 1)) {
    if (token === "(" && depth++ === 0) continue;
    if (token === ")" && --depth === 0) continue;
    if (token === "," && depth === 1) {
      items.push(item);
      item = "";
    } else {
      item += token;
    }
  }
  return `${words(statement.slice(0, exposing))} exposing (${[...items, item].filter(Boolean).sort().join(", ")})`;
}

// The line after the declaration that starts on line `start`: it holds that line and the indented lines below it.
function declarationEnd(lines, start) {
  let end = start + 1;
  while (end < lines.length && !/^\S/.test(lines[end])) {
    end++;
  }
  return end;
}

// The declaration that starts on line `start`, as one text.
const declaration = (lines, start) => lines.slice(start, declarationEnd(lines, start)).join("\n");

// The parts of `text` between separators that are not inside brackets of any kind.
function splitOutsideBrackets(text, separator) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < text.length; at++) {
    if ("({[".includes(text[at])) depth++;
    else if (")}]".includes(text[at])) depth--;
    else if (text[at] === separator && depth === 0) {
      parts.push(text.slice(from, at));
      from = at + 1;
    }
  }
  return [...parts, text.slice(from)];
}

// "type Shape = Circle Float | Dot" -> ["Circle", "Dot"]
function variantsOf(declared) {
  const body = declared.slice(declared.indexOf("=") + 1);
  return splitOutsideBrackets(body, "|")
    .map((variant) => VARIANT.exec(variant)?.[1])
    .filter(Boolean);
}

// "type alias Point = { x : Float, y : Float }" -> ["x", "y"]. Empty when the alias is no record.
function fieldsOf(declared) {
  const body = declared.slice(declared.indexOf("=") + 1).trim();
  if (!body.startsWith("{") || !body.endsWith("}")) return [];
  // A function from one record to another begins and ends like a record. Its arrow stands outside of both.
  if (splitOutsideBrackets(body, ">").length > 1) return [];
  // An extensible record, { base | x : Float }, stands for every record that has those fields. Its
  // fields are theirs: renaming one here breaks each value that is passed for it.
  if (splitOutsideBrackets(body.slice(1, -1), "|").length > 1) return [];
  return splitOutsideBrackets(body.slice(1, -1), ",")
    .map((field) => FIELD.exec(field)?.[1])
    .filter(Boolean);
}

// The fields that the extensible record types in `code` ask of a record: "name" for
// { a | name : String }. A record update, { user | name = "" }, is no type and names none.
function openFieldsOf(code) {
  const fields = new Set();
  for (const opening of code.matchAll(new RegExp(`\\{\\s*${LOWER_NAME}\\s*\\|`, "gu"))) {
    const from = opening.index + opening[0].length;
    let end = from;
    for (let depth = 1; end < code.length && depth > 0; end++) {
      if ("({[".includes(code[end])) depth++;
      else if (")}]".includes(code[end])) depth--;
    }
    for (const part of splitOutsideBrackets(code.slice(from, end - 1), ",")) {
      const field = FIELD.exec(part)?.[1];
      if (field) fields.add(field);
    }
  }
  return [...fields];
}

// What a module line or an import exposes: everything, names, and the types whose variants
// come along, as in "Shape(..)"
function exposedBy(statement) {
  const exposing = new RegExp(`${NAME_START}exposing\\s*\\(([^]*)\\)`, "u").exec(statement)?.[1] ?? "";
  const exposed = splitOutsideBrackets(exposing, ",").map((item) => item.trim());
  const withConstructors = new RegExp(`^(${INNER}+)\\s*\\(\\.\\.\\)$`, "u");
  return {
    everything: exposed.includes(".."),
    names: exposed.filter((item) => new RegExp(`^${INNER}+$`, "u").test(item)),
    constructorsOf: exposed.map((item) => withConstructors.exec(item)?.[1]).filter(Boolean),
  };
}

/** @returns {ElmFile | null} null when the text has no module line */
export function scanSource(file, text) {
  const code = codeOnly(text);
  const found = MODULE_LINE.exec(code);
  if (!found) return null;
  const module = found[1];

  const lines = code.split("\n");
  // Another module can name the variants of a type only where this one exposes them
  const exposed = exposedBy(declaration(lines, code.slice(0, found.index).split("\n").length - 1));
  const typeNames = [];
  const types = [];
  const aliases = [];
  lines.forEach((line, index) => {
    if (!line.startsWith("type")) return;
    const declared = declaration(lines, index);
    const head = TYPE_HEAD.exec(declared);
    if (!head) return;
    typeNames.push(head[2]);
    if (head[1]) {
      const fields = fieldsOf(declared);
      if (fields.length > 0) aliases.push({ name: head[2], fields });
    } else {
      const variants = variantsOf(declared);
      if (variants.length > 0) types.push({ name: head[2], variants, open: exposed.everything || exposed.constructorsOf.includes(head[2]) });
    }
  });

  // Each import with the lines it goes on in, which are indented or blank. The first import of a module counts.
  const imported = new Map();
  lines.forEach((line, index) => {
    if (!line.startsWith("import")) return;
    const statement = declaration(lines, index);
    const name = IMPORT_HEAD.exec(statement)?.[1];
    if (name === undefined || imported.has(name)) return;
    imported.set(name, { qualifier: new RegExp(`${NAME_START}as\\s+(${UPPER_NAME})`, "u").exec(statement)?.[1] ?? name, ...exposedBy(statement) });
  });

  const functions = [...new Set([...code.matchAll(ANNOTATION)].map((match) => match[1]))];
  return {
    file,
    module,
    text,
    code,
    imports: [...code.matchAll(IMPORT_LINE)].map((match) => match[1]),
    imported,
    codeWithoutImports: code.replace(/^import\b[^\n]*(?:\n(?!\S)[^\n]*)*/gm, ""),
    functions,
    exposedFunctions: functions.filter((name) => exposed.everything || exposed.names.includes(name)),
    typeNames,
    types,
    aliases,
    openFields: openFieldsOf(code),
  };
}

// Directories that hold no sources of a project, wherever they lie: the compiler's cache and the
// packages of a tool, which can bring Elm files of their own
export const NO_SOURCES = ["elm-stuff", "node_modules"];

// The Elm files under `dir`. A directory that is a link is followed like any other, as the
// compiler does. `visited` has the real directories that were walked already: a link to a
// directory above itself would otherwise lead around in a circle without end. A caller that
// walks several directories hands in one set for all of them, and gets no file twice.
function elmFilesUnder(dir, visited = new Set()) {
  const real = realpathSync(dir);
  if (visited.has(real)) return [];
  visited.add(real);

  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path, { throwIfNoEntry: false });
    // A link to nothing, such as the lock an editor keeps beside a file with unsaved changes
    if (!stats) continue;
    if (stats.isDirectory()) {
      if (!NO_SOURCES.includes(entry) && !entry.startsWith(".")) {
        files.push(...elmFilesUnder(path, visited));
      }
    } else if (entry.endsWith(".elm")) {
      files.push(path);
    }
  }
  return files;
}

// elm-test compiles this directory next to elm.json on top of the source directories
const TEST_DIRECTORY = "tests";

// Where a package keeps its modules. Its elm.json lists no source directories.
const SOURCE_DIRECTORIES_OF_A_PACKAGE = ["src"];

/**
 * The directories that hold the modules of a project, relative to the Elm
 * root: the source directories that elm.json lists, and the test directory
 * beside them. Each is spelled as the disk spells it, which is how git names
 * the files in it. A file system that ignores letter case finds "src" under
 * "Src", and so does the compiler.
 * @param {object} elmJson  The parsed elm.json
 * @param {string} elmRoot  The absolute path of the directory that holds it
 * @returns {string[]}
 */
export const projectDirectories = (elmJson, elmRoot) =>
  [...(elmJson["source-directories"] ?? SOURCE_DIRECTORIES_OF_A_PACKAGE), TEST_DIRECTORY].map((directory) =>
    relative(asSpelledOnDisk(elmRoot), asSpelledOnDisk(resolve(elmRoot, directory)))
  );

/**
 * Scan every module in the source directories that elm.json lists, and the
 * test modules beside them, which import the same code. Each file is read
 * once: a source directory can lie inside another one, "." for one, and a
 * directory can be listed twice under two spellings.
 * @returns {ElmFile[]} sorted by file path
 */
export function scanProject(elmRoot) {
  const visited = new Set();
  return projectDirectories(JSON.parse(readFileSync(join(elmRoot, "elm.json"), "utf-8")), elmRoot)
    .filter((directory) => existsSync(join(elmRoot, directory)))
    .flatMap((directory) => elmFilesUnder(join(elmRoot, directory), visited))
    .sort()
    .map((path) => scanSource(relative(elmRoot, path), readFileSync(path, "utf-8")))
    .filter(Boolean);
}

/**
 * Scan the Elm files under the project root that are no part of the project,
 * such as an example that keeps an elm.json of its own. A file like that can
 * import the project's modules through its own source directories, and no
 * check the benchmark runs would compile it.
 * @param {ElmFile[]} project  What scanProject found
 * @returns {ElmFile[]} sorted by file path
 */
export function scanOutsiders(elmRoot, project) {
  const known = new Set(project.map((source) => source.file));
  return elmFilesUnder(elmRoot)
    .map((path) => relative(elmRoot, path))
    .filter((file) => !known.has(file))
    .sort()
    .map((file) => scanSource(file, readFileSync(join(elmRoot, file), "utf-8")))
    .filter(Boolean);
}

// True when `word` occurs in the code as a whole identifier, qualified or not.
export function mentions(code, word) {
  return new RegExp(`${NAME_START}${word}${NAME_END}`, "u").test(code);
}

/**
 * True when the file refers to `name` of `module`: through the module's
 * qualifier, or bare where its import allows that. For a variant, `type` is
 * the custom type it belongs to, and an import allows the bare variant only
 * where it takes the variants of that type along: a name that it exposes is
 * a type of the variant's name, as in `type Route = Profile Profile`. The
 * imports themselves are no use of a name. Another module's `name` does not
 * count.
 */
export function refersTo(source, module, name, type) {
  if (source.module === module) return mentions(source.code, name);
  const imported = source.imported.get(module);
  if (!imported) return false;
  // Most files do not hold the name at all, and a search for its text is much quicker than the patterns below
  if (!source.codeWithoutImports.includes(name)) return false;

  const qualified = new RegExp(`(?<!\\.)${NAME_START}${imported.qualifier.replaceAll(".", "\\.")}\\.${name}${NAME_END}`, "u");
  const bare = new RegExp(`(?<!\\.)${NAME_START}${name}${NAME_END}`, "u");
  const mayBeBare = imported.everything || (type ? imported.constructorsOf.includes(type) : imported.names.includes(name));
  return qualified.test(source.codeWithoutImports) || (mayBeBare && bare.test(source.codeWithoutImports));
}

// The files that import `module`.
export function importersOf(project, module) {
  return project.filter((source) => source.imports.includes(module));
}

/**
 * The files a build of `entryFiles` compiles: the entries and everything they
 * import, directly or not.
 * @returns {Set<string>}
 */
export function compiledFiles(project, entryFiles) {
  const byModule = new Map(project.map((source) => [source.module, source]));
  const pending = project.filter((source) => entryFiles.includes(source.file));

  const compiled = new Set();
  for (let source = pending.pop(); source; source = pending.pop()) {
    if (compiled.has(source.file)) continue;
    compiled.add(source.file);
    pending.push(...source.imports.map((module) => byModule.get(module)).filter(Boolean));
  }
  return compiled;
}

/**
 * The source with one more variant appended to a custom type, or null when
 * the type is not written with one variant per line, as elm-format writes it.
 * The type is looked for in the code alone. One in a comment or in a string,
 * an example in the documentation for one, is no declaration.
 */
export function withVariant(text, type, variant) {
  const lines = text.split("\n");
  const code = codeOnly(text).split("\n");
  const start = code.findIndex((line) => TYPE_HEAD.exec(line)?.[2] === type && !/^type +alias/.test(line));
  if (start === -1) return null;

  const body = code.slice(start + 1, declarationEnd(code, start));
  const last = body.findLastIndex((line) => /^ +[=|] *[\p{Lu}\p{Lt}]/u.test(line));
  if (last === -1) return null;

  const indent = /^ +/.exec(body[last])[0];
  // Wrapped arguments of the last variant sit on deeper lines after it, also below a blank line,
  // and end where the declaration's code ends. A comment is no code, and a line of one is none of them.
  let insertAt = start + 1 + last + 1;
  for (let at = insertAt; at < start + 1 + body.length; at++) {
    if (code[at].trim() !== "") insertAt = at + 1;
  }
  lines.splice(insertAt, 0, `${indent}| ${variant}`);
  return lines.join("\n");
}
