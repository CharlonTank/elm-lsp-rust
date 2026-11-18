/**
 * File URIs and the writing of edits.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { ToolError } from "../mcp-wrapper/errors.mjs";
import { ElmLspClient } from "../mcp-wrapper/lsp-client.mjs";
import { applyWorkspaceEdit, projectDirectories, toFileUri } from "../mcp-wrapper/workspace.mjs";
import { copyFixture, tempDir } from "./support.mjs";

test("the wrapper spells a file URI exactly as the language server does", async (t) => {
  // Every printable ASCII character a directory name can hold, and some that are not ASCII
  const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).filter((c) => c !== "/");
  const project = copyFixture(t, `${ascii.join("")} é 日本 🌳`);
  const [main, utils] = [join(project, "src/Main.elm"), join(project, "src/Utils.elm")];
  const client = new ElmLspClient(project);
  t.after(() => client.stop());
  await client.start();
  await client.openDocument(toFileUri(utils), readFileSync(utils, "utf-8"));

  // formatName is defined in Utils.elm and used in Main.elm. The server names
  // Main.elm from its own index and Utils.elm as the wrapper opened it.
  const { changes } = await client.rename(toFileUri(utils), 6, 0, "shout");
  assert.deepEqual(Object.keys(changes).sort(), [toFileUri(main), toFileUri(utils)].sort());
});

test("an edit listed under two spellings of one file is applied once", async (t) => {
  const root = join(tempDir(t), "a~b");
  mkdirSync(root);
  const file = join(root, "Main.elm");
  writeFileSync(file, "old = 1\nmain = old\n");
  const told = [];
  const client = { notifyFileChanged: async (uri) => told.push(uri) };
  const rename = (line, character) => ({
    range: { start: { line, character }, end: { line, character: character + 3 } },
    newText: "fresh",
  });

  const applied = await applyWorkspaceEdit(
    {
      [toFileUri(file)]: [rename(0, 0), rename(1, 7)],
      [toFileUri(file).replace("~", "%7E")]: [rename(1, 7), rename(0, 0)],
    },
    client,
    root
  );

  // Applied twice, the second pass would overwrite text the first one moved
  assert.equal(readFileSync(file, "utf-8"), "fresh = 1\nmain = fresh\n");
  assert.deepEqual(applied, [{ path: file, edits: 2 }]);
  assert.deepEqual(told, [toFileUri(file)]);
});

test("a change that names a file outside the project, or one that is gone, changes no file", async (t) => {
  const root = join(tempDir(t), "app");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "elm.json"), JSON.stringify({ "source-directories": ["src", "../shared"] }));
  const inside = join(root, "src/Main.elm");
  const outside = join(dirname(root), "elsewhere/Other.elm");
  mkdirSync(dirname(outside));
  writeFileSync(inside, "old = 1\n");
  writeFileSync(outside, "old = 1\n");
  const client = { notifyFileChanged: async () => assert.fail("no file was to be changed") };
  const rename = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "fresh" }];
  const apply = (...files) => applyWorkspaceEdit(Object.fromEntries(files.map((file) => [toFileUri(file), rename])), client, root);

  assert.deepEqual(projectDirectories(root), [root, join(root, "src"), join(dirname(root), "shared")]);
  await assert.rejects(apply(inside, outside), (error) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.message, `The change reaches ${outside}, outside the project and the source directories of its elm.json, so no file was changed.`);
    return true;
  });
  // A file the index still names, though it is no longer there
  const gone = join(root, "src/Gone.elm");
  await assert.rejects(apply(inside, gone), (error) => error instanceof ToolError && error.message.startsWith(`Cannot read ${gone}, so no file was changed. `));
  assert.equal(readFileSync(inside, "utf-8"), "old = 1\n");
  assert.equal(readFileSync(outside, "utf-8"), "old = 1\n");
});
