#!/usr/bin/env node
/**
 * Test chained file operations (multiple renames, moves in sequence)
 * This tests that the LSP restart after file operations works correctly.
 */

import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LSP_PATH = join(__dirname, "..", "target", "release", "elm_lsp");
const TEST_DIR = "/tmp/elm-chained-test";

class LSPClient {
  constructor() {
    this.process = null;
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = "";
  }

  async start(root) {
    return new Promise((resolve, reject) => {
      this.process = spawn(LSP_PATH, [], { stdio: ["pipe", "pipe", "pipe"] });
      this.process.stdout.on("data", d => this.handleData(d.toString()));
      this.process.stderr.on("data", d => {});

      this.send("initialize", { processId: 1, rootUri: `file://${root}`, capabilities: {} })
        .then(() => this.notify("initialized", {}))
        .then(resolve)
        .catch(reject);
    });
  }

  handleData(data) {
    this.buffer += data;
    while (true) {
      const m = this.buffer.match(/Content-Length: (\d+)\r?\n\r?\n/);
      if (!m) break;
      const len = parseInt(m[1]);
      const end = m.index + m[0].length;
      if (this.buffer.length < end + len) break;
      const msg = JSON.parse(this.buffer.slice(end, end + len));
      this.buffer = this.buffer.slice(end + len);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg.result);
        this.pending.delete(msg.id);
      }
    }
  }

  send(method, params, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeout);
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const byteLength = Buffer.byteLength(msg, 'utf8');
      this.process.stdin.write(`Content-Length: ${byteLength}\r\n\r\n${msg}`);
    });
  }

  notify(method, params) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    const byteLength = Buffer.byteLength(msg, 'utf8');
    this.process.stdin.write(`Content-Length: ${byteLength}\r\n\r\n${msg}`);
    return Promise.resolve();
  }

  async openFile(path) {
    const content = readFileSync(path, "utf-8");
    await this.notify("textDocument/didOpen", {
      textDocument: { uri: `file://${path}`, languageId: "elm", version: 1, text: content }
    });
  }

  async renameFile(path, newName, workspaceRoot) {
    const result = await this.send("workspace/executeCommand", {
      command: "elm.renameFile",
      arguments: [`file://${path}`, newName]
    });

    if (result?.success && result?.changes) {
      applyEdits(result.changes);
      // Perform the actual file rename
      renameSync(result.oldPath, result.newPath);
      // Restart LSP to clear cached file state (like MCP wrapper does)
      await this.restart(workspaceRoot);
    }

    return result;
  }

  async moveFile(path, targetPath, workspaceRoot) {
    const result = await this.send("workspace/executeCommand", {
      command: "elm.moveFile",
      arguments: [`file://${path}`, targetPath]
    });

    if (result?.success && result?.changes) {
      applyEdits(result.changes);
      // Create target directory and move file
      mkdirSync(dirname(result.newPath), { recursive: true });
      renameSync(result.oldPath, result.newPath);
      // Restart LSP to clear cached file state (like MCP wrapper does)
      await this.restart(workspaceRoot);
    }

    return result;
  }

  async restart(root) {
    this.stop();
    this.buffer = "";
    this.pending.clear();
    this.requestId = 0;
    await this.start(root);
  }

  stop() { this.process?.kill(); }
}

function applyEdits(changes) {
  for (const [uri, edits] of Object.entries(changes)) {
    const filePath = uri.replace("file://", "");
    if (!existsSync(filePath)) continue;

    let content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    const sortedEdits = [...edits].sort((a, b) => {
      if (b.range.start.line !== a.range.start.line) {
        return b.range.start.line - a.range.start.line;
      }
      return b.range.start.character - a.range.start.character;
    });

    for (const edit of sortedEdits) {
      const { start, end } = edit.range;
      if (start.line === end.line) {
        const line = lines[start.line] || "";
        lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
      }
    }
    writeFileSync(filePath, lines.join("\n"));
  }
}

