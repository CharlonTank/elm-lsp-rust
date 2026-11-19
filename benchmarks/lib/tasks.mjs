/**
 * The task types. Each one finds targets in a scanned project, words the
 * request for the agent, and lists what must hold once the agent is done.
 *
 * Targets are found and outcomes are checked with elm-source.mjs and the
 * project's own compiler. The language server takes no part in either.
 */

import { existsSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import { isDeepStrictEqual } from "util";
import {
  codeOnly,
  layoutOf,
  literalLineStarts,
  headerLine,
  importersOf,
  mentions,
  NAME_END,
  refersTo,
  scanProject,
  scanSource,
  tokensOf,
  UPPER_NAME,
} from "./elm-source.mjs";

// Suffix of every new name. No picked name may already exist with it.
const SUFFIX = "Renamed";

// Variant that the add-variant task introduces
const NEW_VARIANT = "AddedByBenchmark";

// A name this short is too likely to appear inside unrelated words and strings
const MIN_NAME_LENGTH = 4;

/**
 * @typedef {object} Target
 * @property {string} key    Stable identity, used to order equal candidates
 * @property {number} size   How many files the change is expected to touch
 * @property {string} file   The file that declares the target
 * @property {string} module  The module in that file
 * @property {string[]} affected  Other files that the change can break
 *
 * @typedef {object} TaskType
 * @property {string} id
 * @property {string} title
 * @property {number} idealSize  Candidates nearest to this size are tried first
 * @property {(project: import("./elm-source.mjs").ElmFile[], entries: string[]) => Target[]} candidates
 * @property {(target: Target, check: string, project?: { exposed?: string[] }) => { prompt: string, expect: object[], facts: object }} build
 *   `project.exposed` has the modules that elm.json lists as exposed, where the project is a package
 * @property {(target: Target) => { type: string, variant: string }} [breaksBuild]
 *   A variant to add to the target's file. The planner only keeps a target
 *   when the compiler rejects the project with that variant added, which
 *   proves there is work to do.
 */

function countBy(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

const files = (sources) => sources.map((source) => source.file);

/** "1 session", "2 sessions": a number with the word for one of the thing, or for several */
export const plural = (number, one, many) => `${number} ${number === 1 ? one : many}`;

// Every prompt ends the same way. The verdict holds a session to "nothing else", so the request says it.
const closing = (check) =>
  `Change nothing else. The project compiles with \`${check}\`, run from the current directory. ` +
  `It must still compile when you are done. Do not create commits.`;

// Functions to rename. `shared` asks for a name that other modules declare too.
function functionCandidates(project, shared) {
  const declarations = countBy(project.flatMap((source) => source.functions));
  const aliases = project.flatMap((source) => source.aliases.map((alias) => ({ file: source.file, alias })));
  const candidates = [];
  for (const source of project) {
    for (const name of source.functions) {
      const elsewhere = declarations.get(name) - 1;
      if (name.length < MIN_NAME_LENGTH || declarations.has(name + SUFFIX)) continue;
      if (shared ? elsewhere < 3 : elsewhere !== 0) continue;

      const importers = importersOf(project, source.module);
      candidates.push({
        key: `${source.file}:${name}`,
        // No other module can name a function that its own module keeps to itself
        size: source.exposedFunctions.includes(name) ? importers.filter((importer) => refersTo(importer, source.module, name)).length : 0,
        file: source.file,
        affected: files(importers),
        module: source.module,
        name,
        mayChange: [source.file, ...files(importers)],
        namesakes: files(project.filter((other) => other !== source && other.functions.includes(name))),
        // Records with a field of the function's name. A text replace renames that too.
        fields: aliases.filter(({ alias }) => alias.fields.includes(name)).map(({ file, alias }) => ({ file, alias: alias.name })),
      });
    }
  }
  return candidates;
}

function buildFunctionRename({ file, module, name, mayChange, namesakes, fields, size }, check) {
  const newName = name + SUFFIX;
  const asides = [
    "",
    ` 1 other module declares a \`${name}\` of its own. That is a different function and keeps its name.`,
    ` ${namesakes.length} other modules declare a \`${name}\` of their own. Those are different functions and keep their name.`,
  ];
  const aside = asides[Math.min(namesakes.length, 2)];
  return {
    prompt:
      `Rename the function \`${name}\` of the module \`${module}\` (\`${file}\`) to \`${newName}\`, ` +
      `and update every use of it in the project.${aside}\n\n${closing(check)}`,
    expect: [
      { kind: "declares-function", file, name: newName },
      { kind: "lacks-function", file, name },
      ...(namesakes.length > 0 ? [{ kind: "functions-kept", name, files: namesakes }] : []),
      ...(fields.length > 0 ? [{ kind: "fields-kept", field: name, aliases: fields }] : []),
      { kind: "renames-only", of: "function", from: name, to: newName },
      { kind: "changes-only-in", files: mayChange },
      { kind: "only-elm-files" },
    ],
    facts: { filesUsingIt: size, namesakes: namesakes.length },
  };
}

/** @type {TaskType[]} */
export const TASK_TYPES = [
  {
    id: "rename-function",
    title: "Rename a function with a unique name",
    idealSize: 10,
    candidates: (project) => functionCandidates(project, false),
    build: buildFunctionRename,
  },

  {
    id: "rename-shared-function",
    title: "Rename a function whose name other modules also use",
    idealSize: 10,
    candidates: (project) => functionCandidates(project, true),
    build: buildFunctionRename,
  },

  {
    id: "rename-variant",
    title: "Rename a variant of a custom type",
    idealSize: 10,
    candidates(project) {
      const types = project.flatMap((source) => source.types.map((type) => ({ file: source.file, type })));
      const taken = new Set(types.flatMap(({ type }) => [type.name, ...type.variants]));
      const candidates = [];
      for (const source of project) {
        for (const type of source.types) {
          for (const variant of type.variants) {
            // In `type Email = Email String` the tokens of a use do not tell the type from its variant
            if (variant.length < MIN_NAME_LENGTH || taken.has(variant + SUFFIX) || variant === type.name) continue;
            const importers = importersOf(project, source.module);
            candidates.push({
              key: `${source.file}:${type.name}.${variant}`,
              // No other module can name a variant that its own module keeps to itself
              size: type.open ? importers.filter((importer) => refersTo(importer, source.module, variant, type.name)).length : 0,
              file: source.file,
              module: source.module,
              affected: files(importers),
              type: type.name,
              variant,
              mayChange: [source.file, ...files(importers)],
              // Other types with a variant of the same name. A text replace renames those too.
              namesakes: types
                .filter((other) => other.type !== type && other.type.variants.includes(variant))
                .map((other) => ({ file: other.file, type: other.type.name })),
              // Types of the variant's own name, as in `type Page = Settings Settings`
              types: files(project.filter((other) => other.typeNames.includes(variant))),
            });
          }
        }
      }
      return candidates;
    },
    build({ file, type, variant, mayChange, namesakes, types, size }, check) {
      const newVariant = variant + SUFFIX;
      const aside =
        namesakes.length > 0
          ? ` ${plural(namesakes.length, "other custom type has", "other custom types have")} a variant called \`${variant}\` too. It keeps that name there.`
          : "";
      return {
        prompt:
          `Rename the variant \`${variant}\` of the custom type \`${type}\` in \`${file}\` to \`${newVariant}\`, ` +
          `and update every place that constructs it or matches on it.${aside}\n\n${closing(check)}`,
        expect: [
          { kind: "type-has-variant", file, type, variant: newVariant },
          { kind: "type-lacks-variant", file, type, variant },
          ...(namesakes.length > 0 ? [{ kind: "variants-kept", variant, types: namesakes }] : []),
          ...(types.length > 0 ? [{ kind: "types-kept", name: variant, files: types }] : []),
          { kind: "renames-only", of: "variant", from: variant, to: newVariant },
          { kind: "changes-only-in", files: mayChange },
          { kind: "only-elm-files" },
        ],
        facts: { filesUsingIt: size, namesakes: namesakes.length },
      };
    },
  },

  {
    id: "rename-field",
    title: "Rename a record field whose name other records also use",
    idealSize: 10,
    candidates(project) {
      const aliases = project.flatMap((source) => source.aliases.map((alias) => ({ file: source.file, alias })));
      const owners = countBy(aliases.flatMap(({ alias }) => alias.fields));
      // A function over { a | name : String } takes every record that has the field. With the field
      // renamed on one of them alone, a call that passes that record for it no longer compiles.
      const open = new Set(project.flatMap((source) => source.openFields));
      const candidates = [];
      for (const source of project) {
        for (const alias of source.aliases) {
          for (const field of alias.fields) {
            // The task is about telling records apart, so the name must be on at least two other records
            if (field.length < MIN_NAME_LENGTH || owners.get(field) < 3 || owners.has(field + SUFFIX) || open.has(field)) continue;
            const users = importersOf(project, source.module).filter(
              (importer) => mentions(importer.code, alias.name) && mentions(importer.code, field)
            );
            candidates.push({
              key: `${source.file}:${alias.name}.${field}`,
              size: users.length,
              file: source.file,
              module: source.module,
              // A record travels through values, so a module can read the field without importing the alias
              affected: files(project.filter((other) => other !== source && mentions(other.code, field))),
              alias: alias.name,
              field,
              namesakes: aliases
                .filter((other) => other.alias !== alias && other.alias.fields.includes(field))
                .map((other) => ({ file: other.file, alias: other.alias.name })),
              // Functions of the field's name
              functions: files(project.filter((other) => other.functions.includes(field))),
            });
          }
        }
      }
      return candidates;
    },
    build({ file, alias, field, namesakes, functions, size }, check) {
      const newField = field + SUFFIX;
      return {
        prompt:
          `Rename the field \`${field}\` of the record type alias \`${alias}\` in \`${file}\` to \`${newField}\`. ` +
          `Update every place that reads, sets or pattern-matches that field on a value of type \`${alias}\`. ` +
          `Where a record pattern binds the field to a variable, the variable takes the new name as well. ` +
          `${plural(namesakes.length, "other record type has", "other record types have")} a field called \`${field}\` too. It keeps that name there.\n\n${closing(check)}`,
        expect: [
          { kind: "alias-has-field", file, alias, field: newField },
          { kind: "alias-lacks-field", file, alias, field },
          { kind: "fields-kept", field, aliases: namesakes },
          ...(functions.length > 0 ? [{ kind: "functions-kept", name: field, files: functions }] : []),
          { kind: "renames-only", of: "field", from: field, to: newField },
          { kind: "only-elm-files" },
        ],
        facts: { filesUsingIt: size, namesakes: namesakes.length },
      };
    },
  },

  {
    id: "rename-module",
    title: "Rename a module",
    idealSize: 10,
    candidates(project, entries) {
      const modules = new Set(project.map((source) => source.module));
      return project
        // The check command names its entry files by path, so those stay where they are
        .filter((source) => !entries.includes(source.file) && !modules.has(source.module + SUFFIX))
        .map((source) => {
          const importers = importersOf(project, source.module);
          const newFile = source.file.replace(/\.elm$/, `${SUFFIX}.elm`);
          return {
            key: source.file,
            size: importers.length,
            file: source.file,
            affected: files(importers),
            module: source.module,
            newFile,
            mayChange: [source.file, newFile, ...files(importers)],
          };
        });
    },
    build({ file, module, newFile, mayChange, size }, check, { exposed = [] } = {}) {
      const newModule = module + SUFFIX;
      // No import leads to the list of modules in a package's elm.json, and a build of one file does not read it
      const listed = exposed.includes(module) ? " The package exposes the module, so change its name in the `exposed-modules` of `elm.json` as well." : "";
      // A module is named in parts, and the last part is the one that changes
      const lastPart = module.split(".").at(-1);
      return {
        prompt:
          `Rename the module \`${module}\` to \`${newModule}\`. Move \`${file}\` to \`${newFile}\`, ` +
          `and update every import of the module and every qualified reference to it.${listed}\n\n${closing(check)}`,
        expect: [
          { kind: "file-missing", file },
          { kind: "declares-module", file: newFile, module: newModule },
          { kind: "no-import-of", module },
          { kind: "renames-only", of: "module", from: lastPart, to: lastPart + SUFFIX, moved: [file, newFile] },
          { kind: "changes-only-in", files: mayChange },
          // A package lists the modules it exposes in elm.json, where this one has to change its name too
          { kind: "only-elm-files", except: ["elm.json"] },
          { kind: "elm-json-renames-only", from: module, to: newModule },
        ],
        facts: { filesImportingIt: size },
      };
    },
  },

  {
    id: "add-variant",
    title: "Add a variant and handle it in every case expression",
    idealSize: 5,
    breaksBuild: ({ type }) => ({ type, variant: NEW_VARIANT }),
    candidates(project) {
      if (project.some((source) => source.types.some((type) => type.variants.includes(NEW_VARIANT)))) return [];
      const candidates = [];
      for (const source of project) {
        for (const type of source.types.filter((type) => type.variants.length >= 3)) {
          // A line such as "        Loading ->" or "        Page.Loading _ ->"
          const branch = new RegExp(`^ +(?:${UPPER_NAME}\\.)*(?:${type.variants.join("|")})${NAME_END}[^=\\n]*->`, "mu");
          const importers = importersOf(project, source.module);
          candidates.push({
            key: `${source.file}:${type.name}`,
            // Files with a branch on one of this type's variants, not on a namesake of another module's type.
            // Where the module keeps the variants to itself, its own file is the only one.
            size: [source, ...(type.open ? importers : [])].filter(
              (user) => branch.test(user.code) && type.variants.some((variant) => refersTo(user, source.module, variant, type.name))
            ).length,
            file: source.file,
            module: source.module,
            affected: files(importers),
            type: type.name,
            mayChange: [source.file, ...files(importers)],
          });
        }
      }
      return candidates;
    },
    build({ file, type, mayChange, size }, check) {
      return {
        prompt:
          `Add a variant \`${NEW_VARIANT}\`, without arguments, as the last variant of the custom type \`${type}\` in \`${file}\`. ` +
          `Wherever the compiler then reports a missing case, add a branch for \`${NEW_VARIANT}\` ` +
          `whose body is \`Debug.todo\` with a string literal of your choice for its message.\n\n${closing(check)}`,
        expect: [
          { kind: "type-has-variant", file, type, variant: NEW_VARIANT, last: true },
          { kind: "adds-variant-and-branches", variant: NEW_VARIANT },
          { kind: "changes-only-in", files: mayChange },
          { kind: "only-elm-files" },
        ],
        facts: { filesMatchingOnIt: size },
      };
    },
  },
];

/**
 * The targets of one task type in a project, most suitable first: at least
 * `minFiles` files involved, and as close to the type's ideal size as possible.
 *
 * The check command must compile the target's file and every file the change
 * can break. The compiler's verdict says nothing about a module it never
 * reads, such as a test module, so a reference left behind there would pass.
 *
 * @param {string[]} entries     The files the check command names
 * @param {Set<string>} compiled  The files it compiles from them
 * @param {Target[]} [candidates]  The candidates of the task type, where the caller found them already
 */
export function rankedTargets(taskType, project, { entries, compiled }, minFiles, candidates = taskType.candidates(project, entries)) {
  const distance = (target) => Math.abs(target.size - taskType.idealSize);
  return candidates
    .filter((target) => target.size >= minFiles && [target.file, ...target.affected].every((file) => compiled.has(file)))
    // Compared by code unit, so the plan does not depend on the machine's locale
    .sort((a, b) => distance(a) - distance(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * True when an Elm file outside the project can use the target: it imports
 * the target's module, or names the field, which needs no import. The check
 * command never compiles such a file. A change that left it behind would
 * pass, and one that followed it there would count as changing a file that
 * cannot use the target.
 * @param {import("./elm-source.mjs").ElmFile[]} outsiders
 */
export function usedOutside(target, outsiders) {
  return outsiders.some(
    (outsider) => outsider.imports.includes(target.module) || (target.field !== undefined && mentions(outsider.code, target.field))
  );
}

/**
 * The file outside the check command's build that holds back the most
 * candidates of a task type, with how many, and how many such files there
 * are, or null when no candidate is held back for that reason. A plan that
 * finds no target can then say what to add to the check command.
 * @param {Target[]} [candidates]  The candidates of the task type, where the caller found them already
 * @returns {{ file: string, candidates: number, files: number } | null}
 */
export function heldBack(taskType, project, { entries, compiled }, minFiles, candidates = taskType.candidates(project, entries)) {
  const counts = new Map();
  for (const target of candidates.filter((target) => target.size >= minFiles)) {
    for (const file of new Set([target.file, ...target.affected])) {
      if (!compiled.has(file)) counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  const [worst] = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return worst ? { file: worst[0], candidates: worst[1], files: counts.size } : null;
}

const read = (elmRoot, file) => (existsSync(join(elmRoot, file)) ? readFileSync(join(elmRoot, file), "utf-8") : null);

const scan = (elmRoot, file) => {
  const text = read(elmRoot, file);
  return text === null ? null : scanSource(file, text);
};

// A definition starts in column 0, however the rest of it is laid out
const declares = (elmRoot, file, name) => new RegExp(`^${name}${NAME_END}`, "mu").test(codeOnly(read(elmRoot, file) ?? ""));

const variantsOf = (elmRoot, file, type) => scan(elmRoot, file)?.types.find((t) => t.name === type)?.variants ?? [];

const fieldsOf = (elmRoot, file, alias) => scan(elmRoot, file)?.aliases.find((a) => a.name === alias)?.fields ?? [];

// What a pattern is made of, once strings and comments are taken out: names, the dots of a
// qualified one, digits with the minus sign of a negative number, brackets, commas, the colons
// of a list and blanks
const PATTERN_PARTS = /^[\p{L}0-9_.\s()[\]{},:-]*$/u;

// How many brackets a text leaves open, or -1 where it closes one that it never opened
function openBrackets(code) {
  let depth = 0;
  for (const character of code) {
    if ("([{".includes(character)) depth++;
    else if (")]}".includes(character) && --depth < 0) return -1;
  }
  return depth;
}

// One part of the body of an added branch, with the space in front of it: a bracket, the call,
// the "<|" behind it, or its message as a string literal in three quotes or in one. A literal in
// three quotes can go on over several lines, and one that the text does not end is told by its
// missing end.
const BODY_PART = /\s*(?:([()])|(Debug\.todo)(?![\p{L}0-9_.])|(<\|)|("""(?:[^"\\]|\\[^]|"(?!""))*(?:(""")|$))|"(?:[^"\\]|\\.)*")/uy;

// Where a module line or an import can name a thing of each kind, by the place of a token in
// it and the place of "exposing": a module in front of that word, a function behind it
const NAMED_IN_HEADER = {
  module: (at, exposing) => at < exposing,
  function: (at, exposing) => at > exposing,
  variant: () => false,
  field: () => false,
};

/**
 * What a text holds beyond the rename of `from` to `to`, compared with what
 * it was: null when every token is the one that was there, or `to` in the
 * place of `from`. Layout and comments are free. Anything else, a changed
 * string literal for one, comes back as a few words on the first difference.
 * A text replace that also reached into a string would otherwise pass, as
 * long as the project still compiles.
 *
 * `of` is the kind of thing that is renamed, which decides where its name can
 * stand. A module's name changes in front of a dot, and in a module line or
 * an import outside of what that exposes: a module often declares a type of
 * its own name, `module User exposing (User)`, and that type keeps its name.
 * A function's name changes in what such a line exposes and nowhere else in
 * it. A variant and a field are named in none of them, so an import alias of
 * the variant's name, `import Page.Settings as Settings`, keeps its name too.
 * @param {{ of: "function" | "variant" | "field" | "module", from: string, to: string }} rename
 */
function beyondRename(before, after, { of, from, to }) {
  const [was, is] = [tokensOf(before), tokensOf(after)];
  for (let at = 0; at < Math.max(was.body.length, is.body.length); at++) {
    const [old, now] = [was.body[at], is.body[at]];
    const renamed = old === from && now === to && (of !== "module" || is.body[at + 1] === ".");
    if (old !== now && !renamed) {
      return `${old ?? "the end of the file"} became ${now ?? "the end of the file"}`;
    }
  }
  // The module line and the imports may come in another order, and so may what each of them
  // exposes. Line by line they are the same, with `to` read as `from`: an alias that went to
  // another import, or an exposed name that did, changes what the code below means.
  const lines = (header) =>
    header.map((statement) => {
      const exposing = statement.includes("exposing") ? statement.indexOf("exposing") : statement.length;
      return headerLine(statement.map((token, at) => (token === to && NAMED_IN_HEADER[of](at, exposing) ? from : token)));
    });
  // The first line of `some` that `others` do not have as often
  const missing = (some, others) => {
    const left = [...others];
    return some.find((line) => {
      const at = left.indexOf(line);
      if (at !== -1) left.splice(at, 1);
      return at === -1;
    });
  };
  const [had, has] = [lines(was.header), lines(is.header)];
  const [lost, gained] = [missing(had, has), missing(has, had)];
  if (lost !== undefined) return `the module line and the imports no longer have "${lost}"`;
  return gained === undefined ? null : `the module line and the imports gained "${gained}"`;
}

// Each check returns null when the expectation holds, or a sentence that says what is wrong.
const CHECKS = {
  "declares-function": ({ file, name }, { elmRoot }) => (declares(elmRoot, file, name) ? null : `${file} does not declare ${name}`),

  "lacks-function": ({ file, name }, { elmRoot }) => (declares(elmRoot, file, name) ? `${file} still declares ${name}` : null),

  "functions-kept": ({ name, files }, { elmRoot }) => {
    const lost = files.filter((file) => !declares(elmRoot, file, name));
    return lost.length > 0 ? `${name} was also renamed or removed in ${lost.join(", ")}` : null;
  },

  // With `last`, the variant also has to be the last one of its type
  "type-has-variant": ({ file, type, variant, last }, { elmRoot }) => {
    const variants = variantsOf(elmRoot, file, type);
    if (!variants.includes(variant)) return `${type} in ${file} has no variant ${variant}`;
    return last && variants.at(-1) !== variant ? `${variant} is not the last variant of ${type} in ${file}` : null;
  },

  "type-lacks-variant": ({ file, type, variant }, { elmRoot }) =>
    variantsOf(elmRoot, file, type).includes(variant) ? `${type} in ${file} still has the variant ${variant}` : null,

  "variants-kept": ({ variant, types }, { elmRoot }) => {
    const lost = types.filter(({ file, type }) => !variantsOf(elmRoot, file, type).includes(variant));
    return lost.length > 0 ? `${variant} was also renamed or removed on ${lost.map((l) => `${l.type} (${l.file})`).join(", ")}` : null;
  },

  // A type or a type alias called like a variant is another thing, and keeps its name
  "types-kept": ({ name, files }, { elmRoot }) => {
    const lost = files.filter((file) => !scan(elmRoot, file)?.typeNames.includes(name));
    return lost.length > 0 ? `the type ${name} was also renamed or removed in ${lost.join(", ")}` : null;
  },

  "alias-has-field": ({ file, alias, field }, { elmRoot }) =>
    fieldsOf(elmRoot, file, alias).includes(field) ? null : `${alias} in ${file} has no field ${field}`,

  "alias-lacks-field": ({ file, alias, field }, { elmRoot }) =>
    fieldsOf(elmRoot, file, alias).includes(field) ? `${alias} in ${file} still has the field ${field}` : null,

  "fields-kept": ({ field, aliases }, { elmRoot }) => {
    const lost = aliases.filter(({ file, alias }) => !fieldsOf(elmRoot, file, alias).includes(field));
    return lost.length > 0 ? `${field} was also renamed or removed on ${lost.map((l) => `${l.alias} (${l.file})`).join(", ")}` : null;
  },

  // In every file that changed, nothing changed but the name. `moved` names a file that went to another
  // place, which is the one file a rename may delete and the one it may create.
  "renames-only": ({ moved = [], ...rename }, { elmRoot, changed, originals }) => {
    const [movedFrom, movedTo] = moved;
    for (const file of changed.filter((path) => path.endsWith(".elm") && path !== movedFrom)) {
      const before = originals.get(file === movedTo ? movedFrom : file) ?? null;
      const after = read(elmRoot, file);
      if (after === null) return `${file} was deleted, which no rename asks for`;
      // The module that moved is compared with what it was at its old place. With the old
      // file still there and untouched, another expectation says so.
      if (before === null && file === movedTo) continue;
      if (before === null) return `${file} is a new file, which no rename asks for`;
      const beyond = beyondRename(before, after, rename);
      if (beyond) return `${file} changed in more than the name: ${beyond}`;
    }
    return null;
  },

  "file-missing": ({ file }, { elmRoot }) => (existsSync(join(elmRoot, file)) ? `${file} still exists` : null),

  "declares-module": ({ file, module }, { elmRoot }) =>
    scan(elmRoot, file)?.module === module ? null : `${file} does not declare the module ${module}`,

  "no-import-of": ({ module }, { elmRoot }) => {
    const importers = files(importersOf(scanProject(elmRoot), module));
    return importers.length > 0 ? `${module} is still imported by ${importers.join(", ")}` : null;
  },

  // The request was to add the variant, a branch for it wherever the compiler asks, and nothing else.
  // With the project compiling, lines of these three shapes and no others prove just that: a
  // catch-all branch, a rewritten branch or a comment would each show up as another kind of line.
  "adds-variant-and-branches": ({ variant }, { elmRoot, patch, patchRoot = elmRoot, originals }) => {
    const { runs, removed } = changedLines(patch, elmRoot, patchRoot, originals);
    const added = runs.flat().map(({ text }) => text);
    // How far a text is the body of a branch: "whole", "begun" while the lines below it can still
    // complete it, or null for anything else. A body is Debug.todo and one string literal, and
    // any message will do. The language server's own tool writes "Handle <variant>", and what the
    // task is about is the branch, not the wording of a placeholder. Nor is it about brackets,
    // around the call, the function or the message, about the quotes of the message, one or three,
    // about a "<|" that hands the message over, or about the lines the call is laid out on. With
    // nothing but those in it, a text that the compiler takes is that call.
    const bodyState = (text) => {
      const words = [];
      let depth = 0;
      for (let at = 0; at < text.trimEnd().length; at = BODY_PART.lastIndex) {
        BODY_PART.lastIndex = at;
        const part = BODY_PART.exec(text);
        if (!part) return null;
        const [, bracket, call, handsOver, tripleQuoted, itsEnd] = part;
        if (bracket === "(") depth++;
        else if (bracket === ")" && --depth < 0) return null;
        else if (handsOver && words.at(-1) !== "call") return null;
        else if (!bracket && !handsOver) words.push(call ? "call" : tripleQuoted !== undefined && itsEnd === undefined ? "message without an end" : "message");
      }
      const [first, second, ...more] = words;
      if ((first ?? "call") !== "call" || more.length > 0) return null;
      return second === "message" && depth === 0 ? "whole" : "begun";
    };
    const noBody = `a branch for ${variant} is followed by something else than a Debug.todo with a message`;
    // The line that adds the variant to its type: a bar, any blanks and the variant, as in "| Dot" or "|Dot"
    const addsVariant = (line) => line.startsWith("|") && line.slice(1).trim() === variant;
    // What stands behind the arrow of a branch for the variant, or null for any other line. The
    // pattern has to name the variant in code: a catch-all with the name in a comment is no
    // branch for it. Neither is a line with something else than a body behind its arrow.
    // `before` is the code of the lines above that the pattern began on, where it takes several.
    // Such a pattern is a pattern and nothing else, with every bracket closed at its arrow.
    const behindBranch = (line, code, before = "") => {
      const arrow = code.indexOf("->");
      const pattern = `${before} ${code.slice(0, arrow)}`;
      if (arrow === -1 || !mentions(pattern, variant)) return null;
      if (before !== "" && !(PATTERN_PARTS.test(pattern) && openBrackets(pattern) === 0)) return null;
      const behind = line.slice(arrow + 2).trim();
      return bodyState(behind) === null ? null : behind;
    };

    const stray = [];
    let branches = 0;
    let unfinished = false;
    for (const run of runs) {
      // The body of the branch that is being read, as far as its lines went. Null between branches.
      let body = null;
      // How deep the pattern of that branch is indented
      let indent = 0;
      // The lines of a pattern that has not come to its arrow. A pattern goes on in the next line
      // while one of its brackets is open, as a tuple with an item to a line does. Its arrow has
      // to stand on the line where it ends: one on a line of its own ends no pattern here.
      let pattern = [];
      for (const { text: line, code, indent: lineIndent, below } of run) {
        if (body === null) {
          const before = pattern.map(({ code }) => code).join(" ");
          if (code.trim() !== "" && PATTERN_PARTS.test(code) && openBrackets(`${before} ${code}`) > 0) {
            pattern.push({ text: line, code, indent: lineIndent });
            continue;
          }
          body = behindBranch(line, code, before);
          if (body === null) {
            stray.push(...pattern.map(({ text }) => text), ...(addsVariant(line) && code.trim() === line ? [] : [line]));
            pattern = [];
            continue;
          }
          indent = pattern[0]?.indent ?? lineIndent;
          pattern = [];
          branches++;
        } else {
          body = `${body} ${line}`.trim();
        }
        const state = bodyState(body);
        if (state === null) return noBody;
        // A line indented deeper than the pattern goes on with the body, by Elm's layout rule. The first
        // line of code below a body has to begin a branch of its own or end the case, or the branch took
        // that line over from the one above, which loses it.
        if (state === "whole" && below > indent) {
          return `a branch for ${variant} takes over the line below it, which is indented deeper than the branch's pattern`;
        }
        if (state === "whole") body = null;
      }
      // A pattern that never came to its arrow is no branch
      stray.push(...pattern.map(({ text }) => text));
      // A body goes on in the lines right below its branch, and in no others
      unfinished ||= body !== null;
    }
    if (removed.length > 0 || stray.length > 0) {
      return `changed more than the variant and its branches: ${[...removed.map((line) => `-${line}`), ...stray.map((line) => `+${line || "<blank line in a literal>"}`)].slice(0, 5).join(" / ")}`;
    }
    // Another expectation finds the variant on the type that was named. A second one went onto
    // another type, a namesake in another module for one, where it compiles just as well.
    const variants = added.filter(addsVariant).length;
    if (variants > 1) return `${variant} was added ${variants} times, and one type was to get it`;
    if (unfinished) return noBody;
    return branches > 0 ? null : `no branch for ${variant} was added`;
  },

  // A refactoring of Elm code changes Elm files of the project. Of what the commit holds, a data
  // file, a script or the build's own configuration that changed along is no part of it, whatever
  // the compiler says, and neither is any file beside the Elm project root, where no source of
  // the project lies. A file the commit does not hold is what some build wrote, or a note, and
  // no change.
  "only-elm-files": ({ except = [] }, { changed, committed }) => {
    const isBeside = (file) => file === ".." || file.startsWith("../");
    const stray = changed.filter((file) => committed.has(file) && (isBeside(file) || !file.endsWith(".elm")) && !except.includes(file));
    return stray.length > 0 ? `changed files that are no Elm sources of the project: ${stray.join(", ")}` : null;
  },

  // A package lists the modules it exposes in elm.json, where the renamed one takes its new
  // name. The compiler reads that list when it builds the package whole. A build of one file
  // passes with the old name in it, so the list is read here. Nothing else in that file is the
  // task's to change.
  "elm-json-renames-only": ({ from, to }, { elmRoot, changed, originals }) => {
    const renamed = (value) => {
      if (Array.isArray(value)) return value.map(renamed);
      if (value === null || typeof value !== "object") return value === from ? to : value;
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, renamed(inner)]));
    };
    try {
      const now = JSON.parse(read(elmRoot, "elm.json"));
      const was = changed.includes("elm.json") ? JSON.parse(originals.get("elm.json")) : now;
      const expected = "exposed-modules" in was ? { ...was, "exposed-modules": renamed(was["exposed-modules"]) } : was;
      if (isDeepStrictEqual(now, expected)) return null;
      if (isDeepStrictEqual(now, was)) return `elm.json still lists ${from} among the modules it exposes`;
    } catch {
      // Gone, or no JSON any more
    }
    return `elm.json changed in more than the name of ${from} among the modules it exposes`;
  },

  // A file that cannot use the target can still name it in a comment, which a search and replace
  // corrects along. Where its tokens are the ones it had, with no name to change, its code is the same.
  "changes-only-in": ({ files }, { elmRoot, changed, originals }) => {
    const allowed = new Set(files);
    const sameCode = (file) => {
      const [before, after] = [originals.get(file) ?? null, read(elmRoot, file)];
      return before !== null && after !== null && beyondRename(before, after, { of: "function" }) === null;
    };
    const stray = changed.filter((file) => file.endsWith(".elm") && !allowed.has(file) && !sameCode(file));
    return stray.length > 0 ? `changed files that cannot use the target: ${stray.join(", ")}` : null;
  },
};

// How deep the first line from `from` on that holds code or a literal is indented, read in the
// lines of layoutOf. The end of the file ends every declaration, as a line in column 0 does. So
// does a line that begins with a closing bracket or a comma, whatever its indent: the brackets of
// a body are closed where it ends, and such a line ends an expression around its case.
function indentBelow(layout, from) {
  for (let at = from; at < (layout?.length ?? 0); at++) {
    const line = layout[at].trimStart();
    if (line !== "") return /^[)\]},]/.test(line) ? 0 : layout[at].length - line.length;
  }
  return 0;
}

