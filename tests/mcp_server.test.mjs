/**
 * The MCP server as a harness sees it: what it lists and how it answers.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { callTool, connect, copyFixture, installLocalTool, installTool, runNode, SERVER, tempDir } from "./support.mjs";

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
async function compilerUsed(t, project, globalTools, restOfPath = process.env.PATH) {
  const globalBin = tempDir(t);
  for (const [name, script] of Object.entries(globalTools)) {
    installTool(globalBin, name, script);
  }
  const client = await connect(t, { cwd: tempDir(t), env: { PATH: `${globalBin}:${restOfPath}` } });
  const diagnostics = await callTool(client, "elm_diagnostics", { file_path: join(project, "src/Main.elm") });
  return /^Line 3:1 - (.*)\n\nthis compiler ran$/.exec(diagnostics.text)?.[1] ?? diagnostics.text;
}

const globalCompilers = { elm: compilerNamed("GLOBAL ELM"), lamdera: compilerNamed("GLOBAL LAMDERA") };

test("an Elm project is built with the elm in its node_modules, whatever is installed globally", async (t) => {
  const project = copyFixture(t);
  installLocalTool(project, "elm", compilerNamed("PROJECT ELM"));

  assert.equal(await compilerUsed(t, project, globalCompilers), "PROJECT ELM");
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
  assert.equal(await compilerUsed(t, project, { lamdera: globalCompilers.lamdera }, "/usr/bin:/bin"), "GLOBAL LAMDERA");
});

test("only elm_diagnostics runs the compiler", async (t) => {
  const project = copyFixture(t);
  const runs = join(project, "compiler-runs.log");
  // A compiler that records each run and finds nothing wrong
  const recordingCompiler = `echo run >> "${runs}"`;
  installLocalTool(project, "lamdera", recordingCompiler);
  installLocalTool(project, "elm", recordingCompiler);
  const client = await connect(t, { cwd: project });
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

test("tools installed at the root of a monorepo are found from the Elm project inside it", async (t) => {
  const project = copyFixture(t, "client");
  const monorepo = dirname(project);
  installLocalTool(monorepo, "elm-format", 'echo "$@" > "$(dirname "$0")/elm-format.called"');
  const client = await connect(t, { cwd: tempDir(t) });

  const file = join(project, "src/Main.elm");
  const formatted = await callTool(client, "elm_format", { file_path: file });
  assert.deepEqual(formatted, { text: `Successfully formatted ${file}`, isError: false });
  const record = join(monorepo, "node_modules/.bin/elm-format.called");
  assert.ok(existsSync(record), "the monorepo's elm-format ran");
  assert.equal(readFileSync(record, "utf-8"), `--yes ${file}\n`);
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

test("--elm-projects-only exits quietly outside an Elm project", async (t) => {
  const { code, stdout } = await runNode(SERVER, ["--elm-projects-only"], { cwd: tempDir(t) });
  assert.equal(code, 0);
  assert.equal(stdout, "");
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
    assert.equal(tool.annotations.openWorldHint, false, `${tool.name} stays on this machine`);
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

  const outsideAnyProject = await callTool(client, "elm_definition", {
    file_path: join(tempDir(t), "Stray.elm"),
    line: 0,
    character: 0,
  });
  assert.equal(outsideAnyProject.isError, true);
  assert.match(outsideAnyProject.text, /No elm\.json found/);

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
