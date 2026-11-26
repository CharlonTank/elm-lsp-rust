/**
 * The language server client: process lifetime and message framing.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ElmLspClient, ensureClient, IDLE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, serveOneCall, stopClients } from "../mcp-wrapper/lsp-client.mjs";
import { toFileUri } from "../mcp-wrapper/workspace.mjs";
import { copyFixture, tempDir } from "./support.mjs";

const uriOf = (...segments) => toFileUri(join(...segments));

async function symbolNames(client, file) {
  const uri = uriOf(file);
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
  await assert.rejects(first.getSymbols(uriOf(project, "src/Types.elm")), /language server has stopped/);

  const second = await ensureClient(project);
  assert.notEqual(second, first);
  assert.equal((await symbolNames(second, join(project, "src/Types.elm"))).length, 4);
});

test("a language server nobody has used for a while is stopped, and the next call starts a new one", async (t) => {
  t.after(stopClients);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const project = copyFixture(t);

  const first = await ensureClient(project);
  t.mock.timers.tick(IDLE_TIMEOUT_MS - 1);
  // A use shortly before the limit starts the countdown again
  assert.equal(await ensureClient(project), first);
  t.mock.timers.tick(IDLE_TIMEOUT_MS - 1);
  assert.notEqual(first.process, null);

  const exited = once(first.process, "close");
  t.mock.timers.tick(1);
  // The old server has its signal and is not gone yet. A call that arrives now gets a new one.
  const second = await ensureClient(project);
  assert.notEqual(second, first);
  assert.notEqual(second.process, null);

  await exited;
  // The old server's exit leaves the new one in its place
  assert.equal(await ensureClient(project), second);
});

test("a request in flight fails when the language server dies", async (t) => {
  t.after(stopClients);
  const client = await ensureClient(copyFixture(t));

  // Freeze the server first, so it cannot answer before it is killed
  client.process.kill("SIGSTOP");
  const answer = client.getSymbols(uriOf(client.workspaceRoot, "src/Types.elm"));
  client.process.kill("SIGKILL");
  await assert.rejects(answer, /LSP process exited/);
  assert.equal(client.pendingRequests.size, 0);
});

test("a compile that outlasts the wait for an answer says that the compiler goes on", async (t) => {
  t.after(stopClients);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const project = copyFixture(t);
  const client = await ensureClient(project);
  const main = uriOf(project, "src/Main.elm");

  // A server that answers nothing, as one does while the compiler runs
  client.process.kill("SIGSTOP");
  const answer = client.getDiagnostics(main);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await assert.rejects(answer, {
    message:
      "The Elm compiler did not finish within 30 seconds. It is still running, and the language server answers no call for this project until it ends. " +
      "Make the same call again once it has ended to get its diagnostics",
  });
  assert.equal(client.pendingRequests.size, 0);

  // The same call again, as a tool makes it, waits behind the compiler
  const again = ensureClient(project);
  while (client.pendingRequests.size === 0) await new Promise(setImmediate);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await assert.rejects(again, {
    message:
      "The Elm compiler of an earlier elm_diagnostics call is still running, and the language server answers no call for this project until it ends. " +
      "Make the call again once it has ended",
  });

  // The compiler ends, and its answer and the one to the second call arrive while a third call
  // waits. They settle nothing, and the third call gets its own answer.
  client.process.kill("SIGCONT");
  assert.equal(await ensureClient(project), client);
  assert.ok(Array.isArray((await client.getDiagnostics(main)).diagnostics));

  // A request that runs out of time now says only that
  client.process.kill("SIGSTOP");
  const symbols = client.getSymbols(main);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await assert.rejects(symbols, { message: "Request textDocument/documentSymbol timed out" });
  client.process.kill("SIGKILL");
});

test("on the command line a compile that outlasts the wait says that the compiler goes on after the command", async (t) => {
  t.after(stopClients);
  serveOneCall();
  t.after(() => serveOneCall(false));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const project = copyFixture(t);
  const client = await ensureClient(project);

  client.process.kill("SIGSTOP");
  const answer = client.getDiagnostics(uriOf(project, "src/Main.elm"));
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await assert.rejects(answer, {
    message:
      "The Elm compiler did not finish within 30 seconds. It goes on in the background after this command ends. " +
      "Wait for it to end before you ask for diagnostics again, because each call starts a compiler of its own",
  });
  client.process.kill("SIGKILL");
});

test("the language server answers the handshake on every start", async (t) => {
  // In an empty directory the server has nothing to index and answers at once.
  // With tokio 1.52.0 such an answer stayed unwritten about once in a hundred
  // starts, until the next message arrived (tokio-rs/tokio#8056).
  const emptyDir = tempDir(t);
  const start = async () => {
    const client = new ElmLspClient(emptyDir);
    await client.start();
    client.stop();
  };

  for (let batch = 0; batch < 50; batch++) {
    await Promise.all(Array.from({ length: 8 }, start));
  }
});

// An LSP response as the server writes it: a byte count, a blank line, the JSON body.
function frame(message) {
  const body = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

// A client that is not attached to a process, with requests 1..count pending.
function clientAwaiting(count) {
  const client = new ElmLspClient("/unused");
  const answers = [];
  for (let id = 1; id <= count; id++) {
    client.pendingRequests.set(id, { resolve: (result) => answers.push(result), reject: assert.fail });
  }
  return { client, answers };
}

test("a response with non-ASCII text arrives whole, however it is chunked", () => {
  const { client, answers } = clientAwaiting(1);
  const bytes = frame({ jsonrpc: "2.0", id: 1, result: "café ☕" });

  // Cut inside the two-byte "é"
  const cut = bytes.indexOf("é") + 1;
  client.handleData(bytes.subarray(0, cut));
  assert.deepEqual(answers, []);
  client.handleData(bytes.subarray(cut));
  assert.deepEqual(answers, ["café ☕"]);
});

test("responses that share a chunk are told apart", () => {
  const { client, answers } = clientAwaiting(2);
  const first = frame({ jsonrpc: "2.0", id: 1, result: "naïve" });
  const second = frame({ jsonrpc: "2.0", id: 2, result: "plain" });
  const stream = Buffer.concat([first, second]);

  // The first chunk ends inside the header of the second response
  client.handleData(stream.subarray(0, first.length + 5));
  assert.deepEqual(answers, ["naïve"]);
  client.handleData(stream.subarray(first.length + 5));
  assert.deepEqual(answers, ["naïve", "plain"]);
});