function setupTestProject() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });

  // elm.json
  writeFileSync(join(TEST_DIR, "elm.json"), JSON.stringify({
    type: "application",
    "source-directories": ["src"],
    "elm-version": "0.19.1",
    dependencies: { direct: { "elm/core": "1.0.5" }, indirect: {} },
    "test-dependencies": { direct: {}, indirect: {} }
  }, null, 2));

  // Main.elm - imports Alpha, Beta, Gamma
  writeFileSync(join(TEST_DIR, "src/Main.elm"), `module Main exposing (main)

import Alpha
import Beta
import Gamma


main =
    Alpha.hello ++ Beta.world ++ Gamma.extra
`);

  // Alpha.elm
  writeFileSync(join(TEST_DIR, "src/Alpha.elm"), `module Alpha exposing (hello)


hello =
    "Hello"
`);

  // Beta.elm
  writeFileSync(join(TEST_DIR, "src/Beta.elm"), `module Beta exposing (world)


world =
    " World"
`);

  // Gamma.elm
  writeFileSync(join(TEST_DIR, "src/Gamma.elm"), `module Gamma exposing (extra)


extra =
    "!"
`);
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;

function logTest(name, success, details = "") {
  const status = success ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`  ${status} ${name}`);
  if (details && !success) {
    console.log(`     ${RED}${details}${RESET}`);
  }
  if (success) passed++;
  else failed++;
}

