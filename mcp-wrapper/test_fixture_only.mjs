#!/usr/bin/env node
/**
 * Simple test of remove_variant on the fixture only
 */

import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUST_LSP_PATH = join(__dirname, "..", "target", "release", "elm_lsp");

class DirectLspClient {
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
        env: { ...process.env, RUST_LOG: "info" },
      });

      this.process.stdout.on("data", (data) => {
        this.handleData(data.toString());
      });

      this.process.stderr.on("data", (data) => {
        console.error(`[stderr] ${data.toString().trim()}`);
      });

      this.process.on("error", reject);

      // Initialize
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
          if (message.error) {
            reject(new Error(message.error.message));
          } else {
            resolve(message.result);
          }
        }
      } catch (e) {}
    }
  }

  sendMessage(message) {
    const content = JSON.stringify(message);
    const header = `Content-Length: ${content.length}\r\n\r\n`;
    this.process.stdin.write(header + content);
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
      }, 30000); // 30 second timeout
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
    await new Promise((r) => setTimeout(r, 500)); // Give more time to parse
  }

  async executeCommand(command, args) {
    return this.sendRequest("workspace/executeCommand", {
      command,
      arguments: args,
    });
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("  Fixture Only Test");
  console.log("=".repeat(70));

  const fixtureDir = join(__dirname, "..", "tests", "fixture");
  const fixtureFile = join(fixtureDir, "src", "TestRemoveVariant.elm");
  const fixtureContent = readFileSync(fixtureFile, "utf-8");
  const fixtureLines = fixtureContent.split("\n");
  const fixtureUri = `file://${fixtureFile}`;

  console.log(`\nWorkspace: ${fixtureDir}`);
  console.log(`File: ${fixtureFile}`);
  console.log(`\nFile content:\n${fixtureContent}\n`);

  const client = new DirectLspClient();

  try {
    console.log("1. Starting LSP...");
    await client.start(fixtureDir);
    console.log("   OK");

    console.log("\n2. Opening document...");
    await client.openDocument(fixtureUri, fixtureContent);
    console.log("   OK");

    // Wait extra time for indexing
    console.log("\n3. Waiting for indexing...");
    await new Promise((r) => setTimeout(r, 2000));
    console.log("   OK");

    // Find Unused variant
    let unusedLine = -1;
    for (let i = 0; i < fixtureLines.length; i++) {
      if (fixtureLines[i].trim().startsWith("| Unused")) {
        unusedLine = i;
        break;
      }
    }

    if (unusedLine >= 0) {
      console.log(`\n4. Testing prepareRemoveVariant on Unused (line ${unusedLine + 1})...`);
      const unusedChar = fixtureLines[unusedLine].indexOf("Unused");
      console.log(`   Position: line=${unusedLine}, char=${unusedChar}`);

      try {
        const prepareResult = await client.executeCommand("elm.prepareRemoveVariant", [
          fixtureUri,
          unusedLine,
          unusedChar,
        ]);
        console.log("   Result:", JSON.stringify(prepareResult, null, 2));

        if (prepareResult.success) {
          console.log("\n5. Testing removeVariant on Unused...");
          const removeResult = await client.executeCommand("elm.removeVariant", [
            fixtureUri,
            unusedLine,
            unusedChar,
          ]);
          console.log("   Result:", JSON.stringify(removeResult, null, 2));
        }
      } catch (e) {
        console.log("   Error:", e.message);
      }
    } else {
      console.log("   Could not find Unused variant");
    }

    // Test Blue (covered by wildcard - should be removable)
    let blueLine = -1;
    for (let i = 0; i < fixtureLines.length; i++) {
      if (fixtureLines[i].trim().startsWith("| Blue")) {
        blueLine = i;
        break;
      }
    }

    if (blueLine >= 0) {
      console.log(`\n6. Testing removeVariant on Blue (covered by wildcard)...`);
      const blueChar = fixtureLines[blueLine].indexOf("Blue");
      try {
        const removeResult = await client.executeCommand("elm.removeVariant", [
          fixtureUri,
          blueLine,
          blueChar,
        ]);
        console.log("   Result:", JSON.stringify(removeResult, null, 2));
        console.log("   Expected: success (Blue is covered by _ -> 'other')");
      } catch (e) {
        console.log("   Error:", e.message);
      }
    }

    // Test Red (explicitly used - should be blocked)
    let redLine = -1;
    for (let i = 0; i < fixtureLines.length; i++) {
      if (fixtureLines[i].trim().startsWith("= Red")) {
        redLine = i;
        break;
      }
    }

    if (redLine >= 0) {
      console.log(`\n7. Testing removeVariant on Red (explicitly used)...`);
      const redChar = fixtureLines[redLine].indexOf("Red");
      try {
        const removeResult = await client.executeCommand("elm.removeVariant", [
          fixtureUri,
          redLine,
          redChar,
        ]);
        console.log("   Result:", JSON.stringify(removeResult, null, 2));
        console.log("   Expected: blocked (Red is explicitly matched)");
      } catch (e) {
        console.log("   Error:", e.message);
      }
    }

    console.log("\n" + "=".repeat(70));
    console.log("  Test complete!");
    console.log("=".repeat(70));
  } catch (error) {
    console.error("\nFATAL ERROR:", error);
  } finally {
    client.stop();
  }
}

main().catch(console.error);
