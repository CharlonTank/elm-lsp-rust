#!/usr/bin/env node
/**
 * Test remove_variant on meetdown project - many types and variants
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
        env: { ...process.env, RUST_LOG: "warn" },
      });

      this.process.stdout.on("data", (data) => {
        this.handleData(data.toString());
      });

      this.process.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg && !msg.includes("WARN")) {
          console.error(`[stderr] ${msg}`);
        }
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
    await new Promise((r) => setTimeout(r, 100));
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

// Find variant line in file content
function findVariantLine(lines, variantName, prefix = "|") {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(`${prefix} ${variantName}`) || trimmed.startsWith(`${prefix}${variantName}`)) {
      return { line: i, char: lines[i].indexOf(variantName) };
    }
    if (prefix === "=" && trimmed.startsWith(`= ${variantName}`)) {
      return { line: i, char: lines[i].indexOf(variantName) };
    }
  }
  return null;
}

async function testVariant(client, filePath, variantName, description) {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const uri = `file://${filePath}`;

  await client.openDocument(uri, content);

  // Try to find variant with | or =
  let pos = findVariantLine(lines, variantName, "|");
  if (!pos) pos = findVariantLine(lines, variantName, "=");

  if (!pos) {
    console.log(`   ❌ Could not find variant ${variantName}`);
    return;
  }

  console.log(`\n   Testing: ${variantName} (${description})`);
  console.log(`   File: ${filePath.split("/").slice(-2).join("/")}`);
  console.log(`   Position: line ${pos.line + 1}, char ${pos.char}`);

  try {
    const prepareResult = await client.executeCommand("elm.prepareRemoveVariant", [
      uri,
      pos.line,
      pos.char,
    ]);

    if (prepareResult.success) {
      console.log(`   Type: ${prepareResult.typeName}`);
      console.log(`   Variant: ${prepareResult.variantName} (${prepareResult.variantIndex + 1}/${prepareResult.totalVariants})`);
      console.log(`   Usages: ${prepareResult.usagesCount}`);

      // Try to remove
      const removeResult = await client.executeCommand("elm.removeVariant", [
        uri,
        pos.line,
        pos.char,
      ]);

      if (removeResult.success) {
        console.log(`   ✅ Can remove: ${removeResult.message}`);
      } else {
        console.log(`   ⚠️  Cannot remove: ${removeResult.error}`);
        console.log(`   Other variants: [${removeResult.otherVariants?.join(", ")}]`);
        if (removeResult.blockingUsages && removeResult.blockingUsages.length > 0) {
          console.log(`   Blocking usages (first 3):`);
          removeResult.blockingUsages.slice(0, 3).forEach((u, idx) => {
            const file = u.uri.split("/").pop();
            const func = u.function_name || "(top-level)";
            console.log(`     ${idx + 1}. ${u.module_name}.${func}:${u.line + 1}`);
            console.log(`        Context: "${u.context}"`);
            if (u.call_chain && u.call_chain.length > 0) {
              console.log(`        Call chain:`);
              u.call_chain.forEach((c, i) => {
                const marker = c.is_entry_point ? " [ENTRY]" : "";
                const indent = "          " + "  ".repeat(i);
                console.log(`${indent}→ ${c.module_name}.${c.function}:${c.line + 1}${marker}`);
              });
            }
          });
          if (removeResult.blockingUsages.length > 3) {
            console.log(`     ... and ${removeResult.blockingUsages.length - 3} more`);
          }
        }
      }
    } else {
      console.log(`   ❌ Prepare failed: ${prepareResult.error}`);
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("  Meetdown Remove Variant Tests");
  console.log("=".repeat(70));

  const meetdownDir = join(__dirname, "..", "tests", "meetdown");

  const client = new DirectLspClient();

  try {
    console.log("\nStarting LSP and indexing meetdown (703 files)...");
    await client.start(meetdownDir);
    console.log("LSP started successfully");

    // Wait for indexing
    await new Promise((r) => setTimeout(r, 2000));

    // Test 1: Event.elm - CancellationStatus (2 variants, heavily used)
    await testVariant(
      client,
      join(meetdownDir, "src", "Event.elm"),
      "EventCancelled",
      "heavily used in migrations"
    );

    // Test 2: Event.elm - EventType variants (3 variants)
    await testVariant(
      client,
      join(meetdownDir, "src", "Event.elm"),
      "MeetOnline",
      "first variant of EventType"
    );

    await testVariant(
      client,
      join(meetdownDir, "src", "Event.elm"),
      "MeetInPerson",
      "middle variant of EventType"
    );

    // Test 3: Group.elm - GroupVisibility (2 variants)
    await testVariant(
      client,
      join(meetdownDir, "src", "Group.elm"),
      "UnlistedGroup",
      "first variant of GroupVisibility"
    );

    await testVariant(
      client,
      join(meetdownDir, "src", "Group.elm"),
      "PublicGroup",
      "second variant of GroupVisibility"
    );

    // Test 4: Group.elm - PastOngoingOrFuture (3 variants)
    await testVariant(
      client,
      join(meetdownDir, "src", "Group.elm"),
      "IsPastEvent",
      "variant of PastOngoingOrFuture"
    );

    // Test 5: Route.elm - Route type (many variants)
    await testVariant(
      client,
      join(meetdownDir, "src", "Route.elm"),
      "HomepageRoute",
      "route variant"
    );

    // Test 6: AdminStatus.elm
    await testVariant(
      client,
      join(meetdownDir, "src", "AdminStatus.elm"),
      "IsNotAdmin",
      "admin status variant"
    );

    // Test 7: Check an Evergreen type (historical)
    await testVariant(
      client,
      join(meetdownDir, "src", "Evergreen", "V74", "Event.elm"),
      "EventCancelled",
      "Evergreen historical type"
    );

    console.log("\n" + "=".repeat(70));
    console.log("  Tests complete!");
    console.log("=".repeat(70));
  } catch (error) {
    console.error("\nFATAL ERROR:", error);
  } finally {
    client.stop();
  }
}

main().catch(console.error);
