import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = dirname(__dirname);
const MEETDOWN = join(PROJECT_ROOT, "tests/meetdown");

const transport = new StdioClientTransport({ command: "node", args: [join(PROJECT_ROOT, "mcp-wrapper/index.mjs")] });
const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });

await client.connect(transport);

const result = await client.callTool({
  name: "elm_rename_variant",
  arguments: {
    file_path: join(MEETDOWN, "src/Types.elm"),
    line: 308,
    character: 6,
    newName: "ClickedLogin"
  }
});

console.log(result.content[0].text);
await client.close();
