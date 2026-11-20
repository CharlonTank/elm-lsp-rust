#!/usr/bin/env node
/**
 * MCP wrapper for Rust Elm LSP
 * Serves the Elm tools to any MCP client, over stdio or HTTP
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { createServer as createHttpServer } from "http";
import { join } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { RUST_LSP_PATH, stopClients } from "./lsp-client.mjs";
import { runInTurn, tools } from "./tools.mjs";
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
 * Read the command line into { flags, http, host, port }. An option the
 * server does not understand is an error: a mistyped --read-only must not
 * start a server that writes.
 */
function parseArguments(argv, env) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (FLAGS.includes(argument)) {
      flags.add(argument);
    } else if (OPTIONS_WITH_VALUE.includes(argument)) {
      const value = argv[++i];
      // Another option in the value's place means the value was left out.
      // Read as a host name, --read-only would be gone from the command line.
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`${argument} needs a value`);
      }
      values[argument] = value;
    } else {
      throw new UsageError(`Unknown option "${argument}"`);
    }
  }
  if (flags.has("--http") && flags.has("--stdio")) {
    throw new UsageError("Choose either --http or --stdio (not both).");
  }

  const http = flags.has("--http") || (!flags.has("--stdio") && env.MCP_TRANSPORT === "http");
  if (!http && Object.keys(values).length > 0) {
    throw new UsageError(`${Object.keys(values).join(" and ")} can only be used with --http`);
  }
  const port = values["--port"] || env.MCP_PORT || "3333";
  if (http && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    throw new UsageError(`Invalid port: ${port}`);
  }
  return { flags, http, host: values["--host"] || env.MCP_HOST || "127.0.0.1", port: Number(port) };
}

// Sent to the client when it connects. Harnesses show it to the model.
const INSTRUCTIONS =
  "Code intelligence and refactoring for Elm projects. " +
  "Pass absolute file paths, because a relative path resolves against the directory this server was started in, " +
  "and that differs between harnesses. " +
  "The one exception is target_path of elm_move_file, which starts at the project root when it is relative. " +
  "Lines and characters in arguments are 0-indexed. Locations in results have 1-indexed lines. " +
  "Refactoring tools write their edits to disk, so read a file again before you edit it further. " +
  "On a line with non-ASCII text before the symbol, columns in results count UTF-8 bytes, and a column you count yourself has to count them too. " +
  "Pass such a column to a tool as the result gave it. " +
  "elm_diagnostics prints the compiler's own line and column, which count from 1 and by characters.";

// The tool calls that are running now. A refactoring among them has files left
// to write, so the server does not leave before they are done.
const runningCalls = new Set();

// Resolves once no tool call is running.
async function callsDone() {
  while (runningCalls.size > 0) {
    await Promise.allSettled([...runningCalls]);
  }
}

