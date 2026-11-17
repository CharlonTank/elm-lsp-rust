/**
 * Shared helpers for the node:test suites in this directory.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "fs";
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
  });
  return dir;
}

// Start the MCP server over stdio and connect a client to it.
export async function connect(t, { args = [], cwd, env } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, ...args],
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

// Run a Node script to completion with stdin closed.
export function runNode(script, args = [], { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { cwd, env }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
    child.stdin.end();
  });
}
