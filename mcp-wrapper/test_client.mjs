#!/usr/bin/env node
/**
 * Test MCP wrapper using the SDK client
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_SERVER = join(__dirname, "index.mjs");

async function main() {
  console.log("=".repeat(60));
  console.log("  Testing MCP Wrapper with SDK Client");
  console.log("=".repeat(60));

  // Create the server process
  const serverProcess = spawn("node", [MCP_SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  serverProcess.stderr.on("data", (data) => {
    console.error("[server stderr]", data.toString());
  });

  // Create transport and client
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER],
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    console.log("\n1. Connecting to server...");
    await client.connect(transport);
    console.log("   Connected!");

    console.log("\n2. Listing tools...");
    const tools = await client.listTools();
    console.log(`   Found ${tools.tools.length} tools:`);
    for (const tool of tools.tools) {
      console.log(`   - ${tool.name}: ${tool.description?.slice(0, 50)}...`);
    }

    // Test elm_symbols
    console.log("\n3. Testing elm_symbols...");
    const testFile = process.env.HOME + "/projects/cleemo-lamdera/src/DomId.elm";
    const symbolsResult = await client.callTool({
      name: "elm_symbols",
      arguments: { file_path: testFile },
    });
    console.log("   Result:", symbolsResult.content?.[0]?.text?.slice(0, 200));

    // Test elm_references
    console.log("\n4. Testing elm_references...");
    const refsResult = await client.callTool({
      name: "elm_references",
      arguments: {
        file_path: testFile,
        line: 60,
        character: 0,
      },
    });
    console.log("   Result:", refsResult.content?.[0]?.text?.slice(0, 200));

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.close();
    serverProcess.kill();
  }

  console.log("\n" + "=".repeat(60));
}

main().catch(console.error);
