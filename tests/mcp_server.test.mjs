/**
 * The MCP server as a harness sees it: what it lists and how it answers.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { PATH_ARGUMENTS, tools } from "../mcp-wrapper/tools.mjs";
import {
  callTool,
  connect,
  connectOverHttp,
  copyFixture,
  installLanguageServerStandIn,
  installLocalTool,
  installTool,
  runNode,
  SERVER,
  tempDir,
  wrapperCopy,
} from "./support.mjs";

// Root reads and writes every file, whatever its permissions say
const asRoot = process.getuid?.() === 0 && "permissions do not hold root back";

// The text of every Elm file in the project's src
function sourcesOf(project) {
  const src = join(project, "src");
  const names = readdirSync(src, { recursive: true }).filter((name) => name.endsWith(".elm"));
  return Object.fromEntries(names.sort().map((name) => [name, readFileSync(join(src, name), "utf-8")]));
}

// Add a source directory to the project's elm.json.
function addSourceDirectory(project, directory) {
  const elmJson = JSON.parse(readFileSync(join(project, "elm.json"), "utf-8"));
  elmJson["source-directories"].push(directory);
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson));
}

test("the server works from a directory that is not an Elm project", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: tempDir(t) });

  const symbols = await callTool(client, "elm_symbols", { file_path: join(project, "src/Types.elm") });
  assert.equal(symbols.isError, false);
  assert.match(symbols.text, /defaultUser \(Function\) at line 11/);
});

test("a relative path resolves against the server's working directory", async (t) => {
  const project = copyFixture(t);
  const elsewhere = tempDir(t);

  const inProject = await connect(t, { cwd: project });
  const found = await callTool(inProject, "elm_symbols", { file_path: "src/Types.elm" });
  assert.match(found.text, /Found 4 symbols/);

  // From another directory the same path points nowhere, and the error shows where it pointed
  const outside = await connect(t, { cwd: elsewhere });
  const lost = await callTool(outside, "elm_symbols", { file_path: "src/Types.elm" });
  assert.equal(lost.isError, true);
  assert.ok(lost.text.includes(join(elsewhere, "src/Types.elm")), lost.text);
});

test("one server serves several projects in turn", async (t) => {
  const first = copyFixture(t, "first");
  const second = copyFixture(t, "second");
  const client = await connect(t, { cwd: tempDir(t) });

  for (const project of [first, second, first, second]) {
    const symbols = await callTool(client, "elm_symbols", { file_path: join(project, "src/Types.elm") });
    assert.deepEqual(symbols, {
      text: "Found 4 symbols:\nUser (Event) at line 4\ndefaultUser (Function) at line 11\nGuest (Event) at line 19\ncreateGuest (Function) at line 24",
      isError: false,
    });
  }
});

// The second name holds characters that URL libraries disagree about escaping
for (const name of ["my élm project", "a~b [1] ^c|d #2 50%"]) {
  test(`a project in a directory called "${name}" works end to end`, async (t) => {
    const project = copyFixture(t, name);
    const client = await connect(t, { cwd: tempDir(t) });
    const utils = join(project, "src/Utils.elm");
    const original = readFileSync(utils, "utf-8");

    const definition = await callTool(client, "elm_definition", {
      file_path: join(project, "src/Main.elm"),
      line: 30,
      character: 13,
    });
    assert.equal(definition.text, `Definition at ${join(project, "src/Types.elm")}:12:0`);

    // formatName is defined in Utils.elm and used in Main.elm
    const rename = await callTool(client, "elm_rename_function", {
      file_path: utils,
      line: 6,
      character: 0,
      old_name: "formatName",
      newName: "shout",
    });
    assert.equal(rename.isError, false, rename.text);
    assert.match(rename.text, /Applied 6 edit\(s\) in 2 file\(s\)/);
    assert.match(readFileSync(utils, "utf-8"), /^shout name =$/m);
    assert.match(readFileSync(join(project, "src/Main.elm"), "utf-8"), /shout model\.user\.name/);
    // A second refactoring works on what the first one wrote
    const back = await callTool(client, "elm_rename_function", {
      file_path: utils,
      line: 6,
      character: 0,
      old_name: "shout",
      newName: "formatName",
    });
    assert.match(back.text, /Applied 6 edit\(s\) in 2 file\(s\)/);
    assert.equal(readFileSync(utils, "utf-8"), original);
  });
}

test("two calls for one project at the same time run one after the other", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });
  const utils = join(project, "src/Utils.elm");
  const rename = (line, old_name, newName) => callTool(client, "elm_rename_function", { file_path: utils, line, character: 0, old_name, newName });

  // Sent together, as a harness does when the model asks for two tool calls in one turn
  const answers = await Promise.all([rename(6, "formatName", "formatTheName"), rename(11, "greet", "welcome")]);

  assert.deepEqual(answers.map((answer) => answer.isError), [false, false]);
  // Computed from the same text, the second rename would write its edits where the first moved everything along
  assert.match(readFileSync(join(project, "src/Main.elm"), "utf-8"), /^import Utils exposing \(formatTheName, welcome\)$/m);
  assert.match(readFileSync(utils, "utf-8"), /^module Utils exposing \(formatTheName, welcome, helper\)$/m);
});

test("a project that is reached through a link takes its turn with the same project under its own path", async (t) => {
  const project = copyFixture(t);
  const linked = join(tempDir(t), "linked");
  symlinkSync(project, linked);
  const client = await connect(t, { cwd: project });
  const rename = (root, line, old_name, newName) =>
    callTool(client, "elm_rename_function", { file_path: join(root, "src/Utils.elm"), line, character: 0, old_name, newName });

  // The two spellings have a language server each. What they write is the same files.
  const answers = await Promise.all([rename(project, 6, "formatName", "formatTheName"), rename(linked, 11, "greet", "welcome")]);

  assert.deepEqual(answers.map((answer) => answer.isError), [false, false]);
  assert.match(readFileSync(join(project, "src/Main.elm"), "utf-8"), /^import Utils exposing \(formatTheName, welcome\)$/m);
});

test("a file is never renamed or moved onto an existing file", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });
  const utils = join(project, "src/Utils.elm");
  const types = join(project, "src/Types.elm");
  const before = { utils: readFileSync(utils, "utf-8"), types: readFileSync(types, "utf-8") };

  const renamed = await callTool(client, "elm_rename_file", { file_path: utils, new_name: "Types.elm" });
  assert.deepEqual(renamed, { text: `Cannot rename file: ${types} already exists`, isError: true });

  const moved = await callTool(client, "elm_move_file", { file_path: utils, target_path: "src/Types.elm" });
  assert.deepEqual(moved, { text: `Cannot move file: ${types} already exists`, isError: true });

  // Neither file was touched, not even by the import edits that precede the move
  assert.deepEqual({ utils: readFileSync(utils, "utf-8"), types: readFileSync(types, "utf-8") }, before);
});

test("a file is never renamed or moved out of its project", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });
  const utils = join(project, "src/Utils.elm");
  const outside = join(dirname(project), "Outside.elm");
  const noDirectory = "New name must be a file name without a directory. elm_move_file moves a file to another directory.";
  const leavesProject = `Path ${outside} is outside workspace ${project}`;
  const rename = (new_name) => callTool(client, "elm_rename_file", { file_path: utils, new_name });
  const move = (target_path) => callTool(client, "elm_move_file", { file_path: utils, target_path });

  assert.deepEqual(await rename("../../Outside.elm"), { text: noDirectory, isError: true });
  assert.deepEqual(await rename("Helpers/Utils.elm"), { text: noDirectory, isError: true });
  assert.deepEqual(await move("../Outside.elm"), { text: leavesProject, isError: true });
  assert.deepEqual(await move("src/../../Outside.elm"), { text: leavesProject, isError: true });
  assert.deepEqual(await move(outside), { text: leavesProject, isError: true });
  assert.equal(existsSync(outside), false);
  assert.ok(existsSync(utils));

  // A roundabout spelling of a place inside the project is taken for the place it names
  const moved = await move("./src/Helpers/../Helpers/Text.elm");
  assert.equal(moved.isError, false, moved.text);
  assert.match(readFileSync(join(project, "src/Helpers/Text.elm"), "utf-8"), /^module Helpers\.Text exposing/);
  assert.match(readFileSync(join(project, "src/Main.elm"), "utf-8"), /^import Helpers\.Text exposing/m);
});

test("a file is not moved out of its project through a linked directory", async (t) => {
  const project = copyFixture(t);
  const elsewhere = tempDir(t);
  symlinkSync(elsewhere, join(project, "src/External"));
  const client = await connect(t, { cwd: project });
  const before = sourcesOf(project);

  const moved = await callTool(client, "elm_move_file", { file_path: join(project, "src/Utils.elm"), target_path: "src/External/Utils.elm" });
  assert.deepEqual(moved, {
    text: `Path ${join(project, "src/External/Utils.elm")} leads out of workspace ${project}, through a link to ${join(realpathSync(elsewhere), "Utils.elm")}`,
    isError: true,
  });
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.deepEqual(sourcesOf(project), before);
});

test("a moved module is named by its path below its source directory, or not moved", async (t) => {
  const project = copyFixture(t);
  addSourceDirectory(project, "lib");
  mkdirSync(join(project, "lib"));
  // The server runs somewhere else. A relative target still starts at the project root.
  const client = await connect(t, { cwd: tempDir(t) });
  const utils = join(project, "src/Utils.elm");
  const before = sourcesOf(project);
  const move = (target_path) => callTool(client, "elm_move_file", { file_path: utils, target_path });
  const noName = (part) =>
    `Error: "${part}" cannot be part of a module name. Below the source directory, every directory and the file need a name that starts with an upper-case letter and holds only letters, digits and underscores`;

  assert.deepEqual(await move("tests/Utils.elm"), {
    text: `Error: ${join(project, "tests/Utils.elm")} is in no source directory of elm.json (src, lib)`,
    isError: true,
  });
  assert.deepEqual(await move("src/helpers/Utils.elm"), { text: noName("helpers"), isError: true });
  // A file where a directory would have to be
  assert.deepEqual(await move("src/Main.elm/Sub/Utils.elm"), { text: noName("Main.elm"), isError: true });
  assert.deepEqual(await move("src/Helpers/utils.elm"), { text: noName("utils"), isError: true });
  assert.deepEqual(await callTool(client, "elm_rename_file", { file_path: utils, new_name: "utils.elm" }), {
    text: 'Error: "utils" is no module name. It has to start with an upper-case letter and hold only letters, digits and underscores',
    isError: true,
  });
  // What only looks like a letter is none for the compiler: a mark that joins the letter before it, a letter in a square
  for (const odd of ["A\u0345", "A\u05b0", "\u{1F130}x"]) {
    assert.deepEqual(await callTool(client, "elm_rename_file", { file_path: utils, new_name: `${odd}.elm` }), {
      text: `Error: "${odd}" is no module name. It has to start with an upper-case letter and hold only letters, digits and underscores`,
      isError: true,
    });
  }
  assert.deepEqual(sourcesOf(project), before);

  // Into another source directory, the module keeps the name it had: "lib" is no part of it
  const moved = await move("lib/Utils.elm");
  assert.equal(moved.isError, false, moved.text);
  assert.match(readFileSync(join(project, "lib/Utils.elm"), "utf-8"), /^module Utils exposing/);
  assert.match(readFileSync(join(project, "src/Main.elm"), "utf-8"), /^import Utils exposing/m);
  assert.equal(existsSync(utils), false);

  // A letter of any script is a letter, as for the compiler, in the name of a file and of a directory
  const accented = await callTool(client, "elm_rename_file", { file_path: join(project, "lib/Utils.elm"), new_name: "Été.elm" });
  assert.equal(accented.isError, false, accented.text);
  assert.match(readFileSync(join(project, "lib/Été.elm"), "utf-8"), /^module Été exposing/);
  const below = await callTool(client, "elm_move_file", { file_path: join(project, "src/Types.elm"), target_path: "src/Modèles/Types.elm" });
  assert.equal(below.isError, false, below.text);
  assert.match(readFileSync(join(project, "src/Modèles/Types.elm"), "utf-8"), /^module Modèles\.Types exposing/);
  const main = join(project, "src/Main.elm");
  assert.match(readFileSync(main, "utf-8"), /^import Modèles\.Types exposing \(User, defaultUser\)\nimport Été exposing \(formatName, greet\)$/m);
  assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: main }), { text: "No errors or warnings", isError: false });
});

test("a rename that only changes letter case goes through", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });

  // On a file system that ignores case, UTILS.elm already "exists" as Utils.elm
  const renamed = await callTool(client, "elm_rename_file", {
    file_path: join(project, "src/Utils.elm"),
    new_name: "UTILS.elm",
  });
  assert.equal(renamed.isError, false, renamed.text);
  assert.ok(readdirSync(join(project, "src")).includes("UTILS.elm"));
  assert.match(readFileSync(join(project, "src/UTILS.elm"), "utf-8"), /^module UTILS exposing/);
  assert.match(readFileSync(join(project, "src/Main.elm"), "utf-8"), /^import UTILS exposing/m);
});

// A compiler stand-in. It rejects every build with one error that carries its
// own name as the title, for the file it was given ($2).
const compilerNamed = (name) => `cat >&2 <<JSON
{"type":"compile-errors","errors":[{"path":"$2","name":"Main","problems":[{"title":"${name}","region":{"start":{"line":3,"column":1},"end":{"line":3,"column":7}},"message":["this compiler ran"]}]}]}
JSON
exit 1`;

// Ask for diagnostics of the project's Main.elm and return the name of the compiler that answered.
// `globalTools` maps tool names to scripts that are installed at the front of the server's PATH.
async function compilerUsed(t, project, globalTools, { restOfPath = process.env.PATH, args = [] } = {}) {
  const globalBin = tempDir(t);
  for (const [name, script] of Object.entries(globalTools)) {
    installTool(globalBin, name, script);
  }
  const client = await connect(t, { args, cwd: tempDir(t), env: { PATH: `${globalBin}:${restOfPath}` } });
  const diagnostics = await callTool(client, "elm_diagnostics", { file_path: join(project, "src/Main.elm") });
  return /^Line 3:1 - (.*)\n\nthis compiler ran$/.exec(diagnostics.text)?.[1] ?? diagnostics.text;
}

const globalCompilers = { elm: compilerNamed("GLOBAL ELM"), lamdera: compilerNamed("GLOBAL LAMDERA") };

test("with --project-tools an Elm project is built with the elm in its node_modules", async (t) => {
  const project = copyFixture(t);
  installLocalTool(project, "elm", compilerNamed("PROJECT ELM"));

  assert.equal(await compilerUsed(t, project, globalCompilers, { args: ["--project-tools"] }), "PROJECT ELM");
});

test("without --project-tools nothing in a project's node_modules is run", async (t) => {
  const project = copyFixture(t);
  const ran = join(project, "project-tool-ran");
  for (const tool of ["elm", "lamdera", "elm-format"]) {
    installLocalTool(project, tool, `echo ${tool} >> "${ran}"`);
  }
  const globalBin = tempDir(t);
  installTool(globalBin, "elm", "exit 0");
  installTool(globalBin, "elm-format", "exit 0");
  const file = join(project, "src/Main.elm");

  // The read-only server is the one a harness may call without asking
  const client = await connect(t, { args: ["--read-only"], cwd: project, env: { PATH: `${globalBin}:/usr/bin:/bin` } });
  assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: file }), { text: "No errors or warnings", isError: false });

  const writing = await connect(t, { cwd: project, env: { PATH: `${globalBin}:/usr/bin:/bin` } });
  assert.equal((await callTool(writing, "elm_format", { file_path: file })).isError, false);
  assert.equal(existsSync(ran), false, "no program from the project's node_modules ran");
});

test("a Lamdera project is built with lamdera, not with the elm in its node_modules", async (t) => {
  const project = copyFixture(t);
  const elmJson = JSON.parse(readFileSync(join(project, "elm.json"), "utf-8"));
  elmJson.dependencies.direct["lamdera/core"] = "1.0.0";
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson));
  installLocalTool(project, "elm", compilerNamed("PROJECT ELM"));

  assert.equal(await compilerUsed(t, project, globalCompilers), "GLOBAL LAMDERA");
});

test("lamdera builds an Elm project on a machine without elm", async (t) => {
  const project = copyFixture(t);

  // A PATH with the system tools and no Elm compiler other than the stand-in
  const used = await compilerUsed(t, project, { lamdera: globalCompilers.lamdera }, { restOfPath: "/usr/bin:/bin" });
  assert.equal(used, "GLOBAL LAMDERA");
});

test("elm_diagnostics fails when it has no verdict from a compiler", async (t) => {
  const project = copyFixture(t);
  const file = join(project, "src/Main.elm");
  const diagnosticsWith = async (globalTools) => {
    const globalBin = tempDir(t);
    for (const [name, script] of Object.entries(globalTools)) {
      installTool(globalBin, name, script);
    }
    const client = await connect(t, { cwd: project, env: { PATH: `${globalBin}:/usr/bin:/bin` } });
    return callTool(client, "elm_diagnostics", { file_path: file });
  };

  // "No errors or warnings" here would send an agent on with a project nobody compiled
  assert.deepEqual(await diagnosticsWith({}), {
    text: "Could not run the Elm compiler: neither elm nor lamdera could be started. Is one of them on PATH?",
    isError: true,
  });
  assert.deepEqual(await diagnosticsWith({ elm: "echo 'elm: Map.!: given key is not an element in the map' >&2\nexit 1" }), {
    text: "The compiler failed, and its report could not be read: elm: Map.!: given key is not an element in the map",
    isError: true,
  });
});

test("a tool that is missing from PATH points at the project's own copy and --project-tools", async (t) => {
  const project = copyFixture(t);
  const file = join(project, "src/Main.elm");
  const bin = join(project, "node_modules", ".bin");
  installLocalTool(project, "elm", "exit 0");
  installLocalTool(project, "elm-format", "exit 0");
  const client = await connect(t, { cwd: project, env: { PATH: "/usr/bin:/bin" } });

  assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: file }), {
    text:
      "Could not run the Elm compiler: neither elm nor lamdera could be started. Is one of them on PATH?" +
      ` This project has elm in ${bin}. Pass --project-tools to use it.`,
    isError: true,
  });
  assert.deepEqual(await callTool(client, "elm_format", { file_path: file }), {
    text: `elm-format is not on PATH. This project has elm-format in ${bin}. Pass --project-tools to use it.`,
    isError: true,
  });
});

test("elm_diagnostics knows its file under the path the compiler resolved", async (t) => {
  const project = copyFixture(t);
  const link = join(tempDir(t), "link");
  symlinkSync(project, link);
  const globalBin = tempDir(t);
  // A compiler that names the file by its resolved path, as elm does
  installTool(
    globalBin,
    "elm",
    `resolved="$(cd "$(dirname "$2")" && pwd -P)/$(basename "$2")"
cat >&2 <<JSON
{"type":"compile-errors","errors":[{"path":"$resolved","name":"Main","problems":[{"title":"NAMING ERROR","region":{"start":{"line":3,"column":1},"end":{"line":3,"column":7}},"message":["broken"]}]}]}
JSON
exit 1`
  );
  const client = await connect(t, { cwd: tempDir(t), env: { PATH: `${globalBin}:/usr/bin:/bin` } });

  // Read as another file's error, this would say that Main.elm itself is fine
  assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: join(link, "src/Main.elm") }), {
    text: "Line 3:1 - NAMING ERROR\n\nbroken",
    isError: false,
  });
});

test("elm_diagnostics says when the errors are in other files", async (t) => {
  const project = copyFixture(t);
  const main = join(project, "src/Main.elm");
  const types = join(project, "src/Types.elm");
  // A compiler that fails with whatever report the test wrote last
  const globalBin = tempDir(t);
  const report = join(globalBin, "report.json");
  installTool(globalBin, "elm", `cat "${report}" >&2\nexit 1`);
  const client = await connect(t, { cwd: project, env: { PATH: `${globalBin}:/usr/bin:/bin` } });
  const problem = (title, line) => ({
    title,
    region: { start: { line, column: 1 }, end: { line, column: 7 } },
    message: ["broken"],
  });
  const diagnosticsOf = (file, problemsByPath) => {
    const errors = Object.entries(problemsByPath).map(([path, problems]) => ({ path, name: "Module", problems }));
    writeFileSync(report, JSON.stringify({ type: "compile-errors", errors }));
    return callTool(client, "elm_diagnostics", { file_path: file });
  };

  const inTypes = { [types]: [problem("NAMING ERROR", 3)] };
  assert.deepEqual(await diagnosticsOf(main, inTypes), {
    text: `No errors in this file, but the project does not compile. Errors in other files:\n  ${types}:3 - NAMING ERROR`,
    isError: false,
  });
  assert.deepEqual(await diagnosticsOf(types, inTypes), { text: "Line 3:1 - NAMING ERROR\n\nbroken", isError: false });
  assert.deepEqual(await diagnosticsOf(main, { ...inTypes, [main]: [problem("TYPE MISMATCH", 9)] }), {
    text: `Line 9:1 - TYPE MISMATCH\n\nbroken\n\nErrors in other files:\n  ${types}:3 - NAMING ERROR`,
    isError: false,
  });

  // A long list is cut after 20 entries
  const many = { [types]: Array.from({ length: 23 }, (_, i) => problem("NAMING ERROR", i + 1)) };
  const lines = (await diagnosticsOf(main, many)).text.split("\n");
  assert.equal(lines.length, 22);
  assert.deepEqual(lines.slice(-2), [`  ${types}:20 - NAMING ERROR`, "  ... and 3 more"]);
});

test("only elm_diagnostics runs the compiler", async (t) => {
  const project = copyFixture(t);
  const runs = join(project, "compiler-runs.log");
  // A compiler that records each run and finds nothing wrong
  const recordingCompiler = `echo run >> "${runs}"`;
  installLocalTool(project, "lamdera", recordingCompiler);
  installLocalTool(project, "elm", recordingCompiler);
  const client = await connect(t, { args: ["--project-tools"], cwd: project });
  const utils = join(project, "src/Utils.elm");

  // Navigation and a refactoring open and change documents, which used to start a build each time
  await callTool(client, "elm_symbols", { file_path: utils });
  await callTool(client, "elm_references", { file_path: utils, line: 6, character: 0 });
  const rename = await callTool(client, "elm_rename_function", {
    file_path: utils,
    line: 16,
    character: 0,
    old_name: "helper",
    newName: "assist",
  });
  assert.equal(rename.isError, false, rename.text);
  assert.equal(existsSync(runs), false, "no tool has run the compiler yet");

  const diagnostics = await callTool(client, "elm_diagnostics", { file_path: utils });
  assert.deepEqual(diagnostics, { text: "No errors or warnings", isError: false });
  assert.equal(readFileSync(runs, "utf-8"), "run\n");
});

test("with --project-tools, tools at the root of a monorepo are found from the Elm project inside it", async (t) => {
  const project = copyFixture(t, "client");
  const monorepo = dirname(project);
  installLocalTool(monorepo, "elm-format", 'echo "$@" > "$(dirname "$0")/elm-format.called"');
  const client = await connect(t, { args: ["--project-tools"], cwd: tempDir(t) });

  const file = join(project, "src/Main.elm");
  const formatted = await callTool(client, "elm_format", { file_path: file });
  assert.deepEqual(formatted, { text: `Successfully formatted ${file}`, isError: false });
  const record = join(monorepo, "node_modules/.bin/elm-format.called");
  assert.ok(existsSync(record), "the monorepo's elm-format ran");
  assert.equal(readFileSync(record, "utf-8"), `--yes ${file}\n`);
});

// The language server counts columns in bytes, and a string is indexed in UTF-16 code units
test("a rename lands on its symbol on a line with non-ASCII text before it", async (t) => {
  const project = copyFixture(t);
  const at = (name) => join(project, "src", name);
  // Two bytes for one code unit, and four bytes for two, in front of the name. Together more bytes than the
  // name has letters, so a column taken for a count of characters points past the name.
  writeFileSync(at("Main.elm"), readFileSync(at("Main.elm"), "utf-8").replace('" - Formatted: "', '"café \u{1F600}\u{1F600}\u{1F600}\u{1F600}: "'));
  // A module whose own name holds such letters has them on its module line and in every import of it
  writeFileSync(
    at("\u00c9t\u00e9.elm"),
    "module \u00c9t\u00e9 exposing (first, greeting, last)\n\n\nfirst =\n    1\n\n\ngreeting =\n    2\n\n\nlast =\n    3\n\n\n\u00e9t\u00e9 =\n    last\n\n\nagain =\n    \u00e9t\u00e9\n"
  );
  writeFileSync(at("Types.elm"), readFileSync(at("Types.elm"), "utf-8").replace("\n\n", "\n\nimport \u00c9t\u00e9 exposing (first, greeting, last)\n"));
  const client = await connect(t, { cwd: project });

  // A column that a result gives is one that a tool takes: the use behind those characters, back to its definition
  const uses = await callTool(client, "elm_references", { file_path: at("Utils.elm"), line: 6, character: 0 });
  const line = readFileSync(at("Main.elm"), "utf-8").split("\n").findIndex((text) => text.includes("café"));
  const [, column] = uses.text.match(new RegExp(`${at("Main.elm")}:${line + 1}:(\\d+)$`, "m")) ?? [];
  assert.ok(column, uses.text);
  const found = await callTool(client, "elm_definition", { file_path: at("Main.elm"), line, character: Number(column) });
  assert.match(found.text, new RegExp(`${at("Utils.elm")}:\\d+:0`));
  // A column inside a letter of two bytes means that letter: the second byte of the last letter of the use of été
  const within = await callTool(client, "elm_definition", { file_path: at("\u00c9t\u00e9.elm"), line: 20, character: 8 });
  assert.match(within.text, new RegExp(`${at("\u00c9t\u00e9.elm")}:16:0`));

  const renamed = await callTool(client, "elm_rename_function", { file_path: at("Utils.elm"), line: 6, character: 0, old_name: "formatName", newName: "shout" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(readFileSync(at("Main.elm"), "utf-8"), /"café \u{1F600}{4}: " \+\+ shout model\.user\.name/u);

  const inside = await callTool(client, "elm_rename_function", { file_path: at("\u00c9t\u00e9.elm"), line: 7, character: 0, old_name: "greeting", newName: "welcome" });
  assert.equal(inside.isError, false, inside.text);
  assert.match(readFileSync(at("\u00c9t\u00e9.elm"), "utf-8"), /^module \u00c9t\u00e9 exposing \(first, welcome, last\)$/m);
  assert.match(readFileSync(at("Types.elm"), "utf-8"), /^import \u00c9t\u00e9 exposing \(first, welcome, last\)$/m);
});

// The move takes the function's text and nothing the text depends on. Until it
// brings the imports along, this fails.
test.todo("a moved function takes along the imports it needs", async (t) => {
  const project = copyFixture(t);
  const target = join(project, "src/Target.elm");
  writeFileSync(target, "module Target exposing (..)\n");
  const client = await connect(t, { cwd: project });

  // greet : User -> String, and User comes from an import of Utils
  await callTool(client, "elm_move_function", {
    file_path: join(project, "src/Utils.elm"),
    line: 11,
    character: 0,
    function_name: "greet",
    target_module: target,
  });
  assert.match(readFileSync(target, "utf-8"), /^import Types exposing \(User\)$/m);
});

test("an answer that quotes non-ASCII source text arrives", async (t) => {
  const project = copyFixture(t);
  const file = join(project, "src/Drinks.elm");
  writeFileSync(
    file,
    [
      "module Drinks exposing (Drink(..), favourite)",
      "",
      "",
      "type Drink",
      "    = Coffee",
      "    | Tea",
      "",
      "",
      "favourite : ( Drink, String )",
      "favourite =",
      '    ( Coffee, "café crème ☕" )',
      "",
    ].join("\n")
  );
  const client = await connect(t, { cwd: project });

  // The preview quotes the line that constructs Coffee
  const preview = await callTool(client, "elm_prepare_remove_variant", { file_path: file, line: 4, character: 6 });
  assert.equal(preview.isError, false, preview.text);
  assert.match(preview.text, /Variant: Coffee/);
  assert.match(preview.text, /café crème ☕/);
});

test("a position past the end of a line with non-ASCII text gets an answer", async (t) => {
  const project = copyFixture(t);
  const file = join(project, "src/Accents.elm");
  writeFileSync(
    file,
    ["module Accents exposing (label)", "", "", "label : String", "label =", '    "ééééééééé" ++ "x"', ""].join("\n")
  );
  const client = await connect(t, { cwd: project });

  // Line 5 has 22 characters and 31 bytes. Character 25 is past its end but within its byte length.
  const pastTheEnd = await callTool(client, "elm_definition", { file_path: file, line: 5, character: 25 });
  assert.deepEqual(pastTheEnd, { text: "No definition found", isError: false });
});

test("the server tells the client how to address files", async (t) => {
  const client = await connect(t, { cwd: tempDir(t) });
  assert.match(client.getInstructions(), /absolute file paths/);
  assert.match(client.getInstructions(), /0-indexed/);
});

test("an option the server does not know stops it with the usage text", async () => {
  const cases = [
    // A typo of --read-only must not start a server that offers every tool
    [["--readonly"], /^Unknown option "--readonly"\n\nUsage: node index\.mjs \[options\]/],
    [["--http", "--stdio"], /^Choose either --http or --stdio/],
    [["--http", "--port"], /^--port needs a value/],
    [["--http", "--port", "seventy"], /^Invalid port: seventy/],
    [["--http", "--port", "3333abc"], /^Invalid port: 3333abc/],
    // An option in a value's place must not be swallowed as the value, least of all --read-only
    [["--host", "--read-only"], /^--host needs a value/],
    [["--http", "--port", "--read-only"], /^--port needs a value/],
    // Over stdio these two would be ignored without a word
    [["--port", "4000"], /^--port can only be used with --http/],
    [["--stdio", "--host", "0.0.0.0", "--port", "4000"], /^--host and --port can only be used with --http/],
  ];
  for (const [args, message] of cases) {
    const result = await runNode(SERVER, args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }

  const help = await runNode(SERVER, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: node index\.mjs \[options\]/);
});

test("requests that arrived before the input closed are answered", async (t) => {
  const project = copyFixture(t);
  const utils = join(project, "src/Utils.elm");
  const rename = { file_path: utils, line: 6, character: 0, old_name: "formatName", newName: "shout" };
  const messages = [
    {
      id: 1,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pipe", version: "1" } },
    },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/call", params: { name: "elm_rename_function", arguments: rename } },
  ];

  // As from "cat requests | node index.mjs": all three are in the pipe, and it is closed behind them
  const input = messages.map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n").join("");
  const { code, stdout } = await runNode(SERVER, [], { cwd: project, input });

  assert.equal(code, 0);
  const answers = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.match(answers.find((answer) => answer.id === 2).result.content[0].text, /Applied 6 edit\(s\) in 2 file\(s\)/);
  // The refactoring wrote every file before the server left
  assert.match(readFileSync(utils, "utf-8"), /^shout name =$/m);
  assert.match(readFileSync(join(project, "src/Main.elm"), "utf-8"), /shout model\.user\.name/);
});

test("a call the client cancelled does not keep the server once its input has closed", async (t) => {
  const project = copyFixture(t);
  const globalBin = tempDir(t);
  // A compiler that takes a second, so the call is still running when it is cancelled
  installTool(globalBin, "elm", "sleep 1");
  const messages = [
    {
      id: 1,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pipe", version: "1" } },
    },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/call", params: { name: "elm_diagnostics", arguments: { file_path: join(project, "src/Main.elm") } } },
    { method: "notifications/cancelled", params: { requestId: 2, reason: "the user pressed escape" } },
  ];
  const input = messages.map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n").join("");

  const started = Date.now();
  const { code } = await runNode(SERVER, [], { cwd: project, env: { PATH: `${globalBin}:/usr/bin:/bin` }, input });
  assert.equal(code, 0);
  // It gets no answer, so waiting for one would last the full minute of grace
  assert.ok(Date.now() - started < 20000, `the server stayed for ${Date.now() - started} ms`);
});

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A harness that is gone without a word: its end of the output is closed, and a request is still on its way
function stopReading(server) {
  server.stdout.destroy();
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }) + "\n");
}

for (const [how, end] of [
  ["closes its input", (server) => server.stdin.end()],
  ["sends SIGTERM", (server) => server.kill("SIGTERM")],
  ["stops reading the answers", stopReading],
]) {
  test(`a language server is stopped when the harness ${how}, even one that would stay`, async (t) => {
    // A stand-in that stays alive after its input has closed, which the real one does not
    const { server, binary } = wrapperCopy(t);
    installLanguageServerStandIn(binary);
    const project = copyFixture(t);
    const client = await connect(t, { server, cwd: project });
    await callTool(client, "elm_symbols", { file_path: join(project, "src/Types.elm") });
    const languageServer = Number(readFileSync(`${binary}.pid`, "utf-8"));
    t.after(() => isRunning(languageServer) && process.kill(languageServer, "SIGKILL"));
    assert.ok(isRunning(languageServer));

    const wrapper = client.transport._process;
    const closed = once(wrapper, "close");
    end(wrapper);
    const [code, signal] = await closed;
    assert.deepEqual({ code, signal }, { code: 0, signal: null });

    // The signal is on its way when the wrapper exits. Give it a moment to land.
    for (let waited = 0; isRunning(languageServer) && waited < 2000; waited += 20) {
      await sleep(20);
    }
    assert.equal(isRunning(languageServer), false, "the language server outlived the wrapper");
  });
}

test("the HTTP server offers the same tools and honours --read-only", async (t) => {
  const project = copyFixture(t);
  const { client, server } = await connectOverHttp(t, { args: ["--read-only"] });

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), READ_ONLY_TOOLS);
  const symbols = await callTool(client, "elm_symbols", { file_path: join(project, "src/Types.elm") });
  assert.match(symbols.text, /Found 4 symbols/);
  assert.equal((await callTool(client, "elm_format", { file_path: join(project, "src/Types.elm") })).isError, true);

  // SIGTERM ends it although a language server is running
  const closed = once(server, "close");
  server.kill("SIGTERM");
  assert.deepEqual(await closed, [0, null]);
});

// The second is the same address in a spelling of its own
for (const host of ["127.0.0.1", "127.1"]) {
  test(`the HTTP server at ${host} answers only requests addressed to this machine`, async (t) => {
    const { port } = await connectOverHttp(t, { args: ["--host", host] });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "page", version: "1" } },
    });
    // The status of an initialize request sent with the given headers on top of the usual ones
    const statusWith = (headers) =>
      new Promise((resolve, reject) => {
        const usual = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
        const sent = request({ port, path: "/mcp", method: "POST", headers: { ...usual, ...headers } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        sent.on("error", reject);
        sent.end(body);
      });

    assert.equal(await statusWith({}), 200);
    // A page that pointed its own domain at 127.0.0.1 sends that domain as the host
    assert.equal(await statusWith({ Host: `evil.example:${port}` }), 403);
    assert.equal(await statusWith({ Origin: "http://evil.example" }), 403);
  });
}

test("a port that is taken is reported in one line", async (t) => {
  const { port } = await connectOverHttp(t);
  assert.deepEqual(await runNode(SERVER, ["--http", "--port", String(port)]), {
    code: 1,
    stdout: "",
    stderr: `Cannot listen on 127.0.0.1:${port}: listen EADDRINUSE: address already in use 127.0.0.1:${port}\n`,
  });
});

// A package's elm.json lists no source directories. Its modules are in src.
const PACKAGE_ELM_JSON = {
  type: "package",
  name: "author/fixture",
  summary: "The fixture as a package",
  license: "BSD-3-Clause",
  version: "1.0.0",
  "exposed-modules": ["Utils"],
  "elm-version": "0.19.0 <= v < 0.20.0",
  dependencies: { "elm/browser": "1.0.0 <= v < 2.0.0", "elm/core": "1.0.0 <= v < 2.0.0", "elm/html": "1.0.0 <= v < 2.0.0" },
  "test-dependencies": {},
};

for (const kind of ["an application", "a package"]) {
  test(`in ${kind}, files the agent changed with its own tools are seen by the next call`, async (t) => {
    const project = copyFixture(t);
    if (kind === "a package") {
      writeFileSync(join(project, "elm.json"), JSON.stringify(PACKAGE_ELM_JSON));
    }
    const client = await connect(t, { cwd: project });
    const main = join(project, "src/Main.elm");
    const utils = join(project, "src/Utils.elm");
    // The first call starts the language server, which reads every file once
    await callTool(client, "elm_symbols", { file_path: utils });

    // Between calls: two lines added to one file, one file created, one deleted
    const shifted = readFileSync(main, "utf-8").replace("import Browser\n", "import Browser\n-- added\n-- by hand\n");
    writeFileSync(main, shifted);
    writeFileSync(join(project, "src/Extra.elm"), "module Extra exposing (loud)\n\nimport Utils\n\n\nloud =\n    Utils.formatName\n");
    rmSync(join(project, "src/FieldRename.elm"));

    const rename = await callTool(client, "elm_rename_function", {
      file_path: utils,
      line: 6,
      character: 0,
      old_name: "formatName",
      newName: "shout",
    });
    assert.equal(rename.isError, false, rename.text);
    // Edits computed from the old text of Main.elm would land two lines too high
    assert.equal(readFileSync(main, "utf-8"), shifted.replaceAll("formatName", "shout"));
    assert.match(readFileSync(join(project, "src/Extra.elm"), "utf-8"), /Utils\.shout/);
    assert.match(rename.text, /Applied 7 edit\(s\) in 3 file\(s\)/);
  });
}

test("a module moved to another source directory is found in its new place", async (t) => {
  const project = copyFixture(t);
  const elmJson = JSON.parse(readFileSync(join(project, "elm.json"), "utf-8"));
  elmJson["source-directories"].push("lib");
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson));
  mkdirSync(join(project, "lib"));
  const client = await connect(t, { cwd: project });
  // Main.elm calls greet, which Utils.elm defines
  const definitionOfGreet = () =>
    callTool(client, "elm_definition", { file_path: join(project, "src/Main.elm"), line: 48, character: 16 });
  assert.equal((await definitionOfGreet()).text, `Definition at ${join(project, "src/Utils.elm")}:12:0`);

  renameSync(join(project, "src/Utils.elm"), join(project, "lib/Utils.elm"));

  assert.equal((await definitionOfGreet()).text, `Definition at ${join(project, "lib/Utils.elm")}:12:0`);
});

test("a source directory that appears after the server started is indexed", async (t) => {
  const project = copyFixture(t);
  const elmJson = JSON.parse(readFileSync(join(project, "elm.json"), "utf-8"));
  elmJson["source-directories"].push("generated");
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson));
  const client = await connect(t, { cwd: project });
  const utils = join(project, "src/Utils.elm");
  await callTool(client, "elm_symbols", { file_path: utils });

  // A code generator writes its directory later. elm.json listed it all along.
  mkdirSync(join(project, "generated"));
  const consumer = join(project, "generated/Consumer.elm");
  const text = "module Consumer exposing (loud)\n\nimport Utils exposing (formatName)\n\n\nloud =\n    formatName\n";
  writeFileSync(consumer, text);

  const rename = await callTool(client, "elm_rename_function", {
    file_path: utils,
    line: 6,
    character: 0,
    old_name: "formatName",
    newName: "shout",
  });
  assert.equal(rename.isError, false, rename.text);
  assert.equal(readFileSync(consumer, "utf-8"), text.replaceAll("formatName", "shout"));
});

test("a source directory added to elm.json is indexed", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });
  const usesOfFormatName = () =>
    callTool(client, "elm_references", { file_path: join(project, "src/Utils.elm"), line: 6, character: 0 });
  mkdirSync(join(project, "lib"));
  const extra = join(project, "lib/Extra.elm");
  writeFileSync(extra, "module Extra exposing (loud)\n\nimport Utils\n\n\nloud =\n    Utils.formatName\n");
  // lib is no source directory yet, so the new module is not part of the project
  assert.doesNotMatch((await usesOfFormatName()).text, /Extra\.elm/);

  const elmJson = JSON.parse(readFileSync(join(project, "elm.json"), "utf-8"));
  elmJson["source-directories"].push("lib");
  writeFileSync(join(project, "elm.json"), JSON.stringify(elmJson));

  assert.match((await usesOfFormatName()).text, new RegExp(`${extra}:7:`));
});

test("a file outside the source directories is followed once a tool was called on it", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });
  const utils = join(project, "src/Utils.elm");
  const rename = (from, to) =>
    callTool(client, "elm_rename_function", { file_path: utils, line: 6, character: 0, old_name: from, newName: to });
  mkdirSync(join(project, "tests"));
  const utilsTest = join(project, "tests/UtilsTest.elm");
  const text = "module UtilsTest exposing (loud)\n\nimport Utils exposing (formatName)\n\n\nloud =\n    formatName\n";
  writeFileSync(utilsTest, text);
  // A test is no source file. The language server learns of it here.
  await callTool(client, "elm_symbols", { file_path: utilsTest });

  const shifted = text.replace("import Utils", "-- added\n-- by hand\nimport Utils");
  writeFileSync(utilsTest, shifted);
  const renamed = await rename("formatName", "shout");
  assert.equal(renamed.isError, false, renamed.text);
  // Edits computed from the text the server was given would land two lines too high
  assert.equal(readFileSync(utilsTest, "utf-8"), shifted.replaceAll("formatName", "shout"));

  rmSync(utilsTest);
  const back = await rename("shout", "formatName");
  assert.match(back.text, /Applied 6 edit\(s\) in 2 file\(s\)/);
});

test("a file out of reach is not taken for a deleted one", { skip: asRoot }, async (t) => {
  const project = copyFixture(t);
  const utils = join(project, "src/Utils.elm");
  const rename = (client, from, to) =>
    callTool(client, "elm_rename_function", { file_path: utils, line: 6, character: 0, old_name: from, newName: to });
  const consumer = (module) => `module ${module} exposing (loud)\n\nimport Utils exposing (formatName)\n\n\nloud =\n    formatName\n`;
  // A test, which the index knows from a tool call on it
  const tests = join(project, "tests");
  const utilsTest = join(tests, "UtilsTest.elm");
  mkdirSync(tests);
  writeFileSync(utilsTest, consumer("UtilsTest"));
  // A module that is a link to a file kept somewhere else
  const vault = join(tempDir(t), "vault");
  const linked = join(project, "src/Linked.elm");
  mkdirSync(vault);
  writeFileSync(join(vault, "Linked.elm"), consumer("Linked"));
  symlinkSync(join(vault, "Linked.elm"), linked);
  const client = await connect(t, { cwd: project });
  await callTool(client, "elm_symbols", { file_path: utilsTest });

  try {
    chmodSync(tests, 0o000);
    assert.deepEqual(await rename(client, "formatName", "shout"), {
      text: `Cannot read ${utilsTest}: Permission denied (os error 13).`,
      isError: true,
    });
    chmodSync(tests, 0o755);
    chmodSync(vault, 0o000);
    assert.deepEqual(await rename(client, "formatName", "shout"), {
      text: `Cannot read ${linked}: Permission denied (os error 13).`,
      isError: true,
    });
  } finally {
    chmodSync(tests, 0o755);
    chmodSync(vault, 0o755);
  }

  // Both in reach again, and neither was dropped from the index meanwhile
  const renamed = await rename(client, "formatName", "shout");
  assert.match(renamed.text, /Applied 10 edit\(s\) in 4 file\(s\)/);
  assert.equal(readFileSync(utilsTest, "utf-8"), consumer("UtilsTest").replaceAll("formatName", "shout"));
  assert.equal(readFileSync(linked, "utf-8"), consumer("Linked").replaceAll("formatName", "shout"));
});

// An agent copies a module, as a backup before a risky change or to start a new module from it.
// Until the copy has a name of its own, two files declare one module. The compiler reads the
// one whose path spells the name, and so does a refactoring, whatever becomes of the copy.
for (const [fate, settle] of [
  ["is still there", () => {}],
  ["is deleted", (copy) => rmSync(copy)],
  ["gets a name of its own", (copy) => writeFileSync(copy, readFileSync(copy, "utf-8").replace("module Utils ", "module UtilsBackup "))],
]) {
  test(`a module is refactored as itself when a copy of it ${fate}`, async (t) => {
    const project = copyFixture(t);
    const client = await connect(t, { cwd: project });
    const [main, utils, copy] = ["Main.elm", "Utils.elm", "UtilsBackup.elm"].map((name) => join(project, "src", name));
    await callTool(client, "elm_symbols", { file_path: utils });

    const text = readFileSync(utils, "utf-8");
    writeFileSync(copy, text);
    await callTool(client, "elm_symbols", { file_path: main });
    settle(copy);

    // Utils.elm imports Types, and did not change on disk in all this
    const renamed = await callTool(client, "elm_rename_file", { file_path: join(project, "src/Types.elm"), new_name: "Models.elm" });
    assert.equal(renamed.isError, false, renamed.text);
    assert.match(readFileSync(utils, "utf-8"), /^import Models exposing \(User\)$/m);
    // "greet" in Main.elm is the one of Utils.elm
    const lines = readFileSync(main, "utf-8").split("\n");
    const line = lines.findIndex((text) => text.includes("(greet model.user)"));
    const definition = await callTool(client, "elm_definition", { file_path: main, line, character: lines[line].indexOf("greet") });
    assert.match(definition.text, /src\/Utils\.elm:12:/);
    // A copy that still declares Utils is no module of the project, and nothing in it is rewritten
    if (fate === "is still there") assert.equal(readFileSync(copy, "utf-8"), text);
  });
}

test("a renamed module leaves alone a file that calls another module by its name", async (t) => {
  const project = copyFixture(t);
  const at = (name) => join(project, "src", name);
  // Card.elm does not import Utils. It gives that name to Types. Label.elm imports Utils as U.
  const card = 'module Card exposing (owner)\n\nimport Types as Utils\n\n\nowner : Utils.User\nowner =\n    Utils.defaultUser\n';
  writeFileSync(at("Card.elm"), card);
  writeFileSync(at("Label.elm"), 'module Label exposing (label)\n\nimport Utils as U\n\n\nlabel : String\nlabel =\n    U.helper "x"\n');
  const client = await connect(t, { cwd: project });

  const renamed = await callTool(client, "elm_rename_file", { file_path: at("Utils.elm"), new_name: "Helpers.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.equal(readFileSync(at("Card.elm"), "utf-8"), card);
  assert.match(readFileSync(at("Label.elm"), "utf-8"), /^import Helpers as U\n\n\nlabel : String\nlabel =\n    U\.helper "x"$/m);
  assert.match(readFileSync(at("Main.elm"), "utf-8"), /^import Helpers exposing \(formatName, greet\)$/m);
});

test("a module is renamed on lines that hold letters outside ASCII", async (t) => {
  const project = copyFixture(t);
  const at = (name) => join(project, "src", name);
  // A use of the module behind such a letter, and then a module whose own name holds two
  writeFileSync(at("Main.elm"), readFileSync(at("Main.elm"), "utf-8").replace("text (greet model.user)", 'text ("café " ++ Utils.helper (greet model.user))'));
  const client = await connect(t, { cwd: project });

  const there = await callTool(client, "elm_rename_file", { file_path: at("Utils.elm"), new_name: "Été.elm" });
  assert.equal(there.isError, false, there.text);
  assert.match(readFileSync(at("Main.elm"), "utf-8"), /^import Été exposing \(formatName, greet\)$/m);
  assert.match(readFileSync(at("Main.elm"), "utf-8"), /text \("café " \+\+ Été\.helper \(greet model\.user\)\)/);

  const back = await callTool(client, "elm_rename_file", { file_path: at("Été.elm"), new_name: "Helpers.elm" });
  assert.equal(back.isError, false, back.text);
  assert.match(readFileSync(at("Helpers.elm"), "utf-8"), /^module Helpers exposing \(formatName, greet, helper\)$/m);
  assert.match(readFileSync(at("Main.elm"), "utf-8"), /^import Helpers exposing \(formatName, greet\)$/m);
  assert.match(readFileSync(at("Main.elm"), "utf-8"), /text \("café " \+\+ Helpers\.helper \(greet model\.user\)\)/);
  assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: at("Main.elm") }), { text: "No errors or warnings", isError: false });
});

test("a port module is renamed and moved like any other module", async (t) => {
  const project = copyFixture(t);
  const at = (name) => join(project, "src", name);
  // Ports has a port module below it. Main.elm imports both.
  mkdirSync(at("Ports"));
  writeFileSync(at("Ports.elm"), "port module Ports exposing (send)\n\n\nport send : String -> Cmd msg\n");
  writeFileSync(at("Ports/Log.elm"), "port module Ports.Log exposing (log)\n\n\nport log : String -> Cmd msg\n");
  writeFileSync(at("Main.elm"), readFileSync(at("Main.elm"), "utf-8").replace("import Browser\n", "import Browser\nimport Ports\nimport Ports.Log\n"));
  const client = await connect(t, { cwd: project });

  const renamed = await callTool(client, "elm_rename_file", { file_path: at("Ports.elm"), new_name: "Outbox.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(readFileSync(at("Outbox.elm"), "utf-8"), /^port module Outbox exposing \(send\)$/m);
  assert.match(readFileSync(at("Main.elm"), "utf-8"), /^import Outbox\nimport Ports\.Log$/m);
  // The module line of the port module below is no use of the renamed module
  assert.match(readFileSync(at("Ports/Log.elm"), "utf-8"), /^port module Ports\.Log exposing \(log\)$/m);

  const moved = await callTool(client, "elm_move_file", { file_path: at("Outbox.elm"), target_path: at("Js/Outbox.elm") });
  assert.equal(moved.isError, false, moved.text);
  assert.match(readFileSync(at("Js/Outbox.elm"), "utf-8"), /^port module Js\.Outbox exposing \(send\)$/m);
  assert.match(readFileSync(at("Main.elm"), "utf-8"), /^import Js\.Outbox\nimport Ports\.Log$/m);
});

test("a renamed module leaves the modules below it their names", async (t) => {
  const project = copyFixture(t);
  const main = join(project, "src/Main.elm");
  // Utils has a module below it, as Page has Page.Home. Main.elm names both by their full names.
  mkdirSync(join(project, "src/Utils"));
  writeFileSync(join(project, "src/Utils/Extra.elm"), 'module Utils.Extra exposing (pad)\n\n\npad : String -> String\npad text =\n    " " ++ text\n');
  const before = readFileSync(main, "utf-8");
  writeFileSync(
    main,
    before
      .replace("import Utils exposing (formatName, greet)", "import Utils exposing (formatName, greet)\nimport Utils.Extra")
      .replace("text (greet model.user)", "text (Utils.Extra.pad (Utils.helper (greet model.user)))")
  );
  const client = await connect(t, { cwd: project });

  const renamed = await callTool(client, "elm_rename_file", { file_path: join(project, "src/Utils.elm"), new_name: "Helpers.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  const after = readFileSync(main, "utf-8");
  assert.match(after, /^import Helpers exposing \(formatName, greet\)\nimport Utils\.Extra$/m);
  assert.match(after, /text \(Utils\.Extra\.pad \(Helpers\.helper \(greet model\.user\)\)\)/);
});

test("a copy that is renamed takes a name of its own, and no importer of the module it was made from", async (t) => {
  const project = copyFixture(t);
  const [main, utils, copy, spare] = ["Main.elm", "Utils.elm", "UtilsBackup.elm", "Spare.elm"].map((name) => join(project, "src", name));
  writeFileSync(copy, readFileSync(utils, "utf-8"));
  const client = await connect(t, { cwd: project });
  const importer = readFileSync(main, "utf-8");

  // The copy declares Utils, and Main.elm imports Utils: the one in Utils.elm
  const renamed = await callTool(client, "elm_rename_file", { file_path: copy, new_name: "Spare.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(readFileSync(spare, "utf-8"), /^module Spare exposing /);
  assert.equal(readFileSync(main, "utf-8"), importer);
  // From here on it is a module of the project
  assert.match((await callTool(client, "elm_symbols", { file_path: spare })).text, /^Found 3 symbols/);
});

test("a tool called on a copy that still declares another file's module is refused, and says what to do", async (t) => {
  const project = copyFixture(t);
  const at = (name) => join(project, "src", name);
  // A function that only the copy has. Main.elm has a `view` of its own, which a search by name alone finds.
  writeFileSync(at("UtilsBackup.elm"), `${readFileSync(at("Utils.elm"), "utf-8")}\n\nview : String\nview =\n    ""\n`);
  writeFileSync(at("TypesBackup.elm"), readFileSync(at("Types.elm"), "utf-8"));
  const client = await connect(t, { cwd: project });
  const before = sourcesOf(project);
  // Where `word` stands in a file, as the arguments of a tool
  const place = (name, word) => {
    const lines = readFileSync(at(name), "utf-8").split("\n");
    const line = lines.findIndex((text) => text.includes(word));
    return { file_path: at(name), line, character: lines[line].indexOf(word) };
  };
  const refused = (copy, original, module) =>
    `${at(copy)} declares module ${module}, which is the module of ${at(original)}. ` +
    `Give it a name of its own with elm_rename_file, or edit its module line, and repeat the call.`;

  // The index holds nothing of the copies, so each of these would be answered from other files
  const calls = [
    ["elm_rename_function", { ...place("UtilsBackup.elm", "view :"), old_name: "view", newName: "show" }, refused("UtilsBackup.elm", "Utils.elm", "Utils")],
    ["elm_rename_function", { ...place("UtilsBackup.elm", "helper :"), old_name: "helper", newName: "assist" }, refused("UtilsBackup.elm", "Utils.elm", "Utils")],
    ["elm_references", place("UtilsBackup.elm", "helper :"), refused("UtilsBackup.elm", "Utils.elm", "Utils")],
    ["elm_definition", place("UtilsBackup.elm", "formatName name"), refused("UtilsBackup.elm", "Utils.elm", "Utils")],
    ["elm_symbols", { file_path: at("UtilsBackup.elm") }, refused("UtilsBackup.elm", "Utils.elm", "Utils")],
    ["elm_move_function", { ...place("UtilsBackup.elm", "helper :"), function_name: "helper", target_module: at("Main.elm") }, refused("UtilsBackup.elm", "Utils.elm", "Utils")],
    ["elm_rename_type", { ...place("TypesBackup.elm", "Guest ="), old_name: "Guest", newName: "Visitor" }, refused("TypesBackup.elm", "Types.elm", "Types")],
    ["elm_remove_field", { ...place("TypesBackup.elm", "email :"), field_name: "email" }, refused("TypesBackup.elm", "Types.elm", "Types")],
    ["elm_prepare_add_variant", { file_path: at("TypesBackup.elm"), type_name: "Guest", new_variant_name: "Other" }, refused("TypesBackup.elm", "Types.elm", "Types")],
  ];
  for (const [tool, args, message] of calls) {
    const answer = await callTool(client, tool, args);
    assert.deepEqual({ tool, isError: answer.isError, text: answer.text }, { tool, isError: true, text: message });
  }
  assert.deepEqual(sourcesOf(project), before);

  // A file in no source directory can be a program of its own, which the compiler builds when it
  // is given the path. The index has room for one Main all the same, and says so in other words.
  mkdirSync(join(project, "examples/Demo"), { recursive: true });
  const demo = join(project, "examples/Demo/Main.elm");
  writeFileSync(demo, 'module Main exposing (main)\n\nimport Html\n\n\nmain =\n    Html.text "demo"\n');
  const outside = await callTool(client, "elm_symbols", { file_path: demo });
  assert.deepEqual([outside.isError, outside.text], [
    true,
    `${demo} declares module Main, and so does ${at("Main.elm")}, which lies where a source directory spells that name. ` +
      `The index keeps one file for each module name, so it keeps nothing of this file, which is in no source directory, and no tool can start from it. ` +
      `If it is a copy, give it a name of its own with elm_rename_file and repeat the call.`,
  ]);

  // The build takes any file, and has the compiler's own words for a module at the wrong place
  const built = await callTool(client, "elm_diagnostics", { file_path: at("UtilsBackup.elm") });
  assert.doesNotMatch(built.text, /which is the module of/);
  // The way out that the refusal names. Below a directory, the name is the one the new path spells.
  mkdirSync(at("Backup"));
  renameSync(at("TypesBackup.elm"), at("Backup/Types.elm"));
  const renamed = await callTool(client, "elm_rename_file", { file_path: at("Backup/Types.elm"), new_name: "Models.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(readFileSync(at("Backup/Models.elm"), "utf-8"), /^module Backup\.Models exposing /);
  assert.match((await callTool(client, "elm_symbols", { file_path: at("Backup/Models.elm") })).text, /^Found 4 symbols/);
  // Moving the other copy leaves the importers of Utils with the module they import
  const moved = await callTool(client, "elm_move_file", { file_path: at("UtilsBackup.elm"), target_path: at("Backup/Helpers.elm") });
  assert.equal(moved.isError, false, moved.text);
  assert.match(readFileSync(at("Backup/Helpers.elm"), "utf-8"), /^module Backup\.Helpers exposing /);
  assert.equal(readFileSync(at("Main.elm"), "utf-8"), before["Main.elm"]);

  // Below a source directory a path that spells no module name is refused, as a move there is.
  // In no source directory the file keeps the first parts of the name it declares.
  mkdirSync(at("pages"));
  writeFileSync(at("pages/Home.elm"), "module Home exposing (home)\n\n\nhome =\n    1\n");
  const misplaced = await callTool(client, "elm_rename_file", { file_path: at("pages/Home.elm"), new_name: "Start.elm" });
  assert.equal(misplaced.isError, true);
  assert.match(misplaced.text, /"pages" cannot be part of a module name/);
  assert.ok(existsSync(at("pages/Home.elm")));
  mkdirSync(join(project, "tests/Support"), { recursive: true });
  const support = join(project, "tests/Support/Fake.elm");
  writeFileSync(support, "module Support.Fake exposing (fake)\n\n\nfake =\n    1\n");
  const supported = await callTool(client, "elm_rename_file", { file_path: support, new_name: "Stub.elm" });
  assert.equal(supported.isError, false, supported.text);
  assert.match(readFileSync(join(project, "tests/Support/Stub.elm"), "utf-8"), /^module Support\.Stub exposing /);
});

test("a file is the same file however its name is spelled in upper and lower case", async (t) => {
  const project = copyFixture(t);
  const [main, utils, spelled] = ["Main.elm", "Utils.elm", "utils.elm"].map((name) => join(project, "src", name));
  // Where the file system tells the two apart, there is no file of that name
  if (!existsSync(spelled)) return t.skip("this file system tells upper case from lower case");
  const client = await connect(t, { cwd: project });

  // Taken for another file that declares Utils, it would count as a copy of the module
  assert.match((await callTool(client, "elm_symbols", { file_path: spelled })).text, /^Found 3 symbols/);
  const renamed = await callTool(client, "elm_rename_file", { file_path: spelled, new_name: "Helpers.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(renamed.text, /Updated 1 import\(s\) in 2 file\(s\)/);
  assert.match(readFileSync(main, "utf-8"), /^import Helpers exposing \(formatName, greet\)$/m);
  assert.equal(existsSync(utils), false);

  // Through a linked directory, where the real path differs from the given one in more than its case,
  // with the link and a directory behind it spelled wrongly as well
  const linked = join(tempDir(t), "linked");
  symlinkSync(copyFixture(t), linked);
  const misspelled = join(dirname(linked), "LINKED/SRC/utils.elm");
  assert.match((await callTool(client, "elm_symbols", { file_path: misspelled })).text, /^Found 3 symbols/);
  const again = await callTool(client, "elm_rename_file", { file_path: misspelled, new_name: "Helpers.elm" });
  assert.match(again.text, /Updated 1 import\(s\) in 2 file\(s\)/);
  assert.match(readFileSync(join(linked, "src/Main.elm"), "utf-8"), /^import Helpers exposing \(formatName, greet\)$/m);

  // The module a function moves to is named by a path as well, here with the project's own directory in another case
  const other = copyFixture(t);
  const shouted = join(dirname(other), basename(other).toUpperCase(), "src/Types.elm");
  const moved = await callTool(client, "elm_move_function", { file_path: join(other, "src/Utils.elm"), line: 6, character: 0, function_name: "formatName", target_module: shouted });
  assert.equal(moved.isError, false, moved.text);
  assert.match(readFileSync(join(other, "src/Types.elm"), "utf-8"), /^formatName name =$/m);
});

test("a link to a file keeps its own name, whatever the file it leads to is called", async (t) => {
  const project = copyFixture(t);
  const [main, utils] = ["Main.elm", "Utils.elm"].map((name) => join(project, "src", name));
  // Utils.elm is a link to a file whose name differs from its own in letter case alone
  mkdirSync(join(project, "vendor"));
  renameSync(utils, join(project, "vendor/utils.elm"));
  symlinkSync(join(project, "vendor/utils.elm"), utils);
  const client = await connect(t, { cwd: project });

  assert.match((await callTool(client, "elm_symbols", { file_path: utils })).text, /^Found 3 symbols/);
  const renamed = await callTool(client, "elm_rename_file", { file_path: utils, new_name: "Helpers.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(renamed.text, /Updated 1 import\(s\) in 2 file\(s\)/);
  assert.match(readFileSync(main, "utf-8"), /^import Helpers exposing \(formatName, greet\)$/m);
  assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: main }), { text: "No errors or warnings", isError: false });
});

test("a source directory is the same directory however elm.json spells it", async (t) => {
  const project = copyFixture(t);
  const [main, utils] = ["Main.elm", "Utils.elm"].map((name) => join(project, "src", name));
  // Where the file system tells the two apart, elm.json would name a directory that is not there
  if (!existsSync(join(project, "SRC"))) return t.skip("this file system tells upper case from lower case");
  writeFileSync(join(project, "elm.json"), readFileSync(join(project, "elm.json"), "utf-8").replace('"src"', '"SRC"'));
  const client = await connect(t, { cwd: project });

  // Taken for a file outside the source directory SRC, it would be no module of the project
  assert.match((await callTool(client, "elm_symbols", { file_path: utils })).text, /^Found 3 symbols/);
  const renamed = await callTool(client, "elm_rename_file", { file_path: utils, new_name: "Helpers.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(renamed.text, /Updated 1 import\(s\) in 2 file\(s\)/);
  assert.match(readFileSync(main, "utf-8"), /^import Helpers exposing \(formatName, greet\)$/m);
  // A move names the module by its path below the source directory, which has to be the one the file lies in
  const moved = await callTool(client, "elm_move_file", { file_path: join(project, "src/Helpers.elm"), target_path: "src/Lib/Helpers.elm" });
  assert.equal(moved.isError, false, moved.text);
  assert.match(moved.text, /^Moved Helpers to Lib\.Helpers$/m);
  assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: main }), { text: "No errors or warnings", isError: false });
});

test("a project behind a link is reached by the link's own name", async (t) => {
  // Projects is a link to a directory called projects, in another place: the two names differ in letter case alone
  const [home, data] = ["home", "data"].map((name) => join(tempDir(t), name));
  mkdirSync(home);
  mkdirSync(join(data, "projects"), { recursive: true });
  cpSync(copyFixture(t), join(data, "projects/fixture"), { recursive: true });
  symlinkSync(join(data, "projects"), join(home, "Projects"));
  // Where the file system tells the two names apart, a directory of the target's name can lie beside the link
  const beside = join(home, "projects/fixture");
  const caseCounts = !existsSync(join(home, "projects"));
  if (caseCounts) cpSync(join(data, "projects/fixture"), beside, { recursive: true });
  const utils = join(home, "Projects/fixture/src/Utils.elm");
  const client = await connect(t, { cwd: tempDir(t) });

  assert.match((await callTool(client, "elm_symbols", { file_path: utils })).text, /^Found 3 symbols/);
  const renamed = await callTool(client, "elm_rename_function", { file_path: utils, line: 6, character: 0, old_name: "formatName", newName: "shout" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.ok(renamed.text.includes(`${utils}:`), renamed.text);
  assert.match(readFileSync(utils, "utf-8"), /^shout name =$/m);
  if (caseCounts) assert.match(readFileSync(join(beside, "src/Utils.elm"), "utf-8"), /^formatName name =$/m);
});

test("a file moved into a directory is named by the directory as the disk spells it", async (t) => {
  const project = copyFixture(t);
  const at = (name) => join(project, "src", name);
  mkdirSync(at("Api"));
  if (!existsSync(at("API"))) return t.skip("this file system tells upper case from lower case");
  const client = await connect(t, { cwd: project });

  // Taken as it is written, the target would make a module API.Utils of a file that lies in src/Api
  const moved = await callTool(client, "elm_move_file", { file_path: at("Utils.elm"), target_path: "src/API/Utils.elm" });
  assert.equal(moved.isError, false, moved.text);
  assert.match(moved.text, /^Moved Utils to Api\.Utils$/m);
  assert.match(readFileSync(at("Api/Utils.elm"), "utf-8"), /^module Api\.Utils exposing /);
  assert.match(readFileSync(at("Main.elm"), "utf-8"), /^import Api\.Utils exposing \(formatName, greet\)$/m);
  // And it is that module from here on, under either spelling
  assert.match((await callTool(client, "elm_symbols", { file_path: at("API/Utils.elm") })).text, /^Found 3 symbols/);
  assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: at("Main.elm") }), { text: "No errors or warnings", isError: false });
});

test("a source directory is found in the form the disk keeps its accent in", async (t) => {
  const project = copyFixture(t);
  // The disk keeps the accent as a letter and a mark. elm.json and a caller write it as one letter.
  const [onDisk, asWritten] = ["co\u0301digo", "c\u00f3digo"].map((name) => join(project, name));
  renameSync(join(project, "src"), onDisk);
  if (!existsSync(asWritten)) return t.skip("this file system tells the two forms of an accent apart");
  writeFileSync(join(project, "elm.json"), readFileSync(join(project, "elm.json"), "utf-8").replace('"src"', '"c\u00f3digo"'));
  const client = await connect(t, { cwd: project });

  for (const directory of [onDisk, asWritten]) {
    assert.match((await callTool(client, "elm_symbols", { file_path: join(directory, "Utils.elm") })).text, /^Found 3 symbols/);
  }
  const renamed = await callTool(client, "elm_rename_file", { file_path: join(asWritten, "Utils.elm"), new_name: "Helpers.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(renamed.text, /Updated 1 import\(s\) in 2 file\(s\)/);
  assert.match(readFileSync(join(onDisk, "Main.elm"), "utf-8"), /^import Helpers exposing \(formatName, greet\)$/m);
});

test("a source directory beside a project behind a link is the one the compiler reads", async (t) => {
  // home/app is a link to data/app, and elm.json lists "../shared". Read from the real place of
  // the project, that is data/shared. Read from the text of the path, it would be home/shared.
  for (const sibling of [false, true]) {
    const [home, data] = ["home", "data"].map((name) => join(tempDir(t), name));
    mkdirSync(home);
    mkdirSync(join(data, "shared"), { recursive: true });
    cpSync(copyFixture(t), join(data, "app"), { recursive: true });
    symlinkSync(join(data, "app"), join(home, "app"));
    const project = join(home, "app");
    addSourceDirectory(project, "../shared");
    const consumer = "module Consumer exposing (shown)\n\nimport Utils exposing (formatName)\n\n\nshown : String\nshown =\n    formatName \"x\"\n";
    writeFileSync(join(data, "shared/Consumer.elm"), consumer);
    const main = join(project, "src/Main.elm");
    writeFileSync(main, readFileSync(main, "utf-8").replace("import Browser\n", "import Browser\nimport Consumer\n"));
    // A directory of the same name beside the link belongs to something else
    if (sibling) {
      mkdirSync(join(home, "shared"));
      writeFileSync(join(home, "shared/Consumer.elm"), consumer);
    }
    const client = await connect(t, { cwd: tempDir(t) });

    const renamed = await callTool(client, "elm_rename_function", { file_path: join(project, "src/Utils.elm"), line: 6, character: 0, old_name: "formatName", newName: "shout" });
    assert.equal(renamed.isError, false, renamed.text);
    assert.match(readFileSync(join(data, "shared/Consumer.elm"), "utf-8"), /^import Utils exposing \(shout\)$/m);
    if (sibling) assert.equal(readFileSync(join(home, "shared/Consumer.elm"), "utf-8"), consumer);
    assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: main }), { text: "No errors or warnings", isError: false });
  }
});

test("a source directory listed through a link to nothing is the one the language server reads", async (t) => {
  // "gone" leads nowhere, so the file system has no place for "gone/../../shared". The language server
  // reads ".." from the text there, and the wrapper has to arrive at the same directory to let a change in.
  const project = copyFixture(t, "app");
  const shared = join(dirname(project), "shared");
  mkdirSync(shared);
  symlinkSync("nowhere", join(project, "gone"));
  addSourceDirectory(project, "gone/../../shared");
  const consumer = join(shared, "Consumer.elm");
  writeFileSync(consumer, "module Consumer exposing (shown)\n\nimport Utils exposing (formatName)\n\n\nshown : String\nshown =\n    formatName \"x\"\n");
  const client = await connect(t, { cwd: project });

  const renamed = await callTool(client, "elm_rename_function", { file_path: join(project, "src/Utils.elm"), line: 6, character: 0, old_name: "formatName", newName: "shout" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(readFileSync(consumer, "utf-8"), /^import Utils exposing \(shout\)$/m);
});

test("a source directory outside the project is the same directory however elm.json spells it", async (t) => {
  const project = join(tempDir(t), "app");
  cpSync(copyFixture(t), project, { recursive: true });
  const shared = join(dirname(project), "shared");
  mkdirSync(shared);
  if (!existsSync(join(dirname(project), "SHARED"))) return t.skip("this file system tells upper case from lower case");
  addSourceDirectory(project, "../SHARED");
  writeFileSync(join(shared, "Consumer.elm"), "module Consumer exposing (shown)\n\nimport Utils exposing (formatName)\n\n\nshown : String\nshown =\n    formatName \"x\"\n");
  const client = await connect(t, { cwd: project });

  // The language server and the wrapper have to agree on the directory, or the change to it is refused
  const renamed = await callTool(client, "elm_rename_function", { file_path: join(project, "src/Utils.elm"), line: 6, character: 0, old_name: "formatName", newName: "shout" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(readFileSync(join(shared, "Consumer.elm"), "utf-8"), /^import Utils exposing \(shout\)$/m);
});

test("a module in a directory whose accent the disk keeps as a letter and a mark has its name with one letter", async (t) => {
  const project = copyFixture(t);
  const at = (name) => join(project, "src", name);
  // Foo/Élan on disk in the decomposed form, and in the module line as the compiler wants it
  const [onDisk, composed] = ["Foo/E\u0301lan", "Foo/\u00c9lan"];
  mkdirSync(at(onDisk), { recursive: true });
  if (!existsSync(at(composed))) return t.skip("this file system tells the two forms of an accent apart");
  writeFileSync(at(`${onDisk}/Cafe.elm`), "module Foo.\u00c9lan.Cafe exposing (open)\n\n\nopen : Bool\nopen =\n    True\n");
  writeFileSync(at("Main.elm"), readFileSync(at("Main.elm"), "utf-8").replace("import Browser\n", "import Browser\nimport Foo.\u00c9lan.Cafe\n"));
  const client = await connect(t, { cwd: project });

  assert.match((await callTool(client, "elm_symbols", { file_path: at(`${composed}/Cafe.elm`) })).text, /^Found 1 symbols/);
  const renamed = await callTool(client, "elm_rename_file", { file_path: at(`${composed}/Cafe.elm`), new_name: "Summer.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(readFileSync(at(`${onDisk}/Summer.elm`), "utf-8"), /^module Foo\.\u00c9lan\.Summer exposing \(open\)$/m);
  assert.match(readFileSync(at("Main.elm"), "utf-8"), /^import Foo\.\u00c9lan\.Summer$/m);
  assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: at("Main.elm") }), { text: "No errors or warnings", isError: false });
});

test("a module below two source directories is itself when a copy of it is made", async (t) => {
  // "src" and "src/Sub" are both source directories, and Sub/Utils.elm is the module Sub.Utils of the first
  const project = copyFixture(t);
  const at = (name) => join(project, "src", name);
  addSourceDirectory(project, "src/Sub");
  mkdirSync(at("Sub"));
  writeFileSync(at("Sub/Utils.elm"), readFileSync(at("Utils.elm"), "utf-8").replace("module Utils exposing", "module Sub.Utils exposing"));
  rmSync(at("Utils.elm"));
  writeFileSync(at("Main.elm"), readFileSync(at("Main.elm"), "utf-8").replace("import Utils exposing", "import Sub.Utils exposing"));
  const client = await connect(t, { cwd: project });
  assert.match((await callTool(client, "elm_symbols", { file_path: at("Sub/Utils.elm") })).text, /^Found 3 symbols/);

  // A backup of it, made while the server runs, still says "module Sub.Utils"
  const backup = readFileSync(at("Sub/Utils.elm"), "utf-8");
  writeFileSync(at("ZZBackup.elm"), backup);
  const renamed = await callTool(client, "elm_rename_file", { file_path: at("Types.elm"), new_name: "Models.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(readFileSync(at("Sub/Utils.elm"), "utf-8"), /^import Models exposing \(User\)$/m);
  assert.equal(readFileSync(at("ZZBackup.elm"), "utf-8"), backup);
  rmSync(at("ZZBackup.elm"));
  assert.deepEqual(await callTool(client, "elm_diagnostics", { file_path: at("Main.elm") }), { text: "No errors or warnings", isError: false });
});

test("a copy that is there when the server starts takes no module's name either", async (t) => {
  const project = copyFixture(t);
  const utils = join(project, "src/Utils.elm");
  const text = readFileSync(utils, "utf-8");
  // One before Utils.elm in any order of names and one after it. The order of the walk is the file system's.
  const copies = ["Aaa.elm", "Zzz.elm"].map((name) => join(project, "src", name));
  for (const copy of copies) writeFileSync(copy, text);
  const client = await connect(t, { cwd: project });

  const renamed = await callTool(client, "elm_rename_file", { file_path: join(project, "src/Types.elm"), new_name: "Models.elm" });
  assert.equal(renamed.isError, false, renamed.text);
  assert.match(readFileSync(utils, "utf-8"), /^import Models exposing \(User\)$/m);
  assert.deepEqual(copies.map((copy) => readFileSync(copy, "utf-8")), [text, text]);
});

test("a file outside the source directories stays in an index that is built anew", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });
  mkdirSync(join(project, "tests"));
  const utilsTest = join(project, "tests/UtilsTest.elm");
  const text = "module UtilsTest exposing (loud)\n\nimport Utils exposing (formatName)\n\n\nloud =\n    formatName\n";
  writeFileSync(utilsTest, text);
  await callTool(client, "elm_symbols", { file_path: utilsTest });

  // "elm install" writes elm.json again, and the language server then builds its index anew.
  // In between the file is broken for a moment, and there is no index at all.
  const elmJson = readFileSync(join(project, "elm.json"), "utf-8");
  writeFileSync(join(project, "elm.json"), "{");
  const symbolsOfUtils = () => callTool(client, "elm_symbols", { file_path: join(project, "src/Utils.elm") });
  assert.equal((await symbolsOfUtils()).isError, true);

  // The next two indexes find the file itself unreadable. Each says so, and neither forgets the file.
  writeFileSync(utilsTest, Buffer.from([0xff, 0xfe]));
  for (const ending of ["\n", "\n\n"]) {
    writeFileSync(join(project, "elm.json"), `${elmJson}${ending}`);
    const unread = await symbolsOfUtils();
    assert.equal(unread.isError, true);
    assert.ok(unread.text.includes(utilsTest), unread.text);
  }
  writeFileSync(utilsTest, text);
  writeFileSync(join(project, "elm.json"), elmJson);

  const renamed = await callTool(client, "elm_rename_function", {
    file_path: join(project, "src/Utils.elm"),
    line: 6,
    character: 0,
    old_name: "formatName",
    newName: "shout",
  });
  assert.match(renamed.text, /Applied 8 edit\(s\) in 3 file\(s\)/);
  assert.equal(readFileSync(utilsTest, "utf-8"), text.replaceAll("formatName", "shout"));
});

test("while elm.json cannot be read every tool says so, and the index is built once it can", async (t) => {
  const project = copyFixture(t);
  const elmJson = join(project, "elm.json");
  const sound = readFileSync(elmJson, "utf-8");
  const usesOfFormatName = (client) =>
    callTool(client, "elm_references", { file_path: join(project, "src/Utils.elm"), line: 6, character: 0 });

  // Broken before the language server starts, so it starts without an index
  writeFileSync(elmJson, sound.replace(/\}\s*$/, ",}"));
  const client = await connect(t, { cwd: project });
  const refused = await usesOfFormatName(client);
  assert.equal(refused.isError, true);
  assert.ok(refused.text.startsWith(`Cannot read ${elmJson}: `), refused.text);

  writeFileSync(elmJson, sound);
  const found = await usesOfFormatName(client);
  assert.equal(found.isError, false, found.text);
  assert.match(found.text, /src\/Main\.elm/);

  // Broken again while the server is running
  writeFileSync(elmJson, "{");
  assert.ok((await usesOfFormatName(client)).text.startsWith(`Cannot read ${elmJson}: `));
  // There and not readable as text is no missing elm.json, whose modules would be looked for in src
  writeFileSync(elmJson, Buffer.from([0xff, 0xfe]));
  assert.equal((await usesOfFormatName(client)).text, `Cannot read ${elmJson}: stream did not contain valid UTF-8.`);
  writeFileSync(elmJson, sound);
  assert.deepEqual(await usesOfFormatName(client), found);
});

test("while a source file cannot be read every tool says so, and the file is indexed once it can", async (t) => {
  const project = copyFixture(t);
  const main = join(project, "src/Main.elm");
  const utils = join(project, "src/Utils.elm");
  const text = readFileSync(main);
  const { atime, mtime } = statSync(main);
  // Not text, of the length and with the date the file had. A file without read permission fails the same way.
  const unreadable = () => {
    writeFileSync(main, Buffer.alloc(text.length, 0xff));
    utimesSync(main, atime, mtime);
  };
  const readable = () => {
    writeFileSync(main, text);
    utimesSync(main, atime, mtime);
  };
  const rename = (client, from, to) =>
    callTool(client, "elm_rename_function", { file_path: utils, line: 6, character: 0, old_name: from, newName: to });

  // Unreadable when the language server starts
  unreadable();
  const client = await connect(t, { cwd: project });
  assert.deepEqual(await rename(client, "formatName", "shout"), {
    text: `Cannot read ${main}: stream did not contain valid UTF-8.`,
    isError: true,
  });
  assert.match(readFileSync(utils, "utf-8"), /^formatName name =$/m);

  // Nothing about the file tells that it changed, except that it was never read
  readable();
  const renamed = await rename(client, "formatName", "shout");
  assert.match(renamed.text, /Applied 6 edit\(s\) in 2 file\(s\)/);
  assert.match(readFileSync(main, "utf-8"), /shout model\.user\.name/);

  // Unreadable later on
  writeFileSync(main, Buffer.from([0xff]));
  assert.equal((await rename(client, "shout", "formatName")).text, `Cannot read ${main}: stream did not contain valid UTF-8.`);
});

test("while a directory of sources cannot be listed every tool says so", { skip: asRoot }, async (t) => {
  const project = copyFixture(t);
  const utils = join(project, "src/Utils.elm");
  const hidden = join(project, "src/Hidden");
  const deep = join(hidden, "Deep.elm");
  mkdirSync(hidden);
  writeFileSync(deep, "module Hidden.Deep exposing (loud)\n\nimport Utils exposing (formatName)\n\n\nloud =\n    formatName\n");
  const rename = (client, from, to) =>
    callTool(client, "elm_rename_function", { file_path: utils, line: 6, character: 0, old_name: from, newName: to });
  const refused = { text: `Cannot read ${hidden}: Permission denied (os error 13).`, isError: true };

  try {
    // Closed when the language server starts
    chmodSync(hidden, 0o000);
    const client = await connect(t, { cwd: project });
    assert.deepEqual(await rename(client, "formatName", "shout"), refused);
    assert.match(readFileSync(utils, "utf-8"), /^formatName name =$/m);

    chmodSync(hidden, 0o755);
    assert.equal((await rename(client, "formatName", "shout")).isError, false);
    assert.match(readFileSync(deep, "utf-8"), /^    shout$/m);

    // Closed later on. A rename that left the module in it as it was would break the build.
    chmodSync(hidden, 0o000);
    assert.deepEqual(await rename(client, "shout", "formatName"), refused);
  } finally {
    // Open again, or the copy of the project cannot be removed
    chmodSync(hidden, 0o755);
  }
});

test("a function is moved in a project that holds a link to nothing and a dot-file", async (t) => {
  const project = copyFixture(t);
  symlinkSync("someone@host.1234", join(project, "src/.#Main.elm"));
  // What macOS keeps beside Main.elm on some volumes. No module has such a name, whatever the file holds.
  const main = readFileSync(join(project, "src/Main.elm"), "utf-8");
  writeFileSync(join(project, "src/._Main.elm"), main);
  const client = await connect(t, { cwd: project });

  const moved = await callTool(client, "elm_move_function", {
    file_path: join(project, "src/Utils.elm"),
    line: 6,
    character: 0,
    function_name: "formatName",
    target_module: join(project, "src/Types.elm"),
  });
  assert.equal(moved.isError, false, moved.text);
  // Main.elm exposed the function from Utils and now takes it from Types
  assert.match(readFileSync(join(project, "src/Main.elm"), "utf-8"), /^import Types exposing \(User, defaultUser, formatName\)$/m);
  assert.match(readFileSync(join(project, "src/Types.elm"), "utf-8"), /^formatName name =$/m);
  assert.equal(readFileSync(join(project, "src/._Main.elm"), "utf-8"), main);
});

test("a function is moved in a project where a source file is a link to the real one", async (t) => {
  const project = copyFixture(t);
  const main = join(project, "src/Main.elm");
  const real = join(tempDir(t), "Main.elm");
  renameSync(main, real);
  symlinkSync(real, main);
  const client = await connect(t, { cwd: project });

  const moved = await callTool(client, "elm_move_function", {
    file_path: join(project, "src/Utils.elm"),
    line: 6,
    character: 0,
    function_name: "formatName",
    target_module: join(project, "src/Types.elm"),
  });
  assert.equal(moved.isError, false, moved.text);
  // The importing module is reached through its link, like any other
  assert.match(readFileSync(real, "utf-8"), /^import Types exposing \(User, defaultUser, formatName\)$/m);
});

// A file has two names when a link leads to it, and when a directory lists it a second time
for (const [name, alsoAt] of [
  ["a link to it", symlinkSync],
  ["a second name", linkSync],
]) {
  test(`a file that has ${name} is one file when a function moves`, async (t) => {
    const client = await connect(t, { cwd: tempDir(t) });
    // Main.elm lists formatName in its import of Utils, which the move writes anew in another file
    const move = async (twice, target) => {
      const project = copyFixture(t);
      alsoAt(join(project, "src", twice), join(project, "src/Second.elm"));
      const before = sourcesOf(project);
      const moved = await callTool(client, "elm_move_function", {
        file_path: join(project, "src/Utils.elm"),
        line: 6,
        character: 0,
        function_name: "formatName",
        target_module: join(project, "src", target),
      });
      return { moved, before, after: sourcesOf(project) };
    };
    const body = /^formatName name =\n    String\.toUpper name$/m;

    // The target under its other name is the target. Written as another file, it was put back
    // as it had been, with a new import, and the function was in no file.
    const intoIt = await move("Main.elm", "Main.elm");
    assert.equal(intoIt.moved.isError, false, intoIt.moved.text);
    assert.match(intoIt.moved.text, /Updated imports in 0 other file\(s\)/);
    assert.match(intoIt.after["Main.elm"], body);
    assert.equal(intoIt.after["Second.elm"], intoIt.after["Main.elm"]);
    assert.doesNotMatch(intoIt.after["Utils.elm"], body);

    // A file that imports the function is written once
    const pastIt = await move("Main.elm", "Types.elm");
    assert.match(pastIt.moved.text, /Updated imports in 1 other file\(s\)/);
    assert.match(pastIt.after["Main.elm"], /^import Types exposing \(User, defaultUser, formatName\)$/m);
    assert.match(pastIt.after["Types.elm"], body);

    // The source under its other name is no place to move to
    const intoItself = await move("Utils.elm", "Second.elm");
    assert.equal(intoItself.moved.isError, true);
    assert.deepEqual(intoItself.after, intoItself.before);
  });
}

test("a function is moved to all of its files or to none", { skip: asRoot }, async (t) => {
  const project = copyFixture(t);
  const main = join(project, "src/Main.elm");
  // Outside the source directories, where the language server does not look and the move does
  mkdirSync(join(project, "tests"));
  const locked = join(project, "tests/Locked.elm");
  writeFileSync(locked, "module Locked exposing (..)\n");
  const client = await connect(t, { cwd: project });
  const before = sourcesOf(project);
  const move = () =>
    callTool(client, "elm_move_function", {
      file_path: join(project, "src/Utils.elm"),
      line: 6,
      character: 0,
      function_name: "formatName",
      target_module: join(project, "src/Types.elm"),
    });

  chmodSync(locked, 0o000);
  const unread = await move();
  assert.equal(unread.isError, true);
  assert.ok(unread.text.startsWith(`Cannot read ${locked}, so no file was changed. `), unread.text);
  assert.deepEqual(sourcesOf(project), before);
  chmodSync(locked, 0o644);

  // Main.elm imports the function, so the move has to write it
  chmodSync(main, 0o444);
  const unwritten = await move();
  assert.equal(unwritten.isError, true);
  assert.ok(unwritten.text.startsWith(`Cannot write ${main}, so no file was changed. `), unwritten.text);
  assert.deepEqual(sourcesOf(project), before);
  chmodSync(main, 0o644);

  assert.equal((await move()).isError, false);
  assert.match(readFileSync(main, "utf-8"), /^import Types exposing \(User, defaultUser, formatName\)$/m);
});

for (const readOnly of ["src/Main.elm", "src/Utils.elm"]) {
  test(`a rename changes no file while ${readOnly} cannot be written`, { skip: asRoot }, async (t) => {
    const project = copyFixture(t);
    const client = await connect(t, { cwd: project });
    const before = sourcesOf(project);
    const rename = () =>
      callTool(client, "elm_rename_function", {
        file_path: join(project, "src/Utils.elm"),
        line: 6,
        character: 0,
        old_name: "formatName",
        newName: "shout",
      });

    // The rename edits both files. Whichever it would write first, the other must not be left changed.
    chmodSync(join(project, readOnly), 0o444);
    const refused = await rename();
    assert.equal(refused.isError, true);
    assert.ok(refused.text.startsWith(`Cannot write ${join(project, readOnly)}, so no file was changed. `), refused.text);
    assert.deepEqual(sourcesOf(project), before);

    chmodSync(join(project, readOnly), 0o644);
    assert.match((await rename()).text, /Applied 6 edit\(s\) in 2 file\(s\)/);
  });
}

test("a function is not moved while a file that may import it is out of reach", { skip: asRoot }, async (t) => {
  const project = copyFixture(t);
  // The move looks at every Elm file under the project root, also outside the source directories.
  // This one is a link to a file in a directory that cannot be entered.
  const vault = join(tempDir(t), "vault");
  const linked = join(project, "tests/Linked.elm");
  mkdirSync(vault);
  mkdirSync(join(project, "tests"));
  writeFileSync(join(vault, "Linked.elm"), "module Linked exposing (..)\n\nimport Utils exposing (formatName)\n");
  symlinkSync(join(vault, "Linked.elm"), linked);
  const client = await connect(t, { cwd: project });
  const before = sourcesOf(project);

  chmodSync(vault, 0o000);
  try {
    const moved = await callTool(client, "elm_move_function", {
      file_path: join(project, "src/Utils.elm"),
      line: 6,
      character: 0,
      function_name: "formatName",
      target_module: join(project, "src/Types.elm"),
    });
    assert.equal(moved.isError, true);
    assert.ok(moved.text.startsWith(`Cannot read ${linked}, so no file was changed. `), moved.text);
  } finally {
    chmodSync(vault, 0o755);
  }
  assert.deepEqual(sourcesOf(project), before);
});

test("a file is moved together with its edits or not at all", { skip: asRoot }, async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });
  const src = join(project, "src");
  const before = sourcesOf(project);

  // The Elm files can be written. The directory takes no new entry and gives none up.
  chmodSync(src, 0o555);
  try {
    const renamed = await callTool(client, "elm_rename_file", { file_path: join(src, "Utils.elm"), new_name: "Helpers.elm" });
    assert.equal(renamed.isError, true);
    assert.ok(renamed.text.startsWith(`Cannot rename file: nothing can be changed in ${src}, so no file was changed. `), renamed.text);
    const moved = await callTool(client, "elm_move_file", { file_path: join(src, "Utils.elm"), target_path: "src/Deep/Down/Utils.elm" });
    assert.ok(moved.text.startsWith(`Cannot move file: nothing can be changed in ${src}, so no file was changed. `), moved.text);
  } finally {
    chmodSync(src, 0o755);
  }
  assert.deepEqual(sourcesOf(project), before);
});

test("a refactoring reaches a source directory outside the project root", async (t) => {
  // A repository of several applications, which share a directory of modules
  const project = copyFixture(t, "app");
  const shared = join(dirname(project), "shared");
  addSourceDirectory(project, "../shared");
  mkdirSync(shared);
  const consumer = join(shared, "Consumer.elm");
  const text = "module Consumer exposing (loud)\n\nimport Utils exposing (formatName)\n\n\nloud =\n    formatName\n";
  writeFileSync(consumer, text);
  const client = await connect(t, { cwd: project });
  const rename = (from, to) =>
    callTool(client, "elm_rename_function", { file_path: join(project, "src/Utils.elm"), line: 6, character: 0, old_name: from, newName: to });

  const renamed = await rename("formatName", "shout");
  assert.match(renamed.text, /Applied 8 edit\(s\) in 3 file\(s\)/);
  assert.equal(readFileSync(consumer, "utf-8"), text.replaceAll("formatName", "shout"));
  // The file has one name in the index, so a second rename finds each use once
  assert.match((await rename("shout", "formatName")).text, /Applied 8 edit\(s\) in 3 file\(s\)/);
  assert.equal(readFileSync(consumer, "utf-8"), text);

  // A function that moves to another module is imported from there in the shared directory too
  const moved = await callTool(client, "elm_move_function", {
    file_path: join(project, "src/Utils.elm"),
    line: 6,
    character: 0,
    function_name: "formatName",
    target_module: join(project, "src/Types.elm"),
  });
  assert.match(moved.text, /Updated imports in 2 other file\(s\)\./);
  assert.match(readFileSync(consumer, "utf-8"), /^import Types exposing \(formatName\)$/m);
});

test("a link to nothing and a dot-file among the source files are passed over", async (t) => {
  const project = copyFixture(t);
  const types = join(project, "src/Types.elm");
  const client = await connect(t, { cwd: project });
  assert.match((await callTool(client, "elm_symbols", { file_path: types })).text, /^Found 4 symbols/);

  // Emacs keeps such a link beside every buffer with unsaved changes
  symlinkSync("someone@host.1234", join(project, "src/.#Types.elm"));
  // A link to a module that is still to be generated
  symlinkSync("../generated/Later.elm", join(project, "src/Later.elm"));
  // macOS keeps such a file beside Types.elm on a volume without extended attributes. It is no
  // text, and no module either: a module's name starts with a letter.
  writeFileSync(join(project, "src/._Types.elm"), Buffer.from([0x00, 0x05, 0x16, 0x07, 0xff, 0xfe]));
  // The same goes for what lies in a directory of such a name
  mkdirSync(join(project, "src/.cache"));
  writeFileSync(join(project, "src/.cache/Old.elm"), Buffer.from([0xff, 0xfe]));

  assert.match((await callTool(client, "elm_symbols", { file_path: types })).text, /^Found 4 symbols/);
  // A server that starts with the link in place gets by as well
  const second = await connect(t, { cwd: project });
  assert.match((await callTool(second, "elm_symbols", { file_path: types })).text, /^Found 4 symbols/);
});

test("--elm-projects-only exits quietly outside an Elm project", async (t) => {
  const { code, stdout } = await runNode(SERVER, ["--elm-projects-only"], { cwd: tempDir(t) });
  assert.equal(code, 0);
  assert.equal(stdout, "");
});

test("--elm-projects-only with --http says why no server started", async (t) => {
  // Nobody is listening afterwards, and whoever typed the command needs to know
  const cwd = tempDir(t);
  assert.deepEqual(await runNode(SERVER, ["--elm-projects-only", "--http"], { cwd }), {
    code: 1,
    stdout: "",
    stderr: `No server started: --elm-projects-only was given, and neither ${cwd} nor a direct child of it holds an elm.json.\n`,
  });
});

test("--elm-projects-only serves a project and a monorepo that holds one", async (t) => {
  const project = copyFixture(t);
  const inProject = await connect(t, { args: ["--elm-projects-only"], cwd: project });
  assert.equal((await inProject.listTools()).tools.length, 22);

  // elm.json one level down, as in repo/client/elm.json
  const monorepo = dirname(copyFixture(t, "client"));
  const inMonorepo = await connect(t, { args: ["--elm-projects-only"], cwd: monorepo });
  assert.equal((await inMonorepo.listTools()).tools.length, 22);
});

const READ_ONLY_TOOLS = [
  "elm_code_actions",
  "elm_definition",
  "elm_diagnostics",
  "elm_notify_file_changed",
  "elm_prepare_add_variant",
  "elm_prepare_remove_field",
  "elm_prepare_remove_variant",
  "elm_references",
  "elm_symbols",
];

test("every tool names the file whose project its call belongs to", () => {
  // A call waits its turn among the calls for its project, which is found from one of these arguments
  for (const tool of tools) {
    assert.ok(PATH_ARGUMENTS.some((name) => name in tool.input), `${tool.name} takes none of ${PATH_ARGUMENTS.join(", ")}`);
  }
});

test("every tool tells the harness whether it writes", async (t) => {
  const client = await connect(t, { cwd: copyFixture(t) });
  const { tools } = await client.listTools();

  assert.equal(tools.length, 22);
  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} has a title`);
    // Only the compiler reaches the network, to fetch packages it does not have yet
    assert.equal(tool.annotations.openWorldHint, tool.name === "elm_diagnostics", `${tool.name} and the network`);
    assert.equal(
      tool.annotations.destructiveHint,
      !tool.annotations.readOnlyHint,
      `${tool.name} is either read-only or able to overwrite files`
    );
  }
  const readOnly = tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name);
  assert.deepEqual(readOnly.sort(), READ_ONLY_TOOLS);
});

test("--read-only leaves out every tool that writes", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { args: ["--read-only"], cwd: project });

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), READ_ONLY_TOOLS);

  const rename = await callTool(client, "elm_rename_function", {
    file_path: join(project, "src/Utils.elm"),
    line: 16,
    character: 0,
    old_name: "helper",
    newName: "assist",
  });
  assert.equal(rename.isError, true);
  assert.match(rename.text, /elm_rename_function/);
});

test("a request that cannot be carried out is a tool error", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });

  const stray = join(tempDir(t), "Stray.elm");
  writeFileSync(stray, "module Stray exposing (x)\n");
  const outsideAnyProject = await callTool(client, "elm_definition", { file_path: stray, line: 0, character: 0 });
  assert.deepEqual(outsideAnyProject, { text: `No elm.json found in the parent directories of ${stray}`, isError: true });

  const missing = join(project, "src/Missing.elm");
  for (const tool of ["elm_symbols", "elm_diagnostics"]) {
    assert.deepEqual(await callTool(client, tool, { file_path: missing }), {
      text: `Cannot read ${missing}: it does not exist`,
      isError: true,
    });
  }
  assert.deepEqual(await callTool(client, "elm_symbols", { file_path: join(project, "src") }), {
    text: `Cannot read ${join(project, "src")}: it is not a file`,
    isError: true,
  });

  // Utils.elm line 16 defines `helper`, so the expected name does not match
  const staleName = await callTool(client, "elm_rename_function", {
    file_path: join(project, "src/Utils.elm"),
    line: 16,
    character: 0,
    old_name: "greet",
    newName: "welcome",
  });
  assert.equal(staleName.isError, true);
  assert.match(staleName.text, /Safety check failed: Expected function 'greet' but found 'helper'/);

  // The language server is told of a move to a place where no file is
  const nowhere = await callTool(client, "elm_notify_file_changed", { old_path: stray, new_path: join(project, "src/Nowhere.elm") });
  assert.equal(nowhere.isError, true);
  assert.match(nowhere.text, /^Error: No such file or directory/);
});

test("a module stays in the index while its file is there, whatever the server is told about a move", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });
  const main = join(project, "src/Main.elm");
  const rename = (from, to) =>
    callTool(client, "elm_rename_function", { file_path: join(project, "src/Utils.elm"), line: 6, character: 0, old_name: from, newName: to });
  await callTool(client, "elm_symbols", { file_path: main });

  // A copy under another module name, announced as a move. Main.elm is where it was, and as old as
  // it was, so nothing but the index itself can tell the language server that it still counts.
  const copy = join(project, "src/Copy.elm");
  writeFileSync(copy, readFileSync(main, "utf-8").replace("module Main exposing", "module Copy exposing"));
  assert.equal((await callTool(client, "elm_notify_file_changed", { old_path: main, new_path: copy })).isError, false);
  assert.match((await rename("formatName", "shout")).text, /Applied 8 edit\(s\) in 3 file\(s\)/);
  assert.match(readFileSync(main, "utf-8"), /^import Utils exposing \(shout, greet\)$/m);
  assert.match(readFileSync(copy, "utf-8"), /^import Utils exposing \(shout, greet\)$/m);

  // A move that did not happen is an error, and takes nothing out of the index either
  const types = join(project, "src/Types.elm");
  const nowhere = await callTool(client, "elm_notify_file_changed", { old_path: types, new_path: join(project, "src/Nowhere.elm") });
  assert.equal(nowhere.isError, true);
  const users = await callTool(client, "elm_references", { file_path: types, line: 3, character: 11 });
  assert.match(users.text, /src\/Types\.elm/);
});

test("a rename away from any symbol reports the server's reason", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });

  // Line 3 of Utils.elm is blank
  const blankLine = await callTool(client, "elm_rename_function", {
    file_path: join(project, "src/Utils.elm"),
    line: 3,
    character: 0,
    old_name: "helper",
    newName: "assist",
  });
  assert.equal(blankLine.isError, true);
  assert.match(blankLine.text, /Position is not on a function/);
});

test("an empty answer is a result, not an error", async (t) => {
  const project = copyFixture(t);
  const client = await connect(t, { cwd: project });

  // Line 1 of Main.elm is blank
  const nothingThere = await callTool(client, "elm_definition", {
    file_path: join(project, "src/Main.elm"),
    line: 1,
    character: 0,
  });
  assert.deepEqual(nothingThere, { text: "No definition found", isError: false });
});
