#!/usr/bin/env node
/**
 * MCP wrapper for Rust Elm LSP
 * Provides fast Elm language server capabilities to Claude Code
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { createServer as createHttpServer } from "http";
import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { ToolError } from "./errors.mjs";
import { RUST_LSP_PATH } from "./lsp-client.mjs";
import { tools } from "./tools.mjs";

// Short name to avoid 64-char limit on tool names
function createMcpServer() {
  const server = new McpServer(
    { name: "elr", version: "0.3.0" },
    { capabilities: { tools: {} } }
  );
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.input, async (args) => {
      try {
        return { content: [{ type: "text", text: await tool.run(args) }] };
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return { content: [{ type: "text", text: error.message }] };
      }
    });
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

function getArgValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return null;
  }
  return args[index + 1];
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

async function handleHttpRequest(req, res, transports) {
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

      const server = createMcpServer();
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

async function startHttpServer({ host, port }) {
  const transports = new Map();
  const server = createHttpServer((req, res) => {
    handleHttpRequest(req, res, transports).catch((error) => {
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

// Start the server
async function main() {
  const args = process.argv.slice(2);
  const wantsHttp = args.includes("--http");
  const wantsStdio = args.includes("--stdio");

  if (wantsHttp && wantsStdio) {
    console.error("Choose either --http or --stdio (not both).");
    process.exit(1);
  }

  const transportMode = wantsHttp
    ? "http"
    : wantsStdio
      ? "stdio"
      : process.env.MCP_TRANSPORT === "http"
        ? "http"
        : "stdio";

  // Skip loading for non-Elm projects
  if (!isElmProject()) {
    if (transportMode === "http") {
      console.error("No elm.json found in the current directory.");
      console.error("Start the MCP server from an Elm project root.");
      process.exit(1);
    }
    process.exit(0);
  }

  // Check if Rust LSP binary exists
  if (!existsSync(RUST_LSP_PATH)) {
    console.error(`Rust LSP binary not found at ${RUST_LSP_PATH}`);
    console.error("Run 'cargo build --release' first");
    process.exit(1);
  }

  if (transportMode === "http") {
    const host = getArgValue(args, "--host") || process.env.MCP_HOST || "127.0.0.1";
    const portRaw = getArgValue(args, "--port") || process.env.MCP_PORT || "3333";
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      console.error(`Invalid port: ${portRaw}`);
      process.exit(1);
    }
    await startHttpServer({ host, port });
    return;
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
