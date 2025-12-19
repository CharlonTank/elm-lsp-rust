#!/usr/bin/env node
/**
 * Full test of MCP wrapper with all tools
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER = join(__dirname, "index.mjs");

async function main() {
  console.log("=".repeat(70));
  console.log("  Full MCP Wrapper Test Suite");
  console.log("=".repeat(70));

  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER],
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  const testFile = process.env.HOME + "/projects/cleemo-lamdera/src/DomId.elm";

  // Read the file to find proper positions for testing
  const content = readFileSync(testFile, "utf-8");
  const lines = content.split("\n");

  // Find 'landingNavFeatures' definition (a function that exists in DomId.elm)
  let targetLine = 29; // landingNavFeatures is at line 30 (0-indexed: 29)
  let targetChar = 0;
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf("landingNavFeatures");
    if (idx !== -1 && lines[i].trim().startsWith("landingNavFeatures")) {
      targetLine = i;
      targetChar = idx;
      break;
    }
  }

  console.log(`\nUsing test file: ${testFile}`);
  console.log(`Found 'landingNavFeatures' at line ${targetLine + 1}, char ${targetChar}`);

  try {
    console.log("\n1. Connecting...");
    await client.connect(transport);
    console.log("   OK");

    console.log("\n2. elm_hover - Get type of 'landingNavFeatures'...");
    const hover = await client.callTool({
      name: "elm_hover",
      arguments: {
        file_path: testFile,
        line: targetLine,
        character: targetChar,
      },
    });
    console.log("   " + (hover.content?.[0]?.text || "No result"));

    console.log("\n3. elm_definition - Go to definition...");
    const def = await client.callTool({
      name: "elm_definition",
      arguments: {
        file_path: testFile,
        line: targetLine,
        character: targetChar,
      },
    });
    console.log("   " + (def.content?.[0]?.text || "No result"));

    console.log("\n4. elm_references - Find all references to 'landingNavFeatures'...");
    const refs = await client.callTool({
      name: "elm_references",
      arguments: {
        file_path: testFile,
        line: targetLine,
        character: targetChar,
      },
    });
    const refsText = refs.content?.[0]?.text || "No result";
    console.log("   " + refsText.split("\n").slice(0, 5).join("\n   "));
    if (refsText.split("\n").length > 5) {
      console.log("   ...");
    }

    console.log("\n5. elm_prepare_rename - Check if can rename 'landingNavFeatures'...");
    const prepRename = await client.callTool({
      name: "elm_prepare_rename",
      arguments: {
        file_path: testFile,
        line: targetLine,
        character: targetChar,
      },
    });
    console.log("   " + (prepRename.content?.[0]?.text || "No result"));

    console.log("\n6. elm_completion - Get completions at position...");
    // Find a line with "DomId." to test completions
    let completionLine = 0;
    let completionChar = 0;
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].indexOf("DomId.");
      if (idx !== -1) {
        completionLine = i;
        completionChar = idx + 6; // After "DomId."
        break;
      }
    }
    const completion = await client.callTool({
      name: "elm_completion",
      arguments: {
        file_path: testFile,
        line: completionLine,
        character: completionChar,
      },
    });
    const compText = completion.content?.[0]?.text || "No result";
    console.log("   " + compText.split("\n").slice(0, 5).join("\n   "));

    console.log("\n7. elm_symbols - First 10 symbols...");
    const symbols = await client.callTool({
      name: "elm_symbols",
      arguments: {
        file_path: testFile,
        limit: 10,
      },
    });
    console.log("   " + (symbols.content?.[0]?.text?.replace(/\n/g, "\n   ") || "No result"));

    console.log("\n8. elm_code_actions - Get available actions...");
    const actions = await client.callTool({
      name: "elm_code_actions",
      arguments: {
        file_path: testFile,
        start_line: targetLine,
        start_char: targetChar,
        end_line: targetLine,
        end_char: targetChar + 10,
      },
    });
    console.log("   " + (actions.content?.[0]?.text || "No result"));

    console.log("\n" + "=".repeat(70));
    console.log("  All tests completed!");
    console.log("=".repeat(70));

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
