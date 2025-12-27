#!/usr/bin/env node
/**
 * Manual test: Rename field navigationKey -> navKey in Types.elm
 * Then verify compilation with lamdera make
 *
 * NOTE: This test requires an external Elm/Lamdera project.
 * Set the MEETDOWN environment variable to the path of your project.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_SERVER = join(__dirname, "../mcp-wrapper/index.mjs");
const MEETDOWN = process.env.MEETDOWN || join(__dirname, "meetdown");

async function main() {
  // Count navigationKey occurrences before
  const typesBefore = readFileSync(join(MEETDOWN, "src/Types.elm"), "utf-8");
  const frontendBefore = readFileSync(join(MEETDOWN, "src/Frontend.elm"), "utf-8");
  const countBefore = (typesBefore.match(/navigationKey/g) || []).length +
                      (frontendBefore.match(/navigationKey/g) || []).length;
  console.log(`navigationKey occurrences before: ${countBefore}`);

  // Start MCP client
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER],
    env: { ...process.env, ELM_LSP_LOG: "debug" },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" }, {});
  await client.connect(transport);

  // Rename field
  console.log("\nRenaming navigationKey -> navKey at Types.elm:43 (LoadingFrontend)...");
  const result = await client.callTool({
    name: "elm_rename_field",
    arguments: {
      file_path: join(MEETDOWN, "src/Types.elm"),
      line: 42,
      character: 6,
      newName: "navKey",
    },
  });
  console.log("Result:", result.content[0].text);

  // Count after
  const typesAfter = readFileSync(join(MEETDOWN, "src/Types.elm"), "utf-8");
  const frontendAfter = readFileSync(join(MEETDOWN, "src/Frontend.elm"), "utf-8");
  const navKeyCount = (typesAfter.match(/navKey/g) || []).length +
                      (frontendAfter.match(/navKey/g) || []).length;
  const navigationKeyRemaining = (typesAfter.match(/navigationKey/g) || []).length +
                                  (frontendAfter.match(/navigationKey/g) || []).length;
  console.log(`\nAfter rename: ${navKeyCount} navKey, ${navigationKeyRemaining} navigationKey remaining`);

  // Try to compile
  console.log("\nCompiling with lamdera make...");
  try {
    execSync("lamdera make src/Backend.elm src/Frontend.elm", {
      cwd: MEETDOWN,
      stdio: "inherit"
    });
    console.log("\n✓ COMPILATION SUCCEEDED!");
  } catch (e) {
    console.log("\n✗ COMPILATION FAILED!");
    process.exit(1);
  }

  await client.close();
}

main().catch(console.error);
