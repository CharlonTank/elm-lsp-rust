/**
 * Client for the Rust Elm language server.
 * Spawns the binary and speaks LSP to it over stdio.
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { ToolError } from "./errors.mjs";
import { toFileUri, toolPath } from "./workspace.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the Rust LSP binary
export const RUST_LSP_PATH = join(__dirname, "..", "target", "release", "elm_lsp");

const REQUEST_TIMEOUT_MS = 30000;

// A language server that no call has used for this long is stopped. The next call starts it again.
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// Separates the headers of an LSP message from its body
const HEADER_END = "\r\n\r\n";

// One language server process, bound to one Elm project for its whole life.
// Its failures are ToolErrors: the caller can rebuild the binary or repeat the call.
export class ElmLspClient {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.process = null;
    this.requestId = 0;
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this.buffer = Buffer.alloc(0);
    this.documentVersions = {};
    this.idleTimer = null;
    // Called when the server is told to stop, and once its process is gone, however it ended
    this.onExit = () => {};
  }

  // Spawn the server and complete the LSP handshake.
  start() {
    return new Promise((resolve, reject) => {
      if (!existsSync(RUST_LSP_PATH)) {
        reject(new ToolError(`Rust LSP binary not found at ${RUST_LSP_PATH}. Run scripts/setup.sh to build it.`));
        return;
      }

      const child = spawn(RUST_LSP_PATH, [], {
        stdio: ["pipe", "pipe", "pipe"],
        // The server runs the Elm compiler for diagnostics and finds it on PATH
        env: { ...process.env, RUST_LOG: "warn", PATH: toolPath(this.workspaceRoot) },
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

      child.on("error", (error) => {
        reject(new ToolError(`Could not start ${RUST_LSP_PATH}: ${error.message}`));
      });

      child.on("close", (code) => {
        this.process = null;
        clearTimeout(this.idleTimer);
        for (const { reject, timer } of this.pendingRequests.values()) {
          clearTimeout(timer);
          reject(new ToolError(`LSP process exited with code ${code}`));
        }
        this.pendingRequests.clear();
        this.onExit();
      });

      this.sendRequest("initialize", {
        processId: process.pid,
        rootUri: toFileUri(this.workspaceRoot),
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
            pending.reject(new ToolError(message.error.message));
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
      throw new ToolError("The Elm language server has stopped. Repeat the call to start it again.");
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
        reject(new ToolError(`Request ${method} timed out`));
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

  async executeCommand(command, args) {
    return this.sendRequest("workspace/executeCommand", {
      command,
      arguments: args,
    });
  }

  // Start the idle countdown again. Called for every use of the client.
  keepAlive() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_TIMEOUT_MS);
    // An idle server must not keep a process alive that has nothing else to do
    this.idleTimer.unref();
  }

  // The process takes a moment to go, and a call that arrives in that moment
  // must not be sent to it. The close handler settles what is still pending.
  stop() {
    this.onExit();
    this.process?.kill();
  }
}

// One running language server per Elm project, started on first use and
// stopped once it has been idle for IDLE_TIMEOUT_MS.
// The promise settles once the server has answered the handshake.
const clients = new Map(); // workspace root -> Promise<ElmLspClient>

export async function ensureClient(workspaceRoot) {
  let starting = clients.get(workspaceRoot);
  if (!starting) {
    const client = new ElmLspClient(workspaceRoot);
    starting = client.start().then(() => client);
    // Drop a server that failed to start, is stopping or has exited, so the next call starts a new one
    const forget = () => {
      if (clients.get(workspaceRoot) === starting) {
        clients.delete(workspaceRoot);
      }
    };
    client.onExit = forget;
    starting.catch(forget);
    clients.set(workspaceRoot, starting);
  }

  const client = await starting;
  client.keepAlive();
  return client;
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