// Short name to avoid 64-char limit on tool names
function createMcpServer({ readOnly }) {
  const server = new McpServer(
    { name: "elr", version: "0.3.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );
  // The offered tools by name, as the SDK keeps them
  const offered = new Map();
  for (const tool of tools) {
    if (readOnly && !tool.readOnly) continue;
    const registered = server.registerTool(
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
      async (args) => {
        const call = runInTurn(tool, args);
        runningCalls.add(call);
        try {
          return { content: [{ type: "text", text: await call }] };
        } finally {
          runningCalls.delete(call);
        }
      }
    );
    offered.set(tool.name, registered);
  }
  // In place of the SDK's handler, which waits for its check of the arguments before it runs the
  // tool. That check takes longer for more arguments, so of two calls that arrive together the one
  // with fewer would take its turn first. This one checks them at once, and a call takes its turn
  // before anything is awaited. The answers and their texts are those of the SDK. A tool whose run()
  // throws is answered with the error message and isError set.
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    try {
      const tool = offered.get(params.name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, `Tool ${params.name} not found`);
      const checked = tool.inputSchema.safeParse(params.arguments);
      if (!checked.success) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Input validation error: Invalid arguments for tool ${params.name}: ${checked.error.message}`
        );
      }
      return await tool.handler(checked.data, extra);
    } catch (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  });
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

async function handleHttpRequest(req, res, transports, { serverOptions, transportOptions }) {
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
        ...transportOptions,
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

// A command line the server understands and cannot carry out
class StartError extends Error {}

// True for an address of this machine that nothing outside it can reach.
const isLoopback = (address) => address === "::1" || /^(::ffff:)?127\./.test(address);

// How an address is written in the host part of a URL.
const inUrl = (address) => (address.includes(":") ? `[${address}]` : address);

/**
 * Transport options for a server that listens at `address`, which `host`
 * resolved to. On a loopback address only requests addressed to the machine
 * itself are answered. A web page reaches such a server by pointing its own
 * domain at 127.0.0.1 (DNS rebinding), and the browser then sends that domain
 * as Host and the page as Origin. A server bound to any other address is meant
 * to be reached from elsewhere.
 */
function loopbackGuard(address, host, port) {
  if (!isLoopback(address)) return {};
  const names = new Set(["127.0.0.1", "localhost", "[::1]", inUrl(host), inUrl(address)]);
  // A client leaves out the port that http implies
  const hosts = [...names].map((name) => (port === 80 ? name : `${name}:${port}`));
  return {
    enableDnsRebindingProtection: true,
    allowedHosts: hosts,
    allowedOrigins: hosts.map((name) => `http://${name}`),
  };
}

async function startHttpServer({ host, port, serverOptions }) {
  const transports = new Map();
  const options = { serverOptions, transportOptions: {} };
  const server = createHttpServer((req, res) => {
    handleHttpRequest(req, res, transports, options).catch((error) => {
      console.error("MCP HTTP server error:", error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal server error");
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      reject(new StartError(`Cannot listen on ${host}:${port}: ${error.message}`));
    });
    server.listen(port, host, () => {
      // Decided from the address the server got, whichever way the host was spelled
      options.transportOptions = loopbackGuard(server.address().address, host, port);
      console.log(`MCP HTTP server listening on http://${inUrl(host)}:${port}/mcp`);
      resolve();
    });
  });
}

// Stop the language servers and exit. Their processes would otherwise keep this one alive.
function shutDown() {
  stopClients();
  process.exit(0);
}

// How long the server goes on working after it was told to end
const ANSWER_GRACE_MS = 60_000;

// Resolves once the calls that are running have finished, or have had their time. A
// refactoring among them has files left to write, and a file move its file left to move.
const callsOver = () => Promise.race([callsDone(), new Promise((resolve) => setTimeout(resolve, ANSWER_GRACE_MS))]);

// Start the server
async function main() {
  const { flags, http, host, port } = parseArguments(process.argv.slice(2), process.env);
  if (flags.has("--help") || flags.has("-h")) {
    console.log(USAGE);
    return;
  }

  const serverOptions = { readOnly: flags.has("--read-only") };

  // Every tool finds its project from the file it is given, so the server can
  // start anywhere. The Claude Code plugin starts it in every project the user
  // opens, and passes this flag to keep the tools out of the ones without Elm.
  if (flags.has("--elm-projects-only") && !isElmProject()) {
    // Over stdio the harness started the server and is told nothing. A person starts the HTTP server.
    if (http) {
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
  // Asked to end, the server lets the calls that are running finish. Asked again, it ends at once.
  let leaving = false;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (leaving) shutDown();
      leaving = true;
      callsOver().then(shutDown);
    });
  }

  if (http) {
    await startHttpServer({ host, port, serverOptions });
    return;
  }

  const server = createMcpServer(serverOptions);
  await server.connect(new StdioServerTransport());
  // A harness that is gone reads no answers. Writing one fails, and nobody is left to serve.
  process.stdout.on("error", () => callsOver().then(shutDown));
  // A harness ends a stdio server by closing its input. It may still be
  // reading the answer to its last call, so the calls that are running finish
  // first. A call the client cancelled runs on as well: it gets no answer, and
  // it still writes.
  process.stdin.on("end", async () => {
    await callsOver();
    // The answers are sent in the turns after their calls settle. The callback
    // of the write runs once everything before it has left this process.
    setImmediate(() => process.stdout.write("", shutDown));
  });
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (err instanceof StartError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
