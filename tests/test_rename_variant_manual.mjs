import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["../mcp-wrapper/index.mjs"] });
const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });

await client.connect(transport);

const result = await client.callTool({
  name: "elm_rename_variant",
  arguments: {
    file_path: "/Users/charles-andreassus/projects/elm-claude-improvements/elm-lsp-rust/tests/meetdown/src/Types.elm",
    line: 308,
    character: 6,
    newName: "ClickedLogin"
  }
});

console.log(result.content[0].text);
await client.close();
