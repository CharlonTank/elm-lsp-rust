/**
 * The MCP server as a harness sees it: what it lists and how it answers.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "path";
import { callTool, connect, copyFixture, tempDir } from "./support.mjs";

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
