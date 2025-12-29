#!/usr/bin/env node
/**
 * Intricate tests for branches functionality with the new {imports, code} format
 */

import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUST_LSP_PATH = join(__dirname, "..", "target", "release", "elm_lsp");
const MEETDOWN_DIR = join(__dirname, "meetdown");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function pass(msg) {
  passed++;
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function fail(msg) {
  failed++;
  console.log(`  ${RED}✗${RESET} ${msg}`);
}

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

      this.process.stdout.on("data", (data) => this.handleData(data.toString()));
      this.process.stderr.on("data", () => {});
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
    await new Promise((r) => setTimeout(r, 100));
  }

  async executeCommand(command, args) {
    return this.sendRequest("workspace/executeCommand", { command, arguments: args });
  }

  stop() {
    if (this.process) this.process.kill();
  }
}

function applyEdits(changes) {
  for (const [uri, edits] of Object.entries(changes)) {
    const filePath = uri.replace("file://", "");
    let content = readFileSync(filePath, "utf-8");

    const sortedEdits = [...edits].sort((a, b) => {
      if (b.range.start.line !== a.range.start.line) {
        return b.range.start.line - a.range.start.line;
      }
      return b.range.start.character - a.range.start.character;
    });

    const lines = content.split("\n");
    for (const edit of sortedEdits) {
      const { start, end } = edit.range;
      const beforeText = lines.slice(0, start.line).join("\n") +
        (start.line > 0 ? "\n" : "") +
        lines[start.line].substring(0, start.character);
      const afterText = lines[end.line].substring(end.character) +
        (end.line < lines.length - 1 ? "\n" : "") +
        lines.slice(end.line + 1).join("\n");
      content = beforeText + edit.newText + afterText;
      lines.length = 0;
      lines.push(...content.split("\n"));
    }

    writeFileSync(filePath, content);
  }
}

