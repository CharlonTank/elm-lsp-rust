#!/usr/bin/env node
/**
 * Simple test for branches - tests the new {imports, code} format
 */

import { spawn } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUST_LSP_PATH = join(__dirname, "..", "target", "release", "elm_lsp");
const MEETDOWN_DIR = join(__dirname, "meetdown");

class LspClient {
  constructor() {
    this.process = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.buffer = "";
  }

  async start(workspaceRoot) {
    return new Promise((resolve, reject) => {
      this.process = spawn(RUST_LSP_PATH, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, RUST_LOG: "warn" },
      });

      this.process.stdout.on("data", (data) => {
        this.handleData(data.toString());
      });

      this.process.stderr.on("data", (data) => {
        console.error(`[stderr] ${data.toString().trim()}`);
      });

      this.process.on("error", reject);

      this.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceRoot}`,
        capabilities: {},
      })
        .then(() => this.sendNotification("initialized", {}))
        .then(resolve)
        .catch(reject);
    });
  }

  handleData(data) {
    this.buffer += data;
    while (true) {
      const headerMatch = this.buffer.match(/Content-Length: (\d+)\r?\n\r?\n/);
      if (!headerMatch) break;
      const length = parseInt(headerMatch[1]);
      const headerEnd = headerMatch.index + headerMatch[0].length;
      if (this.buffer.length < headerEnd + length) break;
      const content = this.buffer.slice(headerEnd, headerEnd + length);
      this.buffer = this.buffer.slice(headerEnd + length);
      try {
        const message = JSON.parse(content);
        if (message.id !== undefined && this.pendingRequests.has(message.id)) {
          const { resolve, reject } = this.pendingRequests.get(message.id);
          this.pendingRequests.delete(message.id);
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        }
      } catch (e) {}
    }
  }

  sendMessage(message) {
    const content = JSON.stringify(message);
    const byteLength = Buffer.byteLength(content, "utf8");
    this.process.stdin.write(`Content-Length: ${byteLength}\r\n\r\n${content}`);
  }

  sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });
      this.sendMessage({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  sendNotification(method, params) {
    this.sendMessage({ jsonrpc: "2.0", method, params });
    return Promise.resolve();
  }

  async openDocument(uri, content) {
    await this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "elm", version: 1, text: content },
    });
    await new Promise((r) => setTimeout(r, 200));
  }

  async executeCommand(command, args) {
    return this.sendRequest("workspace/executeCommand", { command, arguments: args });
  }

  stop() {
    if (this.process) this.process.kill();
  }
}

async function main() {
  const typesFile = join(MEETDOWN_DIR, "src/Types.elm");
  const originalContent = readFileSync(typesFile, "utf-8");

  console.log("Starting LSP...");
  const client = new LspClient();
  await client.start(MEETDOWN_DIR);
  console.log("LSP started!");

  const uri = `file://${typesFile}`;
  await client.openDocument(uri, originalContent);

  console.log("\n1. Testing prepare_add_variant...");
  const prepResult = await client.executeCommand("elm.prepareAddVariant", [
    uri, "ColorTheme", "SystemTheme"
  ]);
  console.log("Prepare result:", JSON.stringify(prepResult, null, 2));

  console.log("\n2. Testing add_variant with branches...");
  // Build branches array matching casesNeedingBranch count
  // Using new type-safe enum format: "AddDebug" | {AddCode: "..."} | {AddCodeWithImports: {...}}
  const branches = [];
  for (let i = 0; i < prepResult.casesNeedingBranch; i++) {
    branches.push({ AddCode: "LightTheme" });
  }

  const addResult = await client.executeCommand("elm.addVariant", [
    uri,
    "ColorTheme",
    "SystemTheme",
    "",
    branches
  ]);
  console.log("Add result:", JSON.stringify(addResult, null, 2));

  client.stop();

  // Restore
  writeFileSync(typesFile, originalContent);
  console.log("\nTest complete, files restored.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
