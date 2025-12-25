#!/usr/bin/env node
/**
 * MCP wrapper for Rust Elm LSP
 * Provides fast Elm language server capabilities to Claude Code
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
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

  async notifyFileChanged(uri, content) {
    // Increment version for tracking changes
    this.documentVersions = this.documentVersions || {};
    this.documentVersions[uri] = (this.documentVersions[uri] || 1) + 1;

    await this.sendNotification("textDocument/didChange", {
      textDocument: {
        uri,
        version: this.documentVersions[uri],
      },
      contentChanges: [{ text: content }],
    });
    // Give time to re-index
    await new Promise((r) => setTimeout(r, 50));
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

// Resolve relative paths to absolute paths
function resolveFilePath(filePath) {
  return resolve(filePath);
}

// Find workspace root from a file path
function findWorkspaceRoot(filePath) {
  // Ensure we have an absolute path
  const absPath = resolveFilePath(filePath);
  let dir = dirname(absPath);
  while (dir !== "/") {
    if (existsSync(join(dir, "elm.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

// Apply workspace edits returned by rename
async function applyWorkspaceEdit(changes, client = null) {
  const applied = [];
  const changedFiles = [];

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
    changedFiles.push({ uri: fileUri, content: newContent });
  }

  // Notify LSP server about file changes so it can update its index
  if (client) {
    for (const { uri, content } of changedFiles) {
      await client.notifyFileChanged(uri, content);
    }
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
  "elm_definition",
  "Go to the definition of a symbol",
  {
    file_path: z.string().describe("Path to the Elm file"),
    line: z.number().describe("Line number (0-indexed)"),
    character: z.number().describe("Character position (0-indexed)"),
  },
  async ({ file_path, line, character }) => {
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
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
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
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
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
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
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    try {
      const client = await ensureClient(workspaceRoot);
      const uri = `file://${absPath}`;
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
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
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
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
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
      const applied = await applyWorkspaceEdit(action.edit.changes, client);
      const summary = applied.map((a) => `${a.path}: ${a.edits} edits`).join("\n");
      return { content: [{ type: "text", text: `Applied "${action_title}":\n${summary}` }] };
    }

    return { content: [{ type: "text", text: `Action "${action_title}" has no edits to apply` }] };
  }
);

server.tool(
  "elm_rename_variant",
  "Rename a custom type variant (constructor) across the entire project. Fails if position is not on a variant.",
  {
    file_path: z.string().describe("Path to the Elm file containing the type definition"),
    line: z.number().describe("Line number of the variant name (0-indexed)"),
    character: z.number().describe("Character position within the variant name (0-indexed)"),
    old_name: z.string().describe("Expected current variant name (must match what's at the position)"),
    newName: z.string().describe("The new name for the variant"),
  },
  async ({ file_path, line, character, old_name, newName }) => {
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.executeCommand("elm.renameVariant", [uri, line, character, newName]);

    if (!result) {
      return { content: [{ type: "text", text: `No variant found at line ${line + 1}. Expected: ${old_name}` }] };
    }

    // Safety check: verify the variant at this position matches expected name
    if (result.oldName !== old_name) {
      return {
        content: [{
          type: "text",
          text: `Safety check failed: Expected variant '${old_name}' but found '${result.oldName}' at line ${line + 1}.\n` +
                `The line number may have shifted. Please verify the correct line for '${old_name}'.`,
        }],
      };
    }

    if (!result.success) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    }

    // Apply the changes
    if (result.changes) {
      const applied = await applyWorkspaceEdit(result.changes, client);
      const fileCount = applied.length;
      const totalEdits = applied.reduce((sum, a) => sum + a.edits, 0);

      const summary = applied.slice(0, 20).map((a) => `  ${a.path}: ${a.edits} edits`).join("\n");

      return {
        content: [{
          type: "text",
          text: `Renamed variant "${result.oldName}" to "${result.newName}" in type ${result.typeName}\n` +
                `Applied ${totalEdits} edit(s) in ${fileCount} file(s):\n${summary}`,
        }],
      };
    }

    return { content: [{ type: "text", text: result.message || "Variant renamed successfully" }] };
  }
);

server.tool(
  "elm_rename_type",
  "Rename a type (custom type or type alias) across the entire project. Fails if position is not on a type definition.",
  {
    file_path: z.string().describe("Path to the Elm file containing the type definition"),
    line: z.number().describe("Line number of the type name (0-indexed)"),
    character: z.number().describe("Character position within the type name (0-indexed)"),
    old_name: z.string().describe("Expected current type name (must match what's at the position)"),
    newName: z.string().describe("The new name for the type"),
  },
  async ({ file_path, line, character, old_name, newName }) => {
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.executeCommand("elm.renameType", [uri, line, character, newName]);

    if (!result) {
      return { content: [{ type: "text", text: `No type found at line ${line + 1}. Expected: ${old_name}` }] };
    }

    // Safety check: verify the type at this position matches expected name
    if (result.oldName !== old_name) {
      return {
        content: [{
          type: "text",
          text: `Safety check failed: Expected type '${old_name}' but found '${result.oldName}' at line ${line + 1}.\n` +
                `The line number may have shifted. Please verify the correct line for '${old_name}'.`,
        }],
      };
    }

    if (!result.success) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    }

    // Apply the changes
    if (result.changes) {
      const applied = await applyWorkspaceEdit(result.changes, client);
      const fileCount = applied.length;
      const totalEdits = applied.reduce((sum, a) => sum + a.edits, 0);

      const summary = applied.slice(0, 20).map((a) => `  ${a.path}: ${a.edits} edits`).join("\n");

      return {
        content: [{
          type: "text",
          text: `Renamed type "${result.oldName}" to "${result.newName}"\n` +
                `Applied ${totalEdits} edit(s) in ${fileCount} file(s):\n${summary}`,
        }],
      };
    }

    return { content: [{ type: "text", text: result.message || "Type renamed successfully" }] };
  }
);

server.tool(
  "elm_rename_function",
  "Rename a function across the entire project. Fails if position is not on a function definition.",
  {
    file_path: z.string().describe("Path to the Elm file containing the function"),
    line: z.number().describe("Line number of the function name (0-indexed)"),
    character: z.number().describe("Character position within the function name (0-indexed)"),
    old_name: z.string().describe("Expected current function name (must match what's at the position)"),
    newName: z.string().describe("The new name for the function"),
  },
  async ({ file_path, line, character, old_name, newName }) => {
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.executeCommand("elm.renameFunction", [uri, line, character, newName]);

    if (!result) {
      return { content: [{ type: "text", text: `No function found at line ${line + 1}. Expected: ${old_name}` }] };
    }

    // Safety check: verify the function at this position matches expected name
    if (result.oldName !== old_name) {
      return {
        content: [{
          type: "text",
          text: `Safety check failed: Expected function '${old_name}' but found '${result.oldName}' at line ${line + 1}.\n` +
                `The line number may have shifted. Please verify the correct line for '${old_name}'.`,
        }],
      };
    }

    if (!result.success) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    }

    // Apply the changes
    if (result.changes) {
      const applied = await applyWorkspaceEdit(result.changes, client);
      const fileCount = applied.length;
      const totalEdits = applied.reduce((sum, a) => sum + a.edits, 0);

      const summary = applied.slice(0, 20).map((a) => `  ${a.path}: ${a.edits} edits`).join("\n");

      return {
        content: [{
          type: "text",
          text: `Renamed function "${result.oldName}" to "${result.newName}"\n` +
                `Applied ${totalEdits} edit(s) in ${fileCount} file(s):\n${summary}`,
        }],
      };
    }

    return { content: [{ type: "text", text: result.message || "Function renamed successfully" }] };
  }
);

server.tool(
  "elm_rename_field",
  "Rename a record field across the entire project (type-aware). Fails if position is not on a field.",
  {
    file_path: z.string().describe("Path to the Elm file"),
    line: z.number().describe("Line number of the field (0-indexed)"),
    character: z.number().describe("Character position within the field name (0-indexed)"),
    old_name: z.string().describe("Expected current field name (must match what's at the position)"),
    newName: z.string().describe("The new name for the field"),
  },
  async ({ file_path, line, character, old_name, newName }) => {
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
    await client.openDocument(uri, content);

    // First check what's at the position using prepareRename
    const prepareResult = await client.prepareRename(uri, line, character);
    if (!prepareResult) {
      return { content: [{ type: "text", text: `No field found at line ${line + 1}. Expected: ${old_name}` }] };
    }

    // Safety check: verify the field at this position matches expected name
    const actualName = prepareResult.placeholder || "";
    if (actualName !== old_name) {
      return {
        content: [{
          type: "text",
          text: `Safety check failed: Expected field '${old_name}' but found '${actualName}' at line ${line + 1}.\n` +
                `The line number may have shifted. Please verify the correct line for '${old_name}'.`,
        }],
      };
    }

    // Use the standard rename - it detects fields automatically
    const result = await client.rename(uri, line, character, newName);
    if (!result || !result.changes) {
      return { content: [{ type: "text", text: "No field found at this position or rename not possible" }] };
    }

    // Apply the changes
    const applied = await applyWorkspaceEdit(result.changes, client);
    const fileCount = applied.length;
    const totalEdits = applied.reduce((sum, a) => sum + a.edits, 0);

    const summary = applied.slice(0, 20).map((a) => `  ${a.path}: ${a.edits} edits`).join("\n");

    return {
      content: [{
        type: "text",
        text: `Renamed field "${old_name}" to "${newName}" in ${fileCount} files (${totalEdits} total edits):\n${summary}`,
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
    function_name: z.string().describe("Expected function name (must match what's at the position)"),
    target_module: z.string().describe('Path to the target module file (e.g., "src/Utils/Helpers.elm")'),
  },
  async ({ file_path, line, character, function_name, target_module }) => {
    const absPath = resolveFilePath(file_path);
    const absTargetModule = resolveFilePath(target_module);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    if (!existsSync(absTargetModule)) {
      return { content: [{ type: "text", text: `Target module does not exist: ${target_module}` }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const sourceContent = readFileSync(absPath, "utf-8");
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
      return { content: [{ type: "text", text: `No function found at line ${line + 1}. Expected: ${function_name}` }] };
    }

    // Safety check: verify the function at this position matches expected name
    if (func.name !== function_name) {
      return {
        content: [{
          type: "text",
          text: `Safety check failed: Expected function '${function_name}' but found '${func.name}' at line ${line + 1}.\n` +
                `The line number may have shifted. Please verify the correct line for '${function_name}'.`,
        }],
      };
    }

    const functionName = func.name;
    const funcLine = func.location?.range?.start?.line ?? func.range?.start?.line ?? line;

    // Implement move function logic directly
    try {
      const changedFiles = [];
      const sourceLines = sourceContent.split("\n");
      const targetContent = readFileSync(absTargetModule, "utf-8");
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

      // Remove function from source file's exposing list
      for (let i = 0; i < newSourceLines.length; i++) {
        if (newSourceLines[i].includes("module ") && newSourceLines[i].includes(" exposing ")) {
          if (!newSourceLines[i].includes("exposing (..)")) {
            // Parse the exposing list
            const match = newSourceLines[i].match(/exposing\s*\(([^)]+)\)/);
            if (match) {
              const items = match[1].split(",").map((s) => s.trim()).filter((s) => s !== functionName);
              if (items.length > 0) {
                newSourceLines[i] = newSourceLines[i].replace(/exposing\s*\([^)]+\)/, `exposing (${items.join(", ")})`);
              }
            }
          }
          break;
        }
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
      writeFileSync(absPath, newSourceLines.join("\n"));
      changedFiles.push(absPath);
      writeFileSync(absTargetModule, newTargetLines.join("\n"));
      changedFiles.push(absTargetModule);

      // 7. Find and update references in other files that import from source module
      const elmFiles = [];
      const findElmFiles = (dir) => {
        if (!existsSync(dir)) return;
        for (const f of readdirSync(dir)) {
          const fullPath = join(dir, f);
          const stat = statSync(fullPath);
          if (stat.isDirectory() && !f.startsWith(".") && f !== "elm-stuff" && f !== "node_modules") {
            findElmFiles(fullPath);
          } else if (f.endsWith(".elm") && fullPath !== absPath && fullPath !== absTargetModule) {
            elmFiles.push(fullPath);
          }
        }
      };
      findElmFiles(workspaceRoot);

      let filesUpdated = 0;
      for (const elmFile of elmFiles) {
        const content = readFileSync(elmFile, "utf-8");
        // Check if this file imports functionName from sourceModule
        const importRegex = new RegExp(`import\\s+${sourceModuleName}\\s+exposing\\s*\\(([^)]+)\\)`);
        const match = content.match(importRegex);
        if (match && match[1].split(",").map((s) => s.trim()).includes(functionName)) {
          // This file imports the function from source - update it
          let newContent = content;

          // Remove functionName from the source import
          const oldItems = match[1].split(",").map((s) => s.trim());
          const newItems = oldItems.filter((s) => s !== functionName);
          if (newItems.length > 0) {
            newContent = newContent.replace(
              importRegex,
              `import ${sourceModuleName} exposing (${newItems.join(", ")})`
            );
          } else {
            // Remove the entire import line if no items left
            newContent = newContent.replace(new RegExp(`import\\s+${sourceModuleName}\\s+exposing\\s*\\([^)]+\\)\\n?`), "");
          }

          // Add or update import from target module
          const targetImportRegex = new RegExp(`import\\s+${targetModuleName}\\s+exposing\\s*\\(([^)]+)\\)`);
          const targetMatch = newContent.match(targetImportRegex);
          if (targetMatch) {
            // Target import exists, add functionName to it
            const targetItems = targetMatch[1].split(",").map((s) => s.trim());
            if (!targetItems.includes(functionName)) {
              targetItems.push(functionName);
              newContent = newContent.replace(
                targetImportRegex,
                `import ${targetModuleName} exposing (${targetItems.join(", ")})`
              );
            }
          } else {
            // Need to add new import for target module
            const lines = newContent.split("\n");
            let insertIdx = 0;
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].trim().startsWith("import ")) {
                insertIdx = i;
                break;
              }
            }
            if (insertIdx === 0) {
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes("module ")) {
                  insertIdx = i + 2;
                  break;
                }
              }
            }
            lines.splice(insertIdx, 0, `import ${targetModuleName} exposing (${functionName})`);
            newContent = lines.join("\n");
          }

          writeFileSync(elmFile, newContent);
          changedFiles.push(elmFile);
          filesUpdated++;
        }
      }

      // Notify LSP about all changed files so it updates its index
      for (const filePath of changedFiles) {
        const uri = `file://${filePath}`;
        const content = readFileSync(filePath, "utf-8");
        await client.notifyFileChanged(uri, content);
      }

      return {
        content: [{
          type: "text",
          text: `Successfully moved "${functionName}" from ${sourceModuleName} to ${targetModuleName}.\n` +
                `- Removed function from source file\n` +
                `- Added function to target file\n` +
                `- Updated source module's exposing list\n` +
                `- Updated target module's exposing list\n` +
                `- Updated imports in ${filesUpdated} other file(s).`,
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error moving function: ${error.message}` }] };
    }
  }
);

server.tool(
  "elm_prepare_remove_variant",
  "Check if a variant can be removed from a custom type. Returns variant info, usage count, and other variants for reference. Constructor usages will be replaced with Debug.todo.",
  {
    file_path: z.string().describe("Path to the Elm file containing the type definition"),
    line: z.number().describe("Line number of the variant name (0-indexed)"),
    character: z.number().describe("Character position within the variant name (0-indexed)"),
    variant_name: z.string().optional().describe("Expected variant name (if provided, validates it matches what's at the position)"),
  },
  async ({ file_path, line, character, variant_name }) => {
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.executeCommand("elm.prepareRemoveVariant", [uri, line, character]);

    if (!result || !result.success) {
      return { content: [{ type: "text", text: result?.error || `No variant found at line ${line + 1}` }] };
    }

    // Safety check: if variant_name provided, verify it matches
    if (variant_name && result.variantName !== variant_name) {
      return {
        content: [{
          type: "text",
          text: `Safety check failed: Expected variant '${variant_name}' but found '${result.variantName}' at line ${line + 1}.\n` +
                `The line number may have shifted. Please verify the correct line for '${variant_name}'.`,
        }],
      };
    }

    const otherVariants = result.otherVariants?.join(", ") || "none";
    const blockingUsages = result.blockingUsages || [];
    const patternUsages = result.patternUsages || [];
    const blockingCount = result.blockingCount || 0;
    const patternCount = result.patternCount || 0;

    let text = `Variant: ${result.variantName} (${result.variantIndex + 1}/${result.totalVariants} in type ${result.typeName})\n` +
               `Other variants: [${otherVariants}]\n`;

    if (blockingCount > 0) {
      text += `Constructor usages (replaced with Debug.todo): ${blockingCount}\n`;
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
    }

    text += `\nLine: ${result.range.start.line + 1}:${result.range.start.character}`;

    // Show constructor usages that will be replaced with Debug.todo
    if (blockingUsages.length > 0) {
      text += `\n\nConstructor usages (will be replaced with Debug.todo):\n`;
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
  "Remove a variant from a custom type. Constructor usages are replaced with Debug.todo, pattern matches are removed.",
  {
    file_path: z.string().describe("Path to the Elm file containing the type definition"),
    line: z.number().describe("Line number of the variant name (0-indexed)"),
    character: z.number().describe("Character position within the variant name (0-indexed)"),
    variant_name: z.string().describe("Expected variant name (must match what's at the position)"),
  },
  async ({ file_path, line, character, variant_name }) => {
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.executeCommand("elm.removeVariant", [uri, line, character]);

    if (!result) {
      return { content: [{ type: "text", text: `No variant found at line ${line + 1}. Expected: ${variant_name}` }] };
    }

    // Safety check: verify the variant at this position matches expected name
    if (result.variantName !== variant_name) {
      return {
        content: [{
          type: "text",
          text: `Safety check failed: Expected variant '${variant_name}' but found '${result.variantName}' at line ${line + 1}.\n` +
                `The line number may have shifted. Please verify the correct line for '${variant_name}'.`,
        }],
      };
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
      const applied = await applyWorkspaceEdit(result.changes, client);
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
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    if (!new_name.endsWith(".elm")) {
      return { content: [{ type: "text", text: "New name must end with .elm" }] };
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
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
      const applied = await applyWorkspaceEdit(result.changes, client);
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

      // Notify LSP about the file rename so it updates its index
      await client.executeCommand("elm.notifyFileRenamed", [result.oldPath, result.newPath]);

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
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    if (!target_path.endsWith(".elm")) {
      return { content: [{ type: "text", text: "Target path must end with .elm" }] };
    }

    // Convert absolute target path to relative (from workspace root)
    let relativeTargetPath = target_path;
    if (target_path.startsWith("/")) {
      const absTarget = resolveFilePath(target_path);
      if (absTarget.startsWith(workspaceRoot)) {
        relativeTargetPath = absTarget.slice(workspaceRoot.length + 1); // +1 for the /
      }
    }

    const client = await ensureClient(workspaceRoot);
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
    await client.openDocument(uri, content);

    const result = await client.executeCommand("elm.moveFile", [uri, relativeTargetPath]);

    if (!result) {
      return { content: [{ type: "text", text: "Failed to move file" }] };
    }

    if (!result.success) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    }

    // Apply the text edits (module declarations and imports)
    if (result.changes) {
      const applied = await applyWorkspaceEdit(result.changes, client);
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

      // Notify LSP about the file move so it updates its index
      await client.executeCommand("elm.notifyFileRenamed", [result.oldPath, result.newPath]);

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

server.tool(
  "elm_notify_file_changed",
  "Notify the LSP that a file was renamed/moved (updates internal index without restarting)",
  {
    old_path: z.string().describe("Original file path"),
    new_path: z.string().describe("New file path"),
  },
  async ({ old_path, new_path }) => {
    const absOldPath = resolveFilePath(old_path);
    const absNewPath = resolveFilePath(new_path);
    const workspaceRoot = findWorkspaceRoot(absNewPath) || findWorkspaceRoot(absOldPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);
    await client.executeCommand("elm.notifyFileRenamed", [absOldPath, absNewPath]);

    return {
      content: [{
        type: "text",
        text: `Notified LSP about file change: ${old_path} → ${new_path}`,
      }],
    };
  }
);

server.tool(
  "elm_generate_erd",
  "Generate a Mermaid ERD (Entity-Relationship Diagram) from an Elm type alias. " +
  "Recursively includes all referenced types with inferred cardinality relationships. " +
  "List/Dict/Set → one-to-many, Maybe → optional, direct reference → one-to-one.",
  {
    file_path: z.string().describe("Path to the Elm file containing the type definition"),
    type_name: z.string().describe("Name of the type to generate ERD for (e.g., 'BackendModel')"),
  },
  async ({ file_path, type_name }) => {
    const absPath = resolveFilePath(file_path);
    const workspaceRoot = findWorkspaceRoot(absPath);
    if (!workspaceRoot) {
      return { content: [{ type: "text", text: "No elm.json found in parent directories" }] };
    }

    const client = await ensureClient(workspaceRoot);

    // Open the file to ensure it's indexed
    const uri = `file://${absPath}`;
    const content = readFileSync(absPath, "utf-8");
    await client.openDocument(uri, content);

    // Execute the generate ERD command
    const result = await client.executeCommand("elm.generateErd", [uri, type_name]);

    if (result?.success) {
      // Write raw mermaid to .mmd file
      const erdPath = join(workspaceRoot, "erd.mmd");
      writeFileSync(erdPath, result.mermaid, "utf-8");

      let summary = `ERD saved to: ${erdPath}\n\n`;
      summary += `**Entities:** ${result.entities} | **Relationships:** ${result.relationships}`;

      if (result.warnings && result.warnings.length > 0) {
        summary += `\n\n**Warnings:**\n${result.warnings.map(w => `- ${w}`).join('\n')}`;
      }

      return { content: [{ type: "text", text: summary }] };
    } else {
      return {
        content: [{
          type: "text",
          text: `Failed to generate ERD: ${result?.error || "Unknown error"}`,
        }],
      };
    }
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
