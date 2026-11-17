/**
 * The language server client: process lifetime and message framing.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ensureClient, stopClients } from "../mcp-wrapper/lsp-client.mjs";
import { copyFixture } from "./support.mjs";

async function symbolNames(client, file) {
  const uri = `file://${file}`;
  await client.openDocument(uri, readFileSync(file, "utf-8"));
  return (await client.getSymbols(uri)).map((symbol) => symbol.name);
}

test("concurrent calls for one project share one language server", async (t) => {
  t.after(stopClients);
  const project = copyFixture(t);

  const [first, second] = await Promise.all([ensureClient(project), ensureClient(project)]);
  assert.equal(first, second);
});

test("each project gets its own language server", async (t) => {
  t.after(stopClients);
  const [one, two] = [copyFixture(t, "one"), copyFixture(t, "two")];

  const clientOne = await ensureClient(one);
  const clientTwo = await ensureClient(two);
  assert.notEqual(clientOne, clientTwo);
  // Starting the second server left the first one running
  assert.equal(await ensureClient(one), clientOne);
  assert.deepEqual(await symbolNames(clientOne, join(one, "src/Types.elm")), [
    "User",
    "defaultUser",
    "Guest",
    "createGuest",
  ]);
});

test("a language server that died is replaced on the next call", async (t) => {
  t.after(stopClients);
  const project = copyFixture(t);

  const first = await ensureClient(project);
  const exited = once(first.process, "close");
  first.process.kill();
  await exited;
  await assert.rejects(first.getSymbols(`file://${project}/src/Types.elm`), /language server has stopped/);

  const second = await ensureClient(project);
  assert.notEqual(second, first);
  assert.equal((await symbolNames(second, join(project, "src/Types.elm"))).length, 4);
});

test("a request in flight fails when the language server dies", async (t) => {
  t.after(stopClients);
  const client = await ensureClient(copyFixture(t));

  // Freeze the server first, so it cannot answer before it is killed
  client.process.kill("SIGSTOP");
  const answer = client.getSymbols(`file://${client.workspaceRoot}/src/Types.elm`);
  client.process.kill("SIGKILL");
  await assert.rejects(answer, /LSP process exited/);
  assert.equal(client.pendingRequests.size, 0);
});