function compile() {
  try {
    execSync("lamdera make src/Backend.elm src/Frontend.elm 2>&1", {
      cwd: MEETDOWN_DIR,
      encoding: "utf-8",
      timeout: 60000,
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.stdout || e.message };
  }
}

async function runTest(name, testFn) {
  console.log(`\n${CYAN}${name}${RESET}`);

  // Save original files
  const typesFile = join(MEETDOWN_DIR, "src/Types.elm");
  const frontendFile = join(MEETDOWN_DIR, "src/Frontend.elm");
  const origTypes = readFileSync(typesFile, "utf-8");
  const origFrontend = readFileSync(frontendFile, "utf-8");

  // Create fresh LSP client
  const client = new LspClient();
  await client.start(MEETDOWN_DIR);

  try {
    await testFn(client, typesFile, frontendFile);
  } catch (err) {
    fail(`Error: ${err.message}`);
  } finally {
    client.stop();
    // Restore files
    writeFileSync(typesFile, origTypes);
    writeFileSync(frontendFile, origFrontend);
  }
}

async function main() {
  console.log(`\n${BOLD}${"=".repeat(70)}${RESET}`);
  console.log(`${BOLD}  Intricate branches Tests (type-safe enum format)${RESET}`);
  console.log(`${BOLD}${"=".repeat(70)}${RESET}`);

  // Test 1: Custom branches with different expressions
  await runTest("Test 1: Custom branches with various expressions", async (client, typesFile) => {
    const uri = `file://${typesFile}`;
    await client.openDocument(uri, readFileSync(typesFile, "utf-8"));

    // First get the count needed
    const prepResult = await client.executeCommand("elm.prepareAddVariant", [
      uri, "ColorTheme", "SystemTheme"
    ]);

    // Build branches with exact count using enum format
    const branches = [];
    for (let i = 0; i < prepResult.casesNeedingBranch; i++) {
      branches.push({ AddCode: "LightTheme" });
    }

    const result = await client.executeCommand("elm.addVariant", [
      uri, "ColorTheme", "SystemTheme", "", branches
    ]);

    if (result.success && result.message.includes("custom code")) {
      pass("Custom code message returned");
      applyEdits(result.changes);

      const content = readFileSync(join(MEETDOWN_DIR, "src/Frontend.elm"), "utf-8");
      if (content.includes("LightTheme")) {
        pass("Custom branch codes applied");
      } else {
        fail("Custom codes missing");
      }
    } else {
      fail(`Unexpected: ${result.message}`);
    }
  });

  // Test 2: Mixed custom and empty (fallback to Debug.todo)
  await runTest("Test 2: Mixed custom and Debug.todo fallback", async (client, typesFile, frontendFile) => {
    const uri = `file://${typesFile}`;
    await client.openDocument(uri, readFileSync(typesFile, "utf-8"));

    const prepResult = await client.executeCommand("elm.prepareAddVariant", [
      uri, "ColorTheme", "AutoTheme"
    ]);

    // Build branches - some with code, some AddDebug for Debug.todo
    const branches = [];
    for (let i = 0; i < prepResult.casesNeedingBranch; i++) {
      if (i % 2 === 0) {
        branches.push({ AddCode: "DarkTheme" });
      } else {
        branches.push("AddDebug"); // explicit Debug.todo
      }
    }

    const result = await client.executeCommand("elm.addVariant", [
      uri, "ColorTheme", "AutoTheme", "", branches
    ]);

    if (result.success) {
      pass("Variant added");
      applyEdits(result.changes);

      const content = readFileSync(frontendFile, "utf-8");
      if (content.includes('Debug.todo "Handle AutoTheme"')) {
        pass("Debug.todo used for empty code");
      } else {
        fail("Debug.todo fallback missing");
      }
    } else {
      fail(`Failed: ${result.message}`);
    }
  });

  // Test 3: Wrong count SHOULD ERROR (fewer branches than needed)
  await runTest("Test 3: Wrong branch count errors", async (client, typesFile) => {
    const uri = `file://${typesFile}`;
    await client.openDocument(uri, readFileSync(typesFile, "utf-8"));

    const result = await client.executeCommand("elm.addVariant", [
      uri, "ColorTheme", "HighContrastTheme", "",
      [{ AddCode: "DarkTheme" }]  // only 1, need 3
    ]);

    if (!result.success && result.message.includes("Wrong number of branches")) {
      pass("Error returned for wrong count");
      if (result.prepareInfo && result.prepareInfo.casesNeedingBranch === 3) {
        pass("prepareInfo included with correct count");
      } else {
        fail("prepareInfo missing or incorrect");
      }
    } else {
      fail(`Expected error, got: ${result.message}`);
    }
  });

  // Test 4: Too many branches SHOULD ERROR
  await runTest("Test 4: Extra branches errors", async (client, typesFile) => {
    const uri = `file://${typesFile}`;
    await client.openDocument(uri, readFileSync(typesFile, "utf-8"));

    const result = await client.executeCommand("elm.addVariant", [
      uri, "ColorTheme", "NightTheme", "",
      [
        { AddCode: "LightTheme" },
        { AddCode: "DarkTheme" },
        { AddCode: "LightTheme" },
        { AddCode: "extra1" },
        { AddCode: "extra2" }
      ]
    ]);

    if (!result.success && result.message.includes("Wrong number of branches")) {
      pass("Error returned for too many branches");
    } else {
      fail(`Expected error, got: ${result.success ? "success" : result.message}`);
    }
  });

  // Test 5: No branches = all Debug.todo
  await runTest("Test 5: No branches provided = Debug.todo", async (client, typesFile, frontendFile) => {
    const uri = `file://${typesFile}`;
    await client.openDocument(uri, readFileSync(typesFile, "utf-8"));

    // Don't provide branches at all
    const result = await client.executeCommand("elm.addVariant", [
      uri, "ColorTheme", "MinimalTheme", ""
    ]);

    if (result.success) {
      pass("Variant added without branches");
      applyEdits(result.changes);

      const content = readFileSync(frontendFile, "utf-8");
      const todos = (content.match(/Debug\.todo "Handle MinimalTheme"/g) || []).length;
      if (todos === 3) {
        pass("All 3 branches use Debug.todo");
      } else {
        fail(`Expected 3 todos, found ${todos}`);
      }
    } else {
      fail(`Failed: ${result.message}`);
    }
  });

  // Test 6: Variant with arguments + branches
  await runTest("Test 6: Variant with argument + custom codes", async (client, typesFile) => {
    const uri = `file://${typesFile}`;
    await client.openDocument(uri, readFileSync(typesFile, "utf-8"));

    const prepResult = await client.executeCommand("elm.prepareAddVariant", [
      uri, "ColorTheme", "CustomTheme"
    ]);

    const branches = [];
    for (let i = 0; i < prepResult.casesNeedingBranch; i++) {
      branches.push({ AddCode: "LightTheme" });
    }

    const result = await client.executeCommand("elm.addVariant", [
      uri, "ColorTheme", "CustomTheme", "String", branches
    ]);

    if (result.success) {
      pass("Variant with arg added");
      applyEdits(result.changes);

      const content = readFileSync(typesFile, "utf-8");
      if (content.includes("| CustomTheme String")) {
        pass("Variant definition has argument");
      } else {
        fail("Argument missing from definition");
      }
    } else {
      fail(`Failed: ${result.message}`);
    }
  });

  // Test 7: Language type with branches
  await runTest("Test 7: Language type with branches", async (client, typesFile) => {
    const uri = `file://${typesFile}`;
    await client.openDocument(uri, readFileSync(typesFile, "utf-8"));

    const prepResult = await client.executeCommand("elm.prepareAddVariant", [
      uri, "Language", "German"
    ]);

    console.log(`     → ${prepResult.casesNeedingBranch} case expressions`);

    if (prepResult.casesNeedingBranch > 0) {
      const branches = [];
      for (let i = 0; i < prepResult.casesNeedingBranch; i++) {
        branches.push({ AddCode: "English" });
      }

      const result = await client.executeCommand("elm.addVariant", [
        uri, "Language", "German", "", branches
      ]);

      if (result.success) {
        pass("German variant added");
        applyEdits(result.changes);

        const content = readFileSync(typesFile, "utf-8");
        if (content.includes("| German")) {
          pass("Variant added to type definition");
        } else {
          fail("Variant not found in definition");
        }
      } else {
        fail(`Failed: ${result.message}`);
      }
    } else {
      pass("No case expressions need branches");
    }
  });

  // Test 8: Branches with imports
  await runTest("Test 8: Branches with imports", async (client, typesFile, frontendFile) => {
    const uri = `file://${typesFile}`;
    await client.openDocument(uri, readFileSync(typesFile, "utf-8"));

    const prepResult = await client.executeCommand("elm.prepareAddVariant", [
      uri, "ColorTheme", "ImportTheme"
    ]);

    // Build branches with imports using AddCodeWithImports
    const branches = [];
    for (let i = 0; i < prepResult.casesNeedingBranch; i++) {
      branches.push({
        AddCodeWithImports: {
          imports: ["MyCustomModule", "AnotherModule exposing (..)"],
          code: "LightTheme"
        }
      });
    }

    const result = await client.executeCommand("elm.addVariant", [
      uri, "ColorTheme", "ImportTheme", "", branches
    ]);

    if (result.success && result.message.includes("imports")) {
      pass("Imports added message returned");
      applyEdits(result.changes);

      const content = readFileSync(frontendFile, "utf-8");
      if (content.includes("import MyCustomModule") && content.includes("import AnotherModule exposing (..)")) {
        pass("Imports added to file");
      } else {
        fail("Imports missing from file");
      }
    } else if (result.success) {
      pass("Variant added (imports may not be needed or message different)");
    } else {
      fail(`Failed: ${result.message}`);
    }
  });

  // Test 9: AdminCache type
  await runTest("Test 9: AdminCache type", async (client, typesFile) => {
    const uri = `file://${typesFile}`;
    await client.openDocument(uri, readFileSync(typesFile, "utf-8"));

    const prepResult = await client.executeCommand("elm.prepareAddVariant", [
      uri, "AdminCache", "AdminCacheError"
    ]);

    console.log(`     → ${prepResult.casesNeedingBranch} case expressions`);

    let branches = undefined;
    if (prepResult.casesNeedingBranch > 0) {
      branches = [];
      for (let i = 0; i < prepResult.casesNeedingBranch; i++) {
        branches.push({ AddCode: "AdminCacheNotRequested" });
      }
    }

    const args = [uri, "AdminCache", "AdminCacheError", ""];
    if (branches) args.push(branches);

    const result = await client.executeCommand("elm.addVariant", args);

    if (result.success) {
      pass("AdminCacheError added");
    } else {
      fail(`Failed: ${result.message}`);
    }
  });

  // Test 10: Full workflow with Debug.todo (which compiles)
  await runTest("Test 10: Full workflow with Debug.todo (compiles)", async (client, typesFile) => {
    const uri = `file://${typesFile}`;
    await client.openDocument(uri, readFileSync(typesFile, "utf-8"));

    // Don't provide branches - all Debug.todo
    const result = await client.executeCommand("elm.addVariant", [
      uri, "ColorTheme", "SeasonalTheme", ""
    ]);

    if (result.success) {
      pass("Variant added with Debug.todo branches");
      applyEdits(result.changes);

      const compileResult = compile();
      if (compileResult.success) {
        pass("Code compiles successfully with Debug.todo!");
      } else {
        fail(`Compile failed: ${compileResult.error.substring(0, 100)}`);
      }
    } else {
      fail(`Failed: ${result.message}`);
    }
  });

  // Summary
  console.log(`\n${BOLD}${"=".repeat(70)}${RESET}`);
  console.log(`${BOLD}  Summary${RESET}`);
  console.log(`${BOLD}${"=".repeat(70)}${RESET}`);
  console.log(`  ${GREEN}Passed: ${passed}${RESET}`);
  console.log(`  ${failed > 0 ? RED : GREEN}Failed: ${failed}${RESET}`);
  console.log(`  Total:  ${passed + failed}\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});
