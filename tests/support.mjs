/**
 * Shared helpers for the node:test suites in this directory.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFile, spawn } from "child_process";
import { once } from "events";
import { createServer } from "net";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER = join(REPO, "mcp-wrapper/index.mjs");

// A scratch directory that is removed when the test ends.
export function tempDir(t) {
  // realpath, because the server reports resolved paths and macOS keeps tmpdir behind a symlink
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "elm-lsp-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A private copy of tests/fixture, so a test can edit files freely.
export function copyFixture(t, name = "fixture") {
  const dir = join(tempDir(t), name);
  cpSync(join(REPO, "tests/fixture"), dir, {
    recursive: true,
    filter: (source) => !source.endsWith("elm-stuff"),
    // The language server reads a file again while it is only moments old. A
    // project's files rarely are, and neither are these with their old dates.
    preserveTimestamps: true,
  });
  return dir;
}

/**
 * A copy of the wrapper in a directory of its own, where no language server
 * was built. A test puts a stand-in at `binary`.
 */
export function wrapperCopy(t) {
  const root = tempDir(t);
  cpSync(join(REPO, "mcp-wrapper"), join(root, "mcp-wrapper"), {
    recursive: true,
    filter: (source) => !source.endsWith("node_modules"),
  });
  symlinkSync(join(REPO, "mcp-wrapper/node_modules"), join(root, "mcp-wrapper/node_modules"));
  return {
    cli: join(root, "mcp-wrapper/cli.mjs"),
    server: join(root, "mcp-wrapper/index.mjs"),
    binary: join(root, "target/release/elm_lsp"),
  };
}

/**
 * Put a language server stand-in at `binary`. It writes its process id to
 * `binary`.pid, answers each request with what `answer` returns for it and
 * stays alive after its input has closed. `answer` is the source of a
 * function from the request to its result.
 */
export function installLanguageServerStandIn(binary, answer = "() => null") {
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(
    binary,
    `#!${process.execPath}
const answer = ${answer};
require("fs").writeFileSync(__filename + ".pid", String(process.pid));
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const bodyAt = buffer.indexOf("\\r\\n\\r\\n") + 4;
    const length = Number(/Content-Length: (\\d+)/.exec(buffer.toString("latin1"))?.[1]);
    if (bodyAt < 4 || buffer.length < bodyAt + length) return;
    const message = JSON.parse(buffer.subarray(bodyAt, bodyAt + length));
    buffer = buffer.subarray(bodyAt + length);
    if (message.id !== undefined) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message) });
      process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
    }
  }
});
setInterval(() => {}, 1000);
`
  );
  chmodSync(binary, 0o755);
}

// Start the MCP server over stdio and connect a client to it.
export async function connect(t, { args = [], cwd, env, server = SERVER } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server, ...args],
    cwd,
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "elm-lsp-rust-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

export async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { text: result.content?.[0]?.text ?? "", isError: result.isError === true };
}

// Run a Node script to completion. Its stdin gets `input`, if any, and is closed.
export function runNode(script, args = [], { cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { cwd, env }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

// Put an executable shell script called `name` into the directory `bin`.
export function installTool(bin, name, script) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
}

// Put an executable shell script into dir/node_modules/.bin, as npm does for a project's tools.
export function installLocalTool(dir, name, script) {
  installTool(join(dir, "node_modules", ".bin"), name, script);
}

// A TCP port that was free a moment ago.
async function freePort() {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  return port;
}

// Start the MCP server over HTTP and connect a client to it.
export async function connectOverHttp(t, { args = [] } = {}) {
  const port = await freePort();
  const server = spawn(process.execPath, [SERVER, "--http", "--port", String(port), ...args], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => server.kill());
  // The server prints its address once it accepts connections
  await once(server.stdout, "data");

  const client = new Client({ name: "elm-lsp-rust-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  t.after(() => client.close());
  return { client, server, port };
}
