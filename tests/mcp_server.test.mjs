/**
 * The MCP server as a harness sees it: what it lists and how it answers.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { callTool, connect, copyFixture, runNode, SERVER, tempDir } from "./support.mjs";

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
