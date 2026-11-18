#!/usr/bin/env node
/**
 * MCP wrapper for Rust Elm LSP
 * Serves the Elm tools to any MCP client, over stdio or HTTP
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { createServer as createHttpServer } from "http";
import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { RUST_LSP_PATH, stopClients } from "./lsp-client.mjs";
import { tools } from "./tools.mjs";
import { allowProjectTools } from "./workspace.mjs";

const USAGE = `Usage: node index.mjs [options]

Serves the Elm tools over MCP.

  --stdio              Serve over stdio (default)
  --http               Serve over streamable HTTP at /mcp
  --host <host>        HTTP bind address (default 127.0.0.1, or MCP_HOST)
  --port <port>        HTTP port (default 3333, or MCP_PORT)
  --read-only          Offer only the tools that never edit a source file
  --project-tools      Take the compiler and elm-format from a project's node_modules/.bin
                       when they are there. Only for projects you trust: it lets a
                       repository choose the program that diagnostics and formatting run
  --elm-projects-only  Exit at once unless the working directory holds an Elm project
  --help               Show this text`;

const FLAGS = ["--stdio", "--http", "--read-only", "--project-tools", "--elm-projects-only", "--help", "-h"];
const OPTIONS_WITH_VALUE = ["--host", "--port"];

// A command line the server does not understand
class UsageError extends Error {}

/**
 * Read the command line into { flags, values }. An option the server does not
 * know is an error: a mistyped --read-only must not start a server that writes.
 */
function parseArguments(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (FLAGS.includes(argument)) {
      flags.add(argument);
    } else if (OPTIONS_WITH_VALUE.includes(argument)) {
      if (argv[i + 1] === undefined) throw new UsageError(`${argument} needs a value`);
      values[argument] = argv[++i];
    } else {
      throw new UsageError(`Unknown option "${argument}"`);
    }
  }
  if (flags.has("--http") && flags.has("--stdio")) {
    throw new UsageError("Choose either --http or --stdio (not both).");
  }
  return { flags, values };
}

// Sent to the client when it connects. Harnesses show it to the model.
const INSTRUCTIONS =
  "Code intelligence and refactoring for Elm projects. " +
  "Pass absolute file paths, because a relative path resolves against the directory this server was started in, " +
  "and that differs between harnesses. " +
  "Lines and characters in arguments are 0-indexed. Locations in results have 1-indexed lines. " +
  "Refactoring tools write their edits to disk, so read a file again before you edit it further.";

// Short name to avoid 64-char limit on tool names
function createMcpServer({ readOnly }) {
  const server = new McpServer(
    { name: "elr", version: "0.3.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );
  for (const tool of tools) {
    if (readOnly && !tool.readOnly) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        // Harnesses read these hints to decide which calls need the user's approval
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: !tool.readOnly,
          openWorldHint: tool.openWorld === true,
        },
      },
      // When run() throws, the SDK answers with the error message and isError set.
      async (args) => ({ content: [{ type: "text", text: await tool.run(args) }] })
    );
  }
  return server;
}