async function main() {
  console.log(`\n${BOLD}${"=".repeat(70)}${RESET}`);
  console.log(`${BOLD}  Chained File Operations Tests${RESET}`);
  console.log(`${BOLD}${"=".repeat(70)}${RESET}\n`);

  setupTestProject();
  console.log(`${CYAN}Test project created at ${TEST_DIR}${RESET}\n`);

  const client = new LSPClient();
  await client.start(TEST_DIR);

  // ===== TEST 1: Sequential file renames =====
  console.log(`${CYAN}Test 1: Sequential file renames (Alpha → AlphaNew → AlphaFinal)${RESET}`);
  {
    // First rename: Alpha.elm → AlphaNew.elm
    await client.openFile(join(TEST_DIR, "src/Alpha.elm"));
    const result1 = await client.renameFile(join(TEST_DIR, "src/Alpha.elm"), "AlphaNew.elm", TEST_DIR);
    logTest("First rename (Alpha → AlphaNew)", result1?.success === true);

    // Check file exists
    const fileExists1 = existsSync(join(TEST_DIR, "src/AlphaNew.elm"));
    logTest("AlphaNew.elm exists after first rename", fileExists1);

    // Check Main.elm import updated
    const main1 = readFileSync(join(TEST_DIR, "src/Main.elm"), "utf-8");
    logTest("Main.elm imports AlphaNew after first rename", main1.includes("import AlphaNew"));

    // Second rename: AlphaNew.elm → AlphaFinal.elm (tests LSP restart worked)
    await client.openFile(join(TEST_DIR, "src/AlphaNew.elm"));
    const result2 = await client.renameFile(join(TEST_DIR, "src/AlphaNew.elm"), "AlphaFinal.elm", TEST_DIR);
    logTest("Second rename (AlphaNew → AlphaFinal)", result2?.success === true);

    // Check file exists
    const fileExists2 = existsSync(join(TEST_DIR, "src/AlphaFinal.elm"));
    logTest("AlphaFinal.elm exists after second rename", fileExists2);

    // Check Main.elm import updated
    const main2 = readFileSync(join(TEST_DIR, "src/Main.elm"), "utf-8");
    logTest("Main.elm imports AlphaFinal after second rename", main2.includes("import AlphaFinal"));
  }

  // ===== TEST 2: File rename followed by move =====
  console.log(`\n${CYAN}Test 2: File rename followed by move (Beta → BetaRenamed → Utils/BetaRenamed)${RESET}`);
  {
    // First: rename Beta.elm → BetaRenamed.elm
    await client.openFile(join(TEST_DIR, "src/Beta.elm"));
    const result1 = await client.renameFile(join(TEST_DIR, "src/Beta.elm"), "BetaRenamed.elm", TEST_DIR);
    logTest("Rename Beta → BetaRenamed", result1?.success === true);

    // Then: move BetaRenamed.elm → Utils/BetaRenamed.elm
    await client.openFile(join(TEST_DIR, "src/BetaRenamed.elm"));
    const result2 = await client.moveFile(join(TEST_DIR, "src/BetaRenamed.elm"), "src/Utils/BetaRenamed.elm", TEST_DIR);
    logTest("Move BetaRenamed → Utils/BetaRenamed", result2?.success === true);

    // Check file exists in new location
    const fileExists = existsSync(join(TEST_DIR, "src/Utils/BetaRenamed.elm"));
    logTest("Utils/BetaRenamed.elm exists", fileExists);

    // Check Main.elm import updated
    const main = readFileSync(join(TEST_DIR, "src/Main.elm"), "utf-8");
    logTest("Main.elm imports Utils.BetaRenamed", main.includes("import Utils.BetaRenamed"));
  }

  // ===== TEST 3: Multiple moves in sequence =====
  console.log(`\n${CYAN}Test 3: Multiple moves (Gamma → Utils/Gamma → Helpers/Gamma)${RESET}`);
  {
    // First move: Gamma.elm → Utils/Gamma.elm
    await client.openFile(join(TEST_DIR, "src/Gamma.elm"));
    const result1 = await client.moveFile(join(TEST_DIR, "src/Gamma.elm"), "src/Utils/Gamma.elm", TEST_DIR);
    logTest("First move (Gamma → Utils/Gamma)", result1?.success === true);

    // Check file exists
    const fileExists1 = existsSync(join(TEST_DIR, "src/Utils/Gamma.elm"));
    logTest("Utils/Gamma.elm exists", fileExists1);

    // Check Main.elm import updated
    const main1 = readFileSync(join(TEST_DIR, "src/Main.elm"), "utf-8");
    logTest("Main.elm imports Utils.Gamma", main1.includes("import Utils.Gamma"));

    // Second move: Utils/Gamma.elm → Helpers/Gamma.elm
    await client.openFile(join(TEST_DIR, "src/Utils/Gamma.elm"));
    const result2 = await client.moveFile(join(TEST_DIR, "src/Utils/Gamma.elm"), "src/Helpers/Gamma.elm", TEST_DIR);
    logTest("Second move (Utils/Gamma → Helpers/Gamma)", result2?.success === true);

    // Check file exists in new location
    const fileExists2 = existsSync(join(TEST_DIR, "src/Helpers/Gamma.elm"));
    logTest("Helpers/Gamma.elm exists", fileExists2);

    // Check Main.elm import updated
    const main2 = readFileSync(join(TEST_DIR, "src/Main.elm"), "utf-8");
    logTest("Main.elm imports Helpers.Gamma", main2.includes("import Helpers.Gamma"));
  }

  // ===== Final state verification =====
  console.log(`\n${CYAN}Final State Verification${RESET}`);
  {
    const main = readFileSync(join(TEST_DIR, "src/Main.elm"), "utf-8");
    console.log("\n--- Final Main.elm ---");
    console.log(main);

    // Check all imports are correct
    logTest("Final: No old 'Alpha' import", !main.includes("import Alpha\n"));
    logTest("Final: No old 'Beta' import", !main.includes("import Beta\n"));
    logTest("Final: No old 'Gamma' import", !main.includes("import Gamma\n"));
    logTest("Final: Has AlphaFinal import", main.includes("import AlphaFinal"));
    logTest("Final: Has Utils.BetaRenamed import", main.includes("import Utils.BetaRenamed"));
    logTest("Final: Has Helpers.Gamma import", main.includes("import Helpers.Gamma"));
  }

  client.stop();

  // Summary
  console.log(`\n${BOLD}${"=".repeat(70)}${RESET}`);
  console.log(`${BOLD}  Summary: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
  console.log(`${BOLD}${"=".repeat(70)}${RESET}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
