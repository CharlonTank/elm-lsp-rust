/**
 * The installation checks behind `cli.mjs doctor`.
 */

import { accessSync, constants, existsSync, statSync } from "fs";
import { delimiter, join } from "path";
import { ElmLspClient, RUST_LSP_PATH } from "./lsp-client.mjs";

// The MCP SDK does not run on anything older
const MIN_NODE_MAJOR = 18;

// Absolute path of an executable file on PATH, or null.
function findOnPath(name) {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

function checkNode() {
  const version = process.versions.node;
  if (Number(version.split(".")[0]) < MIN_NODE_MAJOR) {
    return ["fail", `v${version} is too old. Node.js ${MIN_NODE_MAJOR} or newer is required.`];
  }
  return ["ok", `v${version}`];
}

// The binary exists and answers the LSP handshake.
async function checkLanguageServer() {
  if (!existsSync(RUST_LSP_PATH)) {
    return ["fail", `${RUST_LSP_PATH} is missing. Run scripts/setup.sh to build it.`];
  }
  const client = new ElmLspClient(process.cwd());
  try {
    await client.start();
    return ["ok", RUST_LSP_PATH];
  } catch (error) {
    return ["fail", `${RUST_LSP_PATH} did not start: ${error.message}`];
  } finally {
    client.stop();
  }
}

// The Elm tools are optional. Navigation and refactoring work without them.
function checkTool(names, neededBy) {
  for (const name of names) {
    const path = findOnPath(name);
    if (path) return ["ok", path];
  }
  return ["warn", `not on PATH. ${neededBy} still works in a project that has it in node_modules/.bin.`];
}

/**
 * Run every check. `report` has one line per check, starting with ok, warn or
 * fail. `ok` is false when a check failed, which means the tools cannot run.
 */
export async function runChecks() {
  const checks = [
    ["node", checkNode()],
    ["language server", await checkLanguageServer()],
    ["elm compiler", checkTool(["lamdera", "elm"], "elm_diagnostics")],
    ["elm-format", checkTool(["elm-format"], "elm_format")],
  ];
  const width = Math.max(...checks.map(([name]) => name.length));
  return {
    report: checks.map(([name, [status, detail]]) => `${status.padEnd(4)}  ${name.padEnd(width)}  ${detail}`).join("\n"),
    ok: checks.every(([, [status]]) => status !== "fail"),
  };
}
