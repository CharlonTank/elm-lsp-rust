/**
 * The MCP server as a harness sees it: what it lists and how it answers.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "path";
import { callTool, connect, copyFixture, tempDir } from "./support.mjs";

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