/**
 * The lines a patch adds to Elm files and the lines it removes from them,
 * trimmed, without blank ones. A changed line counts as one of each. The
 * added lines come in runs: the lines of one run stand one below the other
 * in their file, with nothing but blank lines between them. An added line
 * also says how deep it is indented, and how deep the next line of its file
 * that holds code or a literal is: 0 where no line below holds either, where
 * that line ends an expression around the case, and where the file cannot be
 * read.
 * @returns {{ runs: { text: string, code: string, indent: number, below: number }[][], removed: string[] }}
 */
function changedLines(patch, elmRoot, patchRoot, originals) {
  const runs = [];
  const removed = [];
  // The run that the next added line joins. Null once another line came, or another hunk.
  let run = null;
  const lines = patch.split("\n");
  // git says on the next line when a line is the last of its file and ends in no line break
  const isUnended = (at) => lines[at + 1]?.startsWith("\\ No newline") === true;
  let inElmFile = false;
  let code = null;
  let layout = null;
  let newLine = 0;
  let oldLine = 0;
  let newLiterals = new Set();
  let oldLiterals = new Set();
  let inHunk = false;
  // A last line that gains or loses its line break is shown as removed and added again, and it
  // did not change unless the added one reads differently. `unended` is such a line of the file
  // as it was, until the added lines tell. `lastRemoved` is the line removed last with nothing
  // but added lines since, which an unended line of the file as it is now may repeat.
  let unended = null;
  let lastRemoved = null;
  const settle = (next) => {
    const same = unended !== null && unended === next;
    if (unended !== null && !same) {
      removed.push(unended.trim());
      lastRemoved = null;
    }
    unended = null;
    return same;
  };
  for (const [at, line] of lines.entries()) {
    // A run goes on with the next added line. Any other line ends it, and so does an added line
    // that did not change. A blank line of the file between two added lines does not, and
    // neither does git's note on a missing line break.
    const before = run;
    if (!line.startsWith("\\") && line.trim() !== "") run = null;
    if (line.startsWith("diff --git ")) {
      settle();
      lastRemoved = null;
      inElmFile = line.endsWith(".elm");
      inHunk = false;
      code = null;
      layout = null;
      newLiterals = new Set();
      oldLiterals = new Set();
    } else if (!inHunk && line.startsWith("+++ b/")) {
      const file = relative(elmRoot, resolve(patchRoot, line.slice(6).replace(/\t$/, "")));
      const text = read(elmRoot, file);
      code = text === null ? null : codeOnly(text).split("\n");
      layout = text === null ? null : layoutOf(text).split("\n");
      newLiterals = literalLineStarts(text ?? "");
      oldLiterals = literalLineStarts(originals?.get(file) ?? "");
    } else if (line.startsWith("@@")) {
      newLine = Number(/\+(\d+)/.exec(line)?.[1] ?? 1) - 1;
      oldLine = Number(/-(\d+)/.exec(line)?.[1] ?? 1) - 1;
      lastRemoved = null;
      inHunk = inElmFile;
    } else if (!inHunk) continue;
    else if (line.startsWith("-")) {
      const text = line.slice(1);
      if (isUnended(at)) unended = text;
      else {
        removed.push(text.trim() || (oldLiterals.has(oldLine) ? "<blank line in a literal>" : ""));
        lastRemoved = text;
      }
      oldLine++;
    } else if (line.startsWith("+")) {
      const text = line.slice(1);
      // Read the line in its whole file. A string or comment can begin above the hunk.
      const lexical = code?.[newLine] ?? codeOnly(text);
      const inLiteral = newLiterals.has(newLine++);
      if (settle(line.slice(1))) continue;
      if (isUnended(at) && lastRemoved === line.slice(1)) {
        removed.pop();
        continue;
      }
      run = before ?? [];
      if (before === null) runs.push(run);
      const indent = text.length - text.trimStart().length;
      if (text.trim() !== "" || inLiteral) run.push({ text: text.trim(), code: lexical.slice(indent), indent, below: indentBelow(layout, newLine) });
    } else if (!line.startsWith("\\")) {
      newLine++;
      oldLine++;
      lastRemoved = null;
    }
  }
  settle();
  return { runs: runs.filter((lines) => lines.length > 0), removed: removed.filter(Boolean) };
}

/**
 * Check what a task expects against the project as the agent left it.
 * @param {string} elmRoot
 * @param {object[]} expect  The task's expectations
 * @param {object} left      What the session left behind
 * @param {string[]} left.changed  The files it changed, relative to the Elm root
 * @param {string} left.patch      The same changes as a unified diff
 * @param {string} [left.patchRoot=elmRoot]  The directory that the patch names its paths from
 * @param {Map<string, string | null>} left.originals  The text of each changed Elm file and of elm.json when the session began, null for a new one
 * @param {Set<string>} left.committed  The files that the starting commit holds
 * @returns {string[]} one sentence per expectation that does not hold
 */
export function unmetExpectations(elmRoot, expect, left) {
  return expect.map((expectation) => CHECKS[expectation.kind](expectation, { elmRoot, ...left })).filter(Boolean);
}
