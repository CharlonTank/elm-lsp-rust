#!/usr/bin/env node
/**
 * Test the remove_variant feature directly via LSP commands
 * Bypasses MCP wrapper - tests the Rust LSP directly
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
      }, 10000);
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
    return this.sendRequest("workspace/executeCommand", {
      command,
      arguments: args,
    });
  }

  async getSymbols(uri) {
    return this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
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
  console.log("  Remove Variant Feature Test");
  console.log("=".repeat(70));

  const testDir = join(__dirname, "..", "tests", "meetdown");
  const testFile = join(testDir, "src", "Event.elm");

  console.log(`\nWorkspace: ${testDir}`);
  console.log(`Test file: ${testFile}`);

  const content = readFileSync(testFile, "utf-8");
  const lines = content.split("\n");

  // Find CancellationStatus type and its variants - must be at start of line (type declaration)
  let typeLineIdx = -1;
  let variant1LineIdx = -1;
  let variant2LineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("type CancellationStatus")) {
      typeLineIdx = i;
    }
    // Look for variant declarations (start with = or |)
    if (line.trim().startsWith("= EventCancelled") || line.trim() === "EventCancelled") {
      variant1LineIdx = i;
    }
    if (line.trim().startsWith("| EventUncancelled")) {
      variant2LineIdx = i;
    }
  }

  console.log(`\nFound type CancellationStatus at line ${typeLineIdx + 1}`);
  console.log(`  Variant EventCancelled at line ${variant1LineIdx + 1}: "${lines[variant1LineIdx]}"`);
  console.log(`  Variant EventUncancelled at line ${variant2LineIdx + 1}: "${lines[variant2LineIdx]}"`);

  const client = new DirectLspClient();

  try {
    console.log("\n1. Starting LSP...");
    await client.start(testDir);
    console.log("   OK");

    console.log("\n2. Opening document...");
    const uri = `file://${testFile}`;
    await client.openDocument(uri, content);
    console.log("   OK");

    console.log("\n3. Getting document symbols...");
    const symbols = await client.getSymbols(uri);
    if (symbols && Array.isArray(symbols)) {
      const enumSymbols = symbols.filter((s) => s.kind === 10); // ENUM
      console.log(`   Found ${enumSymbols.length} enum types:`);
      for (const sym of enumSymbols) {
        console.log(`   - ${sym.name} at line ${sym.range?.start?.line + 1 || "?"}`);
      }
    } else {
      console.log(`   Symbols result: ${JSON.stringify(symbols)?.slice(0, 200)}`);
    }

    console.log("\n4. Testing prepareRemoveVariant on EventCancelled...");
    const variantLine = variant1LineIdx;
    const variantChar = lines[variantLine].indexOf("EventCancelled");
    console.log(`   Position: line ${variantLine}, char ${variantChar}`);

    try {
      const prepareResult = await client.executeCommand("elm.prepareRemoveVariant", [
        uri,
        variantLine,
        variantChar,
      ]);
      console.log("   Result:", JSON.stringify(prepareResult, null, 2));
    } catch (e) {
      console.log("   Error:", e.message);
    }

    console.log("\n5. Testing removeVariant on EventCancelled...");
    try {
      const removeResult = await client.executeCommand("elm.removeVariant", [
        uri,
        variantLine,
        variantChar,
      ]);
      console.log("   Result:", JSON.stringify(removeResult, null, 2));
    } catch (e) {
      console.log("   Error:", e.message);
    }

    // Test on EventType which has 3 variants
    console.log("\n6. Finding EventType variants...");
    let eventTypeLine = -1;
    let meetOnlineLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("type EventType")) {
        eventTypeLine = i;
      }
      // Look for = MeetOnline (first variant)
      if (lines[i].trim().startsWith("= MeetOnline")) {
        meetOnlineLine = i;
      }
    }
    if (eventTypeLine >= 0 && meetOnlineLine >= 0) {
      console.log(`   EventType at line ${eventTypeLine + 1}`);
      console.log(`   MeetOnline at line ${meetOnlineLine + 1}: "${lines[meetOnlineLine]}"`);

      console.log("\n7. Testing prepareRemoveVariant on MeetOnline...");
      const meetOnlineChar = lines[meetOnlineLine].indexOf("MeetOnline");
      try {
        const prepareResult = await client.executeCommand("elm.prepareRemoveVariant", [
          uri,
          meetOnlineLine,
          meetOnlineChar,
        ]);
        console.log("   Result:", JSON.stringify(prepareResult, null, 2));
      } catch (e) {
        console.log("   Error:", e.message);
      }
    } else {
      console.log("   Could not find EventType variants");
    }

    // Test on our custom fixture with unused variants
    console.log("\n" + "=".repeat(70));
    console.log("  Testing with unused variant fixture");
    console.log("=".repeat(70));

    const fixtureDir = join(__dirname, "..", "tests", "fixture");
    const fixtureFile = join(fixtureDir, "src", "TestRemoveVariant.elm");
    const fixtureContent = readFileSync(fixtureFile, "utf-8");
    const fixtureLines = fixtureContent.split("\n");
    const fixtureUri = `file://${fixtureFile}`;

    // Start a new client for the fixture
    client.stop();
    const client2 = new DirectLspClient();
    await client2.start(fixtureDir);
    await client2.openDocument(fixtureUri, fixtureContent);

    // Find Unused variant (line 11, char 6)
    let unusedLine = -1;
    for (let i = 0; i < fixtureLines.length; i++) {
      if (fixtureLines[i].trim().startsWith("| Unused")) {
        unusedLine = i;
        break;
      }
    }

    if (unusedLine >= 0) {
      console.log(`\n8. Testing prepareRemoveVariant on Unused variant (line ${unusedLine + 1})...`);
      const unusedChar = fixtureLines[unusedLine].indexOf("Unused");
      try {
        const prepareResult = await client2.executeCommand("elm.prepareRemoveVariant", [
          fixtureUri,
          unusedLine,
          unusedChar,
        ]);
        console.log("   Result:", JSON.stringify(prepareResult, null, 2));
      } catch (e) {
        console.log("   Error:", e.message);
      }

      console.log("\n9. Testing removeVariant on Unused (should succeed - no usages)...");
      try {
        const removeResult = await client2.executeCommand("elm.removeVariant", [
          fixtureUri,
          unusedLine,
          unusedChar,
        ]);
        console.log("   Result:", JSON.stringify(removeResult, null, 2));
      } catch (e) {
        console.log("   Error:", e.message);
      }
    }

    // Find Blue variant (covered by wildcard)
    let blueLine = -1;
    for (let i = 0; i < fixtureLines.length; i++) {
      if (fixtureLines[i].trim().startsWith("| Blue")) {
        blueLine = i;
        break;
      }
    }

    if (blueLine >= 0) {
      console.log(`\n10. Testing removeVariant on Blue (covered by wildcard)...`);
      const blueChar = fixtureLines[blueLine].indexOf("Blue");
      try {
        const removeResult = await client2.executeCommand("elm.removeVariant", [
          fixtureUri,
          blueLine,
          blueChar,
        ]);
        console.log("   Result:", JSON.stringify(removeResult, null, 2));
      } catch (e) {
        console.log("   Error:", e.message);
      }
    }

    client2.stop();

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
