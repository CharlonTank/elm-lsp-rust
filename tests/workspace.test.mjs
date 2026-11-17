/**
 * File URIs and the writing of edits.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ElmLspClient } from "../mcp-wrapper/lsp-client.mjs";
import { applyWorkspaceEdit, toFileUri } from "../mcp-wrapper/workspace.mjs";
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
