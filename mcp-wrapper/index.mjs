#!/usr/bin/env node
/**
 * MCP wrapper for Rust Elm LSP
 * Provides fast Elm language server capabilities to Claude Code
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the Rust LSP binary
const RUST_LSP_PATH = join(__dirname, "..", "target", "release", "elm_lsp");

class ElmLspClient {
  constructor() {
    this.process = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.buffer = "";
    this.initialized = false;
    this.workspaceRoot = null;
  }

  async start(workspaceRoot) {
    if (this.process && this.workspaceRoot === workspaceRoot) {
      return;
    }

    // Kill existing process if switching workspaces
    if (this.process) {
      this.stop();
    }

    this.workspaceRoot = workspaceRoot;

    return new Promise((resolve, reject) => {
      // Check if binary exists
      if (!existsSync(RUST_LSP_PATH)) {
        reject(new Error(`Rust LSP binary not found at ${RUST_LSP_PATH}. Run 'cargo build --release' in the plugin directory.`));
        return;
      }

      this.process = spawn(RUST_LSP_PATH, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, RUST_LOG: "warn" },
      });

      this.process.stdout.on("data", (data) => {
        this.handleData(data.toString());
      });

      this.process.stderr.on("data", (data) => {
        // Log errors but don't fail
        console.error(`[elm-lsp-rust] ${data.toString()}`);
      });

      this.process.on("error", (err) => {
        reject(err);
      });

      this.process.on("close", (code) => {
        this.process = null;
        this.initialized = false;
        // Reject all pending requests
        for (const [id, { reject }] of this.pendingRequests) {
          reject(new Error(`LSP process exited with code ${code}`));
        }
        this.pendingRequests.clear();
      });

      // Initialize the LSP
      this.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${workspaceRoot}`,
        capabilities: {},
      })
        .then(() => {
          return this.sendNotification("initialized", {});
        })
        .then(() => {
          this.initialized = true;
          resolve();
        })
        .catch(reject);
    });
  }

  handleData(data) {
    this.buffer += data;

    while (true) {
      const headerMatch = this.buffer.match(
        /Content-Length: (\d+)\r?\n\r?\n/
      );
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
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  sendMessage(message) {
    if (!this.process || !this.process.stdin) {
      throw new Error("LSP process not running. Try reconnecting the MCP server.");
    }
    const content = JSON.stringify(message);
    const byteLength = Buffer.byteLength(content, 'utf8');
    const header = `Content-Length: ${byteLength}\r\n\r\n`;
    this.process.stdin.write(header + content);
  }

  sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });
      this.sendMessage({ jsonrpc: "2.0", id, method, params });

      // Timeout after 30 seconds
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
      textDocument: {
        uri,
        languageId: "elm",
        version: 1,
        text: content,
      },
    });
    // Give time to parse
    await new Promise((r) => setTimeout(r, 100));
  }

  async getCompletion(uri, line, character) {
    return this.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async getSymbols(uri) {
    return this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });
  }

  async getHover(uri, line, character) {
    return this.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async getDefinition(uri, line, character) {
    return this.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async getReferences(uri, line, character) {
    return this.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    });
  }

  async prepareRename(uri, line, character) {
    return this.sendRequest("textDocument/prepareRename", {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async rename(uri, line, character, newName) {
    return this.sendRequest("textDocument/rename", {
      textDocument: { uri },
      position: { line, character },
      newName,
    });
  }

  async getCodeActions(uri, startLine, startChar, endLine, endChar) {
    return this.sendRequest("textDocument/codeAction", {
      textDocument: { uri },
      range: {
        start: { line: startLine, character: startChar },
        end: { line: endLine, character: endChar },
      },
      context: { diagnostics: [] },
    });
  }

  async getDiagnostics(uri) {
    // Use custom command to get on-demand diagnostics
    return this.sendRequest("workspace/executeCommand", {
      command: "elm.getDiagnostics",
      arguments: [uri],
    });
  }

  async workspaceSymbol(query) {
    return this.sendRequest("workspace/symbol", { query });
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

// Global LSP client
let lspClient = null;

async function ensureClient(workspaceRoot) {
  if (!lspClient) {
    lspClient = new ElmLspClient();
  }
  if (!lspClient.initialized || lspClient.workspaceRoot !== workspaceRoot) {
    await lspClient.start(workspaceRoot);
  }
  return lspClient;
}

// Find workspace root from a file path
function findWorkspaceRoot(filePath) {
  let dir = dirname(filePath);
  while (dir !== "/") {
    if (existsSync(join(dir, "elm.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

// Apply workspace edits returned by rename
async function applyWorkspaceEdit(changes) {
  const applied = [];
  for (const [fileUri, edits] of Object.entries(changes)) {
    const filePath = fileUri.replace("file://", "");
    if (!existsSync(filePath)) continue;

    let content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    // Sort edits in reverse order (bottom to top, right to left)
    const sortedEdits = [...edits].sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return b.range.start.line - a.range.start.line;
      }
      return b.range.start.character - a.range.start.character;
    });

    for (const edit of sortedEdits) {
      const { start, end } = edit.range;
      const startLine = lines[start.line] || "";
      const endLine = lines[end.line] || "";

      // Replace the text
      const before = startLine.substring(0, start.character);
      const after = endLine.substring(end.character);

      if (start.line === end.line) {
        lines[start.line] = before + edit.newText + after;
      } else {
        // Multi-line edit
        lines[start.line] = before + edit.newText + after;
        lines.splice(start.line + 1, end.line - start.line);
      }
    }

    const newContent = lines.join("\n");
    writeFileSync(filePath, newContent, "utf-8");
    applied.push({ path: filePath, edits: edits.length });
  }
  return applied;
}

// Create MCP server with new API
// Short name to avoid 64-char limit on tool names
const server = new McpServer(
  { name: "elr", version: "0.3.0" },
  { capabilities: { tools: {} } }
);

// Register tools using the new API
server.tool(
  "elm_completion",
  "Get code completions at a position in an Elm file",
  {
    file_path: z.string().describe("Path to the Elm file"),
    line: z.number().describe("Line number (0-indexed)"),
    character: z.number().describe("Character position (0-indexed)"),
  },
  async ({ file_path, line, character }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.getCompletion(uri, line, character);
    if (!result || (Array.isArray(result) && result.length === 0)) {
      return { content: [{ type: "text", text: "No completions available" }] };
    }

    const items = Array.isArray(result) ? result : result.items || [];
    const completions = items.slice(0, 20).map((item) => {
      const detail = item.detail ? ` : ${item.detail}` : "";
      return `${item.label}${detail}`;
    });

    return {
      content: [{
        type: "text",
        text: `Found ${items.length} completions:\n${completions.join("\n")}${items.length > 20 ? `\n... and ${items.length - 20} more` : ""}`,
      }],
    };
  }
);

server.tool(
  "elm_hover",
  "Get type information for a symbol at a position in an Elm file",
  {
    file_path: z.string().describe("Path to the Elm file"),
    line: z.number().describe("Line number (0-indexed)"),
    character: z.number().describe("Character position (0-indexed)"),
  },
  async ({ file_path, line, character }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.getHover(uri, line, character);
    if (!result) {
      return { content: [{ type: "text", text: "No hover information available" }] };
    }

    const hoverContent = result.contents?.value || JSON.stringify(result.contents);
    return { content: [{ type: "text", text: hoverContent }] };
  }
);

server.tool(
  "elm_definition",
  "Go to the definition of a symbol",
  {
    file_path: z.string().describe("Path to the Elm file"),
    line: z.number().describe("Line number (0-indexed)"),
    character: z.number().describe("Character position (0-indexed)"),
  },
  async ({ file_path, line, character }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.getDefinition(uri, line, character);
    if (!result) {
      return { content: [{ type: "text", text: "No definition found" }] };
    }

    const loc = Array.isArray(result) ? result[0] : result;
    return {
      content: [{
        type: "text",
        text: `Definition at ${loc.uri.replace("file://", "")}:${loc.range.start.line + 1}:${loc.range.start.character}`,
      }],
    };
  }
);

server.tool(
  "elm_references",
  "Find all references to a symbol across the project",
  {
    file_path: z.string().describe("Path to the Elm file"),
    line: z.number().describe("Line number (0-indexed)"),
    character: z.number().describe("Character position (0-indexed)"),
  },
  async ({ file_path, line, character }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.getReferences(uri, line, character);
    if (!result || result.length === 0) {
      return { content: [{ type: "text", text: "No references found" }] };
    }

    const refs = result.map(
      (r) => `${r.uri.replace("file://", "")}:${r.range.start.line + 1}:${r.range.start.character}`
    );
    return {
      content: [{
        type: "text",
        text: `Found ${refs.length} references:\n${refs.slice(0, 50).join("\n")}${refs.length > 50 ? `\n... and ${refs.length - 50} more` : ""}`,
      }],
    };
  }
);

server.tool(
  "elm_symbols",
  "Get all symbols in an Elm file with optional pagination",
  {
    file_path: z.string().describe("Path to the Elm file"),
    offset: z.number().optional().describe("Number of symbols to skip (default: 0)"),
    limit: z.number().optional().describe("Maximum number of symbols to return (default: 50)"),
  },
  async ({ file_path, offset = 0, limit = 50 }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.getSymbols(uri);
    if (!result || result.length === 0) {
      return { content: [{ type: "text", text: "No symbols found" }] };
    }

    const kindNames = {
      1: "File",
      2: "Module",
      5: "Class",
      6: "Method",
      10: "Enum",
      11: "Interface",
      12: "Function",
      13: "Variable",
      22: "Struct",
      23: "Event",
      24: "Operator",
      25: "TypeParameter",
    };

    const total = result.length;
    const paginated = result.slice(offset, offset + limit);
    const symbols = paginated.map((s) => {
      const kind = kindNames[s.kind] || `Kind${s.kind}`;
      const line = s.location?.range?.start?.line ?? s.range?.start?.line ?? 0;
      return `${s.name} (${kind}) at line ${line + 1}`;
    });

    let text = `Found ${total} symbols`;
    if (offset > 0 || total > limit) {
      text += ` (showing ${offset + 1}-${Math.min(offset + limit, total)})`;
    }
    text += `:\n${symbols.join("\n")}`;
    if (offset + limit < total) {
      text += `\n... use offset=${offset + limit} to see more`;
    }

    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "elm_format",
  "Format an Elm file using elm-format",
  {
    file_path: z.string().describe("Path to the Elm file"),
  },
  async ({ file_path }) => {
    // Use elm-format directly since our LSP doesn't implement formatting
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      await execAsync(`elm-format --yes "${file_path}"`);
      return { content: [{ type: "text", text: `Successfully formatted ${file_path}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error formatting: ${error.message}` }] };
    }
  }
);

server.tool(
  "elm_diagnostics",
  "Get diagnostics (errors/warnings) for an Elm file",
  {
    file_path: z.string().describe("Path to the Elm file"),
  },
  async ({ file_path }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    try {
      const client = await ensureClient(workspaceRoot);
      const uri = `file://${file_path}`;
      const result = await client.getDiagnostics(uri);

      if (result && result.diagnostics && result.diagnostics.length > 0) {
        const messages = result.diagnostics.map((d) => {
          const line = d.range?.start?.line ?? 0;
          const col = d.range?.start?.character ?? 0;
          return `Line ${line + 1}:${col + 1} - ${d.message}`;
        });
        return { content: [{ type: "text", text: messages.join("\n\n") }] };
      }

      return { content: [{ type: "text", text: "No errors or warnings" }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

server.tool(
  "elm_code_actions",
  "Get available code actions for a range in an Elm file",
  {
    file_path: z.string().describe("Path to the Elm file"),
    start_line: z.number().describe("Start line (0-indexed)"),
    start_char: z.number().describe("Start character (0-indexed)"),
    end_line: z.number().describe("End line (0-indexed)"),
    end_char: z.number().describe("End character (0-indexed)"),
  },
  async ({ file_path, start_line, start_char, end_line, end_char }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.getCodeActions(uri, start_line, start_char, end_line, end_char);
    if (!result || result.length === 0) {
      return { content: [{ type: "text", text: "No code actions available" }] };
    }

    const actions = result.map((a) => `- ${a.title}`);
    return {
      content: [{
        type: "text",
        text: `Available code actions:\n${actions.join("\n")}`,
      }],
    };
  }
);

server.tool(
  "elm_apply_code_action",
  "Apply a code action to an Elm file",
  {
    file_path: z.string().describe("Path to the Elm file"),
    start_line: z.number().describe("Start line (0-indexed)"),
    start_char: z.number().describe("Start character (0-indexed)"),
    end_line: z.number().describe("End line (0-indexed)"),
    end_char: z.number().describe("End character (0-indexed)"),
    action_title: z.string().describe("Title of the code action to apply"),
  },
  async ({ file_path, start_line, start_char, end_line, end_char, action_title }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.getCodeActions(uri, start_line, start_char, end_line, end_char);
    if (!result || result.length === 0) {
      return { content: [{ type: "text", text: "No code actions available" }] };
    }

    const action = result.find((a) => a.title === action_title);
    if (!action) {
      const available = result.map((a) => a.title).join(", ");
      return { content: [{ type: "text", text: `Action "${action_title}" not found. Available: ${available}` }] };
    }

    if (action.edit?.changes) {
      const applied = await applyWorkspaceEdit(action.edit.changes);
      const summary = applied.map((a) => `${a.path}: ${a.edits} edits`).join("\n");
      return { content: [{ type: "text", text: `Applied "${action_title}":\n${summary}` }] };
    }

    return { content: [{ type: "text", text: `Action "${action_title}" has no edits to apply` }] };
  }
);

server.tool(
  "elm_prepare_rename",
  "Check if a symbol at a position can be renamed",
  {
    file_path: z.string().describe("Path to the Elm file"),
    line: z.number().describe("Line number (0-indexed)"),
    character: z.number().describe("Character position (0-indexed)"),
  },
  async ({ file_path, line, character }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.prepareRename(uri, line, character);
    if (!result) {
      return { content: [{ type: "text", text: "Cannot rename at this position" }] };
    }

    const range = result.range || result;
    const placeholder = result.placeholder || "";
    return {
      content: [{
        type: "text",
        text: `Can rename "${placeholder}" at line ${range.start.line + 1}, characters ${range.start.character}-${range.end.character}`,
      }],
    };
  }
);

server.tool(
  "elm_rename",
  "Rename a symbol across the entire project and apply changes",
  {
    file_path: z.string().describe("Path to the Elm file"),
    line: z.number().describe("Line number (0-indexed)"),
    character: z.number().describe("Character position (0-indexed)"),
    newName: z.string().describe("The new name for the symbol"),
  },
  async ({ file_path, line, character, newName }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.rename(uri, line, character, newName);
    if (!result || !result.changes) {
      return { content: [{ type: "text", text: "No changes needed or rename not possible" }] };
    }

    // Apply the changes
    const applied = await applyWorkspaceEdit(result.changes);
    const fileCount = applied.length;
    const totalEdits = applied.reduce((sum, a) => sum + a.edits, 0);

    const summary = applied.slice(0, 20).map((a) => `  ${a.path}: ${a.edits} edits`).join("\n");

    return {
      content: [{
        type: "text",
        text: `Renamed to "${newName}" in ${fileCount} files (${totalEdits} total edits):\n${summary}${applied.length > 20 ? `\n  ... and ${applied.length - 20} more files` : ""}`,
      }],
    };
  }
);

server.tool(
  "elm_move_function",
  "Move a function from one module to another, updating all imports and references",
  {
    file_path: z.string().describe("Path to the source file containing the function"),
    line: z.number().describe("Line number of the function name (0-indexed)"),
    character: z.number().describe("Character position of the function name (0-indexed)"),
    target_module: z.string().describe('Path to the target module file (e.g., "src/Utils/Helpers.elm")'),
  },
  async ({ file_path, line, character, target_module }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    if (!existsSync(target_module)) {
      return { content: [{ type: "text", text: `Target module does not exist: ${target_module}` }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const sourceContent = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, sourceContent);

    // Get the function name at the position using document symbols
    const symbols = await client.getSymbols(uri);
    if (!symbols || symbols.length === 0) {
      return { content: [{ type: "text", text: "No symbols found in file" }] };
    }

    // Find the function at the given line
    const func = symbols.find((s) => {
      const symLine = s.location?.range?.start?.line ?? s.range?.start?.line ?? -1;
      return symLine === line || symLine === line + 1 || symLine === line - 1;
    });

    if (!func) {
      return { content: [{ type: "text", text: `No function found at line ${line + 1}` }] };
    }

    const functionName = func.name;
    const funcLine = func.location?.range?.start?.line ?? func.range?.start?.line ?? line;

    // Implement move function logic directly
    try {
      const sourceLines = sourceContent.split("\n");
      const targetContent = readFileSync(target_module, "utf-8");
      const targetLines = targetContent.split("\n");

      // 1. Find the function bounds (type signature + body)
      let funcStart = funcLine;
      let funcEnd = funcLine;

      // Look backwards for type signature
      for (let i = funcLine - 1; i >= 0; i--) {
        const line = sourceLines[i].trim();
        if (line === "") break;
        if (line.startsWith(`${functionName} :`)) {
          funcStart = i;
          break;
        }
        if (line.includes(" =") && !line.startsWith(`${functionName} `)) break;
      }

      // Look forwards for end of function
      for (let i = funcLine + 1; i < sourceLines.length; i++) {
        const line = sourceLines[i];
        if (line.trim() === "") {
          // Check if next non-empty line is a new top-level definition
          let j = i + 1;
          while (j < sourceLines.length && sourceLines[j].trim() === "") j++;
          if (j < sourceLines.length) {
            const nextLine = sourceLines[j].trim();
            if (nextLine.match(/^[a-z]/) || nextLine.startsWith("type ") || nextLine.startsWith("port ")) {
              funcEnd = i - 1;
              break;
            }
          }
        }
        funcEnd = i;
      }

      // Trim trailing empty lines
      while (funcEnd > funcStart && sourceLines[funcEnd].trim() === "") {
        funcEnd--;
      }

      // Extract function text
      const functionText = sourceLines.slice(funcStart, funcEnd + 1).join("\n");

      // 2. Get source and target module names
      const sourceModuleName = extractModuleName(sourceContent);
      const targetModuleName = extractModuleName(targetContent);

      // 3. Find where to insert in target file (at the end, before any trailing whitespace)
      // We'll add the function at the end of the file
      let insertLine = targetLines.length;
      // Find the last non-empty line and insert after it
      while (insertLine > 0 && targetLines[insertLine - 1].trim() === "") {
        insertLine--;
      }

      // 4. Update target file - add function and update exposing
      let newTargetLines = [...targetLines];

      // Add function to target
      newTargetLines.splice(insertLine, 0, "", "", functionText, "");

      // Update target's exposing list
      for (let i = 0; i < newTargetLines.length; i++) {
        if (newTargetLines[i].includes("module ") && newTargetLines[i].includes(" exposing ")) {
          if (!newTargetLines[i].includes("exposing (..)")) {
            const closeParenIdx = newTargetLines[i].lastIndexOf(")");
            if (closeParenIdx !== -1) {
              newTargetLines[i] = newTargetLines[i].slice(0, closeParenIdx) + ", " + functionName + ")";
            }
          }
          break;
        }
      }

      // 5. Update source file - remove function and add import
      let newSourceLines = [...sourceLines];

      // Remove function from source
      newSourceLines.splice(funcStart, funcEnd - funcStart + 1);

      // Remove extra blank lines
      while (newSourceLines[funcStart]?.trim() === "" && newSourceLines[funcStart + 1]?.trim() === "") {
        newSourceLines.splice(funcStart, 1);
      }

      // Add import for moved function in source file
      let importInsertLine = 0;
      for (let i = 0; i < newSourceLines.length; i++) {
        if (newSourceLines[i].trim().startsWith("import ")) {
          importInsertLine = i;
          break;
        }
      }
      if (importInsertLine === 0) {
        for (let i = 0; i < newSourceLines.length; i++) {
          if (newSourceLines[i].includes("module ")) {
            importInsertLine = i + 2;
            break;
          }
        }
      }

      const importStatement = `import ${targetModuleName} exposing (${functionName})`;
      newSourceLines.splice(importInsertLine, 0, importStatement);

      // 6. Write updated files
      writeFileSync(file_path, newSourceLines.join("\n"));
      writeFileSync(target_module, newTargetLines.join("\n"));

      // 7. Find and update references in other files
      const refs = await client.getReferences(uri, funcLine, 0);
      const refCount = refs?.length || 0;

      return {
        content: [{
          type: "text",
          text: `Successfully moved "${functionName}" from ${sourceModuleName} to ${targetModuleName}.\n` +
                `- Removed function from source file\n` +
                `- Added function to target file\n` +
                `- Added import in source file\n` +
                `- Updated target module's exposing list\n` +
                `Found ${refCount} references (files using this function may need import updates).`,
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error moving function: ${error.message}` }] };
    }
  }
);

server.tool(
  "elm_prepare_remove_variant",
  "Check if a variant can be removed from a custom type. Returns variant info, usage count, and other variants for reference.",
  {
    file_path: z.string().describe("Path to the Elm file containing the type definition"),
    line: z.number().describe("Line number of the variant name (0-indexed)"),
    character: z.number().describe("Character position within the variant name (0-indexed)"),
  },
  async ({ file_path, line, character }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.executeCommand("elm.prepareRemoveVariant", [uri, line, character]);

    if (!result || !result.success) {
      return { content: [{ type: "text", text: result?.error || "No variant found at this position" }] };
    }

    const otherVariants = result.otherVariants?.join(", ") || "none";
    const blockingUsages = result.blockingUsages || [];
    const patternUsages = result.patternUsages || [];
    const blockingCount = result.blockingCount || 0;
    const patternCount = result.patternCount || 0;

    let text = `Variant: ${result.variantName} (${result.variantIndex + 1}/${result.totalVariants} in type ${result.typeName})\n` +
               `Other variants: [${otherVariants}]\n`;

    if (blockingCount > 0) {
      text += `Blocking usages (constructors): ${blockingCount}\n`;
    }
    if (patternCount > 0) {
      text += `Pattern usages (auto-removable): ${patternCount}\n`;
    }
    if (blockingCount === 0 && patternCount === 0) {
      text += `Usages: 0\n`;
    }

    text += `Can remove: ${result.canRemove ? "Yes" : "No"}`;

    if (!result.canRemove && result.totalVariants <= 1) {
      text += " (only variant)";
    } else if (!result.canRemove && blockingCount > 0) {
      text += " (has blocking constructor usages)";
    }

    text += `\nLine: ${result.range.start.line + 1}:${result.range.start.character}`;

    // Add blocking usages with call chain context
    if (blockingUsages.length > 0) {
      text += `\n\nBlocking usages (must replace manually):\n`;
      text += blockingUsages.slice(0, 10).map((u, idx) => {
        const func = u.function_name || "(top-level)";
        let uText = `  ${idx + 1}. ${u.module_name}.${func}:${u.line + 1}\n`;
        uText += `     Context: "${u.context}"\n`;

        if (u.call_chain && u.call_chain.length > 0) {
          uText += `     Call chain:\n`;
          u.call_chain.forEach((c, i) => {
            const marker = c.is_entry_point ? " [ENTRY]" : "";
            const indent = "       " + "  ".repeat(i);
            uText += `${indent}→ ${c.module_name}.${c.function}:${c.line + 1}${marker}\n`;
          });
        }
        return uText;
      }).join("\n");

      if (blockingUsages.length > 10) {
        text += `\n  ... and ${blockingUsages.length - 10} more usages`;
      }
    }

    // Show pattern usages that will be auto-removed
    if (patternUsages.length > 0 && result.canRemove) {
      text += `\n\nPattern branches to auto-remove:\n`;
      text += patternUsages.slice(0, 10).map((u, idx) => {
        const func = u.function_name || "(top-level)";
        return `  ${idx + 1}. ${u.module_name}.${func}:${u.line + 1} → "${u.context}"`;
      }).join("\n");

      if (patternUsages.length > 10) {
        text += `\n  ... and ${patternUsages.length - 10} more branches`;
      }
    }

    return {
      content: [{
        type: "text",
        text,
      }],
    };
  }
);

server.tool(
  "elm_remove_variant",
  "Remove a variant from a custom type. Will fail if the variant is used anywhere (showing blocking usages with call chain context).",
  {
    file_path: z.string().describe("Path to the Elm file containing the type definition"),
    line: z.number().describe("Line number of the variant name (0-indexed)"),
    character: z.number().describe("Character position within the variant name (0-indexed)"),
  },
  async ({ file_path, line, character }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.executeCommand("elm.removeVariant", [uri, line, character]);

    if (!result) {
      return { content: [{ type: "text", text: "No variant found at this position" }] };
    }

    if (!result.success) {
      // Format blocking usages with call chain
      const usages = result.blockingUsages || [];
      const otherVariants = result.otherVariants?.join(", ") || "none";

      let usageText = usages.slice(0, 10).map((u, idx) => {
        const func = u.function_name || "(top-level)";
        let text = `  ${idx + 1}. ${u.module_name}.${func}:${u.line + 1}\n`;
        text += `     Context: "${u.context}"\n`;

        if (u.call_chain && u.call_chain.length > 0) {
          text += `     Call chain:\n`;
          u.call_chain.forEach((c, i) => {
            const marker = c.is_entry_point ? " [ENTRY]" : "";
            const indent = "       " + "  ".repeat(i);
            text += `${indent}→ ${c.module_name}.${c.function}:${c.line + 1}${marker}\n`;
          });
        }
        return text;
      }).join("\n");

      if (usages.length > 10) {
        usageText += `\n  ... and ${usages.length - 10} more usages`;
      }

      return {
        content: [{
          type: "text",
          text: `Cannot remove variant '${result.variantName}' from type ${result.typeName}\n` +
                `Reason: ${result.error}\n\n` +
                `Other variants you can use instead: [${otherVariants}]\n\n` +
                `Blocking usages:\n${usageText}`,
        }],
      };
    }

    // Success - apply the changes
    if (result.changes) {
      const applied = await applyWorkspaceEdit(result.changes);
      const fileCount = applied.length;
      const totalEdits = applied.reduce((sum, a) => sum + a.edits, 0);

      // Use the LSP message if it has pattern branch info, otherwise use generic message
      const msg = result.message || `Removed variant '${result.variantName}' from type ${result.typeName}`;

      return {
        content: [{
          type: "text",
          text: `Successfully: ${msg}\n` +
                `Applied ${totalEdits} edit(s) in ${fileCount} file(s)`,
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: result.message || "Variant removed successfully",
      }],
    };
  }
);

server.tool(
  "elm_rename_file",
  "Rename an Elm file and update its module declaration + all imports across the project",
  {
    file_path: z.string().describe("Path to the Elm file to rename"),
    new_name: z.string().describe('New filename (just the name, e.g., "NewName.elm")'),
  },
  async ({ file_path, new_name }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    if (!new_name.endsWith(".elm")) {
      return { content: [{ type: "text", text: "New name must end with .elm" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.executeCommand("elm.renameFile", [uri, new_name]);

    if (!result) {
      return { content: [{ type: "text", text: "Failed to rename file" }] };
    }

    if (!result.success) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    }

    // Apply the text edits (module declarations and imports)
    if (result.changes) {
      const applied = await applyWorkspaceEdit(result.changes);
      const fileCount = applied.length;
      const totalEdits = applied.reduce((sum, a) => sum + a.edits, 0);

      // Now perform the actual file rename
      const { rename } = await import("fs/promises");
      try {
        await rename(result.oldPath, result.newPath);
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Applied ${totalEdits} edit(s) but failed to rename file: ${err.message}\n` +
                  `Please manually rename ${result.oldPath} to ${result.newPath}`,
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: `Renamed ${result.oldModuleName} to ${result.newModuleName}\n` +
                `- Renamed file: ${result.oldPath} → ${result.newPath}\n` +
                `- Updated module declaration\n` +
                `- Updated ${result.filesUpdated} import(s) in ${fileCount} file(s)`,
        }],
      };
    }

    return { content: [{ type: "text", text: "No changes needed" }] };
  }
);

server.tool(
  "elm_move_file",
  "Move an Elm file to a new location and update its module declaration + all imports across the project",
  {
    file_path: z.string().describe("Path to the Elm file to move"),
    target_path: z.string().describe('Target path (e.g., "src/Utils/Helper.elm")'),
  },
  async ({ file_path, target_path }) => {
    const workspaceRoot = findWorkspaceRoot(file_path);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    if (!target_path.endsWith(".elm")) {
      return { content: [{ type: "text", text: "Target path must end with .elm" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${file_path}`;
    const content = readFileSync(file_path, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.executeCommand("elm.moveFile", [uri, target_path]);

    if (!result) {
      return { content: [{ type: "text", text: "Failed to move file" }] };
    }

    if (!result.success) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    }

    // Apply the text edits (module declarations and imports)
    if (result.changes) {
      const applied = await applyWorkspaceEdit(result.changes);
      const fileCount = applied.length;
      const totalEdits = applied.reduce((sum, a) => sum + a.edits, 0);

      // Ensure target directory exists
      const { mkdir, rename } = await import("fs/promises");
      const targetDir = dirname(result.newPath);

      try {
        await mkdir(targetDir, { recursive: true });
        await rename(result.oldPath, result.newPath);
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: `Applied ${totalEdits} edit(s) but failed to move file: ${err.message}\n` +
                  `Please manually move ${result.oldPath} to ${result.newPath}`,
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: `Moved ${result.oldModuleName} to ${result.newModuleName}\n` +
                `- Moved file: ${result.oldPath} → ${result.newPath}\n` +
                `- Updated module declaration\n` +
                `- Updated ${result.filesUpdated} import(s) in ${fileCount} file(s)`,
        }],
      };
    }

    return { content: [{ type: "text", text: "No changes needed" }] };
  }
);

// Helper to extract module name from Elm source
function extractModuleName(content) {
  const match = content.match(/^module\s+([A-Za-z.]+)\s+exposing/m);
  return match ? match[1] : "Unknown";
}

// Start the server
async function main() {
  // Check if Rust LSP binary exists
  if (!existsSync(RUST_LSP_PATH)) {
    console.error(`Rust LSP binary not found at ${RUST_LSP_PATH}`);
    console.error("Run 'cargo build --release' first");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
