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

// What a call says when the binary lacks a command that this wrapper sends
const OLDER_BINARY = `${RUST_LSP_PATH} is older than this wrapper. Run scripts/setup.sh to rebuild it.`;

// How long a request waits for the server's answer
export const REQUEST_TIMEOUT_MS = 30000;

// Whether a language server stays for the calls after the one that started it. The command line
// runs one call and stops the language server once the call returns.
let serversStay = true;

// Have each language server stop with the call that started it, as the command line does.
export function serveOneCall(on = true) {
  serversStay = !on;
}

// What a request for diagnostics says when it runs out of time. A language server that stays reads
// no other message until the compiler ends. One that stops with its call leaves the compiler
// running without it, and the next call starts a compiler of its own.
const compilerTimedOut = () =>
  `The Elm compiler did not finish within ${REQUEST_TIMEOUT_MS / 1000} seconds. ` +
  (serversStay
    ? "It is still running, and the language server answers no call for this project until it ends. " +
      "Make the same call again once it has ended to get its diagnostics"
    : "It goes on in the background after this command ends. " +
      "Wait for it to end before you ask for diagnostics again, because each call starts a compiler of its own");
// What any request says when it runs out of time while the compiler of an earlier one goes on
const COMPILER_STILL_RUNNING =
  "The Elm compiler of an earlier elm_diagnostics call is still running, and the language server answers no call for this project until it ends. " +
  "Make the call again once it has ended";

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
    // The id of the last request for diagnostics that ran out of time, until its answer arrives after
    // all. The server takes its messages in order, so until then it answers none that came after it.
    this.lateCompile = null;
    this.buffer = Buffer.alloc(0);
    this.documentVersions = {};
    // Settles once the handshake is over. Set by start().
    this.started = null;
    this.idleTimer = null;
    // Called when the server is told to stop, and once its process is gone, however it ended
    this.onExit = () => {};
  }

  // Spawn the server and complete the LSP handshake.
  start() {
    this.started = new Promise((resolve, reject) => {
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
    return this.started;
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
        if (message.id === this.lateCompile) {
          this.lateCompile = null;
        }
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

  // A request that runs the compiler goes on in the server after its wait is over, and holds up every
  // message behind it. It says so when it runs out of time, and so do the requests behind it.
  sendRequest(method, params, { runsCompiler = false } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      this.sendMessage({ jsonrpc: "2.0", id, method, params });

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        if (this.lateCompile !== null) {
          reject(new ToolError(COMPILER_STILL_RUNNING));
        } else {
          reject(new ToolError(runsCompiler ? compilerTimedOut() : `Request ${method} timed out`));
        }
        if (runsCompiler) {
          this.lateCompile = id;
        }
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timer });
    });
  }

  sendNotification(method, params) {
    this.sendMessage({ jsonrpc: "2.0", method, params });
    return Promise.resolve();
  }

  // The server takes its messages in the order they arrive, and it has
  // indexed a document before it looks at the next message. A request can
  // follow these two notifications at once.
  openDocument(uri, content) {
    return this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "elm",
        version: 1,
        text: content,
      },
    });
  }

  notifyFileChanged(uri, content) {
    // Increment version for tracking changes
    this.documentVersions[uri] = (this.documentVersions[uri] || 1) + 1;

    return this.sendNotification("textDocument/didChange", {
      textDocument: {
        uri,
        version: this.documentVersions[uri],
      },
      contentChanges: [{ text: content }],
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
    // The server runs the compiler before it answers, and reads no other message until the
    // compiler ends. A first build that downloads packages can take longer than a request waits.
    return this.sendRequest(
      "workspace/executeCommand",
      { command: "elm.getDiagnostics", arguments: [uri] },
      { runsCompiler: true }
    );
  }

  async executeCommand(command, args) {
    return this.sendRequest("workspace/executeCommand", {
      command,
      arguments: args,
    });
  }

  /**
   * Have the server compare its index with the project's source files and read
   * the ones that changed. It reads them once, when it starts. An agent edits,
   * creates and deletes files with its own tools between calls, and a
   * refactoring computed from the old text would put its edits in the wrong
   * places.
   */
  async syncWithDisk() {
    const result = await this.executeCommand("elm.syncWithDisk", []);
    if (result?.synced === true) return;
    // The server says why it has no index, for instance an elm.json it cannot
    // read. A server built before this command existed answers something else.
    throw new ToolError(result?.synced === false ? result.error : OLDER_BINARY);
  }

  /**
   * The stretches of an open file that the server's parser could not read, each
   * with a start and an end like the range of a symbol. Around one of them the
   * symbols of the file can lack a declaration, or begin and end one in the
   * wrong place.
   */
  async getUnreadRanges(uri) {
    const result = await this.executeCommand("elm.unreadRanges", [uri]);
    if (Array.isArray(result?.ranges)) return result.ranges;
    // A server built before this command existed answers that it does not know it
    const unknown = !result?.error || result.error.startsWith("Unknown command");
    throw new ToolError(unknown ? OLDER_BINARY : result.error);
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

// One language server per Elm project, started on first use and stopped once
// it has been idle for IDLE_TIMEOUT_MS.
const clients = new Map(); // workspace root -> ElmLspClient

/**
 * The language server for a project, with its index in step with the
 * project's files as they are on disk right now.
 */
export async function ensureClient(workspaceRoot) {
  let client = clients.get(workspaceRoot);
  if (!client) {
    client = new ElmLspClient(workspaceRoot);
    clients.set(workspaceRoot, client);
    // Drop a server that failed to start, is stopping or has exited, so the next call starts a new one
    const forget = () => {
      if (clients.get(workspaceRoot) === client) {
        clients.delete(workspaceRoot);
      }
    };
    client.onExit = forget;
    client.start().catch(forget);
  }

  await client.started;
  client.keepAlive();
  await client.syncWithDisk();
  return client;
}

// Stop every language server, so the process can exit. Each one has its
// signal by the time this returns, including one that is still starting.
export function stopClients() {
  for (const client of clients.values()) {
    client.stop();
  }
  clients.clear();
}
