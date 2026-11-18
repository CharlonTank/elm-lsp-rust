/**
 * The MCP server as a harness sees it: what it lists and how it answers.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
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

// The language server counts columns in bytes and the wrapper applies them as
// character positions. Until the server settles on one unit, this fails.
test.todo("a rename lands on its symbol on a line with non-ASCII text before it", async (t) => {
  const project = copyFixture(t);
  const main = join(project, "src/Main.elm");
  writeFileSync(main, readFileSync(main, "utf-8").replace('" - Formatted: "', '"café: "'));
  const client = await connect(t, { cwd: project });

  await callTool(client, "elm_rename_function", {
    file_path: join(project, "src/Utils.elm"),
    line: 6,
    character: 0,
    old_name: "formatName",
    newName: "shout",
  });
  assert.match(readFileSync(main, "utf-8"), /"café: " \+\+ shout model\.user\.name/);
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
