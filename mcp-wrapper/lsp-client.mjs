/**
 * Client for the Rust Elm language server.
 * Spawns the binary and speaks LSP to it over stdio.
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the Rust LSP binary
export const RUST_LSP_PATH = join(__dirname, "..", "target", "release", "elm_lsp");

const REQUEST_TIMEOUT_MS = 30000;

// Separates the headers of an LSP message from its body
const HEADER_END = "\r\n\r\n";

// One language server process, bound to one Elm project for its whole life.
export class ElmLspClient {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.process = null;
    this.requestId = 0;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this.buffer = Buffer.alloc(0);
    this.documentVersions = {};
    // Called once the process is gone, however it ended
    this.onExit = () => {};
  }

  // Spawn the server and complete the LSP handshake.
  start() {
    return new Promise((resolve, reject) => {
      if (!existsSync(RUST_LSP_PATH)) {
        reject(new Error(`Rust LSP binary not found at ${RUST_LSP_PATH}. Run scripts/setup.sh to build it.`));
        return;
      }

      const child = spawn(RUST_LSP_PATH, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, RUST_LOG: "warn" },
      });
      this.process = child;

      child.stdout.on("data", (chunk) => {
        this.handleData(chunk);
      });

      child.stderr.on("data", (data) => {
        // Log errors but don't fail
        console.error(`[elm-lsp-rust] ${data.toString()}`);
      });

      // A write to a server that just died fails here. The close handler reports the exit.
      child.stdin.on("error", () => {});

      child.on("error", reject);

      child.on("close", (code) => {
        this.process = null;
        for (const { reject, timer } of this.pendingRequests.values()) {
          clearTimeout(timer);
          reject(new Error(`LSP process exited with code ${code}`));
        }
        this.pendingRequests.clear();
        this.onExit();
      });

      this.sendRequest("initialize", {
        processId: process.pid,
        rootUri: `file://${this.workspaceRoot}`,
        capabilities: {},
      })
        .then(() => this.sendNotification("initialized", {}))
        .then(resolve, reject);
    }).catch((error) => {
      this.stop();
      throw error;
    });
  }

  // Take a chunk of the server's output and settle every request whose
  // response is now complete. Content-Length counts bytes, and a chunk can end
  // inside a multi-byte character, so the stream stays a Buffer until a whole
  // message is in.
  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd === -1) break;

      const bodyStart = headerEnd + HEADER_END.length;
      const header = this.buffer.toString("ascii", 0, headerEnd);
      const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
      if (Number.isNaN(length)) {
        // Not an LSP header. Skip it, or the loop would never get past it.
        this.buffer = this.buffer.subarray(bodyStart);
        continue;
      }

      if (this.buffer.length < bodyStart + length) break;

      const content = this.buffer.toString("utf8", bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);

      try {
        const message = JSON.parse(content);
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error.message));
          } else {
            pending.resolve(message.result);
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  sendMessage(message) {
    if (!this.process) {
      throw new Error("The Elm language server has stopped. Repeat the call to start it again.");
    }
    const content = JSON.stringify(message);
    const byteLength = Buffer.byteLength(content, 'utf8');
    const header = `Content-Length: ${byteLength}\r\n\r\n`;
    this.process.stdin.write(header + content);
  }

  sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.sendMessage({ jsonrpc: "2.0", id, method, params });

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timer });
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

  // The close handler settles what is still pending and calls onExit.
  stop() {
    this.process?.kill();
  }
}

// One running language server per Elm project, started on first use.
// The promise settles once the server has answered the handshake.
const clients = new Map(); // workspace root -> Promise<ElmLspClient>

export function ensureClient(workspaceRoot) {
  const running = clients.get(workspaceRoot);
  if (running) {
    return running;
  }

  const client = new ElmLspClient(workspaceRoot);
  const starting = client.start().then(() => client);
  // Drop a server that failed to start or has exited, so the next call starts a new one
  const forget = () => {
    if (clients.get(workspaceRoot) === starting) {
      clients.delete(workspaceRoot);
    }
  };
  client.onExit = forget;
  starting.catch(forget);

  clients.set(workspaceRoot, starting);
  return starting;
}

// Stop every language server, so a short-lived process can exit.
export function stopClients() {
  for (const starting of clients.values()) {
    starting.then(
      (client) => client.stop(),
      () => {}
    );
  }
  clients.clear();
}
