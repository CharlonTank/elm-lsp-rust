#!/usr/bin/env node
/**
 * Test move function via MCP wrapper
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER = join(__dirname, "index.mjs");

const TEST_DIR = "/tmp/elm-move-test";

async function main() {
  console.log("=".repeat(70));
  console.log("  Testing Move Function");
  console.log("=".repeat(70));

  // Save original files for restore
  const sourceOriginal = readFileSync(`${TEST_DIR}/src/Source.elm`, "utf-8");
  const targetOriginal = readFileSync(`${TEST_DIR}/src/Target.elm`, "utf-8");

  console.log("\n--- Original Source.elm ---");
  console.log(sourceOriginal);
  console.log("\n--- Original Target.elm ---");
  console.log(targetOriginal);

  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER],
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    console.log("\n1. Connecting to MCP server...");
    await client.connect(transport);
    console.log("   Connected!");

    console.log("\n2. Getting symbols from Source.elm...");
    const symbols = await client.callTool({
      name: "elm_symbols",
      arguments: { file_path: `${TEST_DIR}/src/Source.elm` },
    });
    console.log("   " + symbols.content?.[0]?.text?.slice(0, 200));

    console.log("\n3. Moving helperFunction to Target.elm...");
    // helperFunction should be around line 5 (0-indexed: 4)
    const result = await client.callTool({
      name: "elm_move_function",
      arguments: {
        file_path: `${TEST_DIR}/src/Source.elm`,
        line: 4, // Line where helperFunction is defined
        character: 0,
        target_module: `${TEST_DIR}/src/Target.elm`,
      },
    });
    console.log("   Result:", result.content?.[0]?.text);

    // Check the files after move
    console.log("\n--- Source.elm after move ---");
    const sourceAfter = readFileSync(`${TEST_DIR}/src/Source.elm`, "utf-8");
    console.log(sourceAfter);

    console.log("\n--- Target.elm after move ---");
    const targetAfter = readFileSync(`${TEST_DIR}/src/Target.elm`, "utf-8");
    console.log(targetAfter);

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.close();

    // Restore original files
    writeFileSync(`${TEST_DIR}/src/Source.elm`, sourceOriginal);
    writeFileSync(`${TEST_DIR}/src/Target.elm`, targetOriginal);
    console.log("\n(Test files restored to original state)");
  }

  console.log("\n" + "=".repeat(70));
}

main().catch(console.error);