// Check if current directory or any immediate subdirectory has elm.json
// This handles monorepo layouts where elm.json is in a subdirectory (e.g. project/client/elm.json)
function isElmProject() {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "elm.json"))) return true;
  try {
    for (const entry of readdirSync(cwd)) {
      const sub = join(cwd, entry);
      if (statSync(sub).isDirectory() && existsSync(join(sub, "elm.json"))) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function isInitializePayload(payload) {
  if (!payload) {
    return false;
  }
  if (Array.isArray(payload)) {
    return payload.some(isInitializePayload);
  }
  return payload?.method === "initialize";
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    return undefined;
  }
  return JSON.parse(raw);
}

function sendJsonError(res, status, code, message) {
  if (res.headersSent) {
    return;
  }
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function handleHttpRequest(req, res, transports, serverOptions) {
  if (!req.url || !req.url.startsWith("/mcp")) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  if (req.method === "POST") {
    let parsedBody;
    try {
      parsedBody = await readJsonBody(req);
    } catch (error) {
      sendJsonError(res, 400, -32700, "Parse error: Invalid JSON");
      return;
    }

    if (parsedBody === undefined) {
      sendJsonError(res, 400, -32700, "Parse error: Empty request body");
      return;
    }

    const isInit = isInitializePayload(parsedBody);
    let transport;

    if (isInit) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          transports.set(sessionId, transport);
        },
        onsessionclosed: (sessionId) => {
          transports.delete(sessionId);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      const server = createMcpServer(serverOptions);
      await server.connect(transport);
    } else {
      const sessionHeader = normalizeHeaderValue(req.headers["mcp-session-id"]);
      if (!sessionHeader || !transports.has(sessionHeader)) {
        sendJsonError(res, 400, -32000, "Bad Request: No valid session ID provided");
        return;
      }
      transport = transports.get(sessionHeader);
    }

    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    const sessionHeader = normalizeHeaderValue(req.headers["mcp-session-id"]);
    if (!sessionHeader || !transports.has(sessionHeader)) {
      res.statusCode = 400;
      res.end("Invalid or missing session ID");
      return;
    }
    const transport = transports.get(sessionHeader);
    await transport.handleRequest(req, res);
    return;
  }

  res.statusCode = 405;
  res.end("Method Not Allowed");
}

async function startHttpServer({ host, port, serverOptions }) {
  const transports = new Map();
  const server = createHttpServer((req, res) => {
    handleHttpRequest(req, res, transports, serverOptions).catch((error) => {
      console.error("MCP HTTP server error:", error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal server error");
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`MCP HTTP server listening on http://${host}:${port}/mcp`);
      resolve();
    });
  });
}

// Stop the language servers and exit. Their processes would otherwise keep this one alive.
function shutDown() {
  stopClients();
  process.exit(0);
}

// Start the server
async function main() {
  const { flags, values } = parseArguments(process.argv.slice(2));
  if (flags.has("--help") || flags.has("-h")) {
    console.log(USAGE);
    return;
  }

  const serverOptions = { readOnly: flags.has("--read-only") };
  const transportMode = flags.has("--http")
    ? "http"
    : flags.has("--stdio")
      ? "stdio"
      : process.env.MCP_TRANSPORT === "http"
        ? "http"
        : "stdio";

  // Every tool finds its project from the file it is given, so the server can
  // start anywhere. The Claude Code plugin starts it in every project the user
  // opens, and passes this flag to keep the tools out of the ones without Elm.
  if (flags.has("--elm-projects-only") && !isElmProject()) {
    // Over stdio the harness started the server and is told nothing. A person starts the HTTP server.
    if (transportMode === "http") {
      console.error(
        `No server started: --elm-projects-only was given, and neither ${process.cwd()} nor a direct child of it holds an elm.json.`
      );
      process.exit(1);
    }
    process.exit(0);
  }

  // Check if Rust LSP binary exists
  if (!existsSync(RUST_LSP_PATH)) {
    console.error(`Rust LSP binary not found at ${RUST_LSP_PATH}`);
    console.error("Run scripts/setup.sh to build it");
    process.exit(1);
  }

  if (flags.has("--project-tools")) {
    allowProjectTools();
  }
  process.on("SIGTERM", shutDown);
  process.on("SIGINT", shutDown);

  if (transportMode === "http") {
    const host = values["--host"] || process.env.MCP_HOST || "127.0.0.1";
    const portRaw = values["--port"] || process.env.MCP_PORT || "3333";
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new UsageError(`Invalid port: ${portRaw}`);
    }
    await startHttpServer({ host, port, serverOptions });
    return;
  }

  const server = createMcpServer(serverOptions);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // A harness ends a stdio server by closing its input
  process.stdin.on("end", shutDown);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
