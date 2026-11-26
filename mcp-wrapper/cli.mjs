#!/usr/bin/env node
/**
 * Command-line access to the Elm tools, for agents and scripts that have a
 * shell but no MCP client. Each call starts the language server, runs one
 * tool and exits.
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { z } from "zod";
import { runChecks } from "./doctor.mjs";
import { ToolError } from "./errors.mjs";
import { findHarness, harnesses, installAt, renderMarkdown, renderText } from "./harnesses.mjs";
import { serveOneCall, stopClients } from "./lsp-client.mjs";
import { runInTurn, tools } from "./tools.mjs";
import { allowProjectTools } from "./workspace.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// How this script was started, so the usage text can be pasted as it is
const SELF = `node ${process.argv[1]}`;

const USAGE = `Usage: ${SELF} <command>

  tools [--json]               List the tools
  <tool> --<argument> <value>  Run one tool, for example:
                                 elm_references --file_path src/Main.elm --line 10 --character 4
  <tool> --args '<json>'       Run one tool with all arguments as a JSON object
  <tool> --help                Describe one tool and its arguments
  config [<harness>]           Show how to register the MCP server with a harness
  doctor                       Check that the installation works

  --project-tools              With any tool: take the compiler and elm-format from the
                               project's node_modules/.bin when they are there. Only for
                               projects you trust.

The elm_ prefix of a tool name is optional. Lines and characters are 0-indexed, and a
character counts UTF-8 bytes on a line with non-ASCII text before it.
Exit status: 0 on success, 1 when the tool fails, 2 when the command line is wrong.`;

// A mistake on the command line, as opposed to a tool that ran and failed.
class UsageError extends Error {}

// How to read a command-line value for this field, as "string", "number" or "json".
function valueKind(schema) {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  if (inner instanceof z.ZodString) return "string";
  if (inner instanceof z.ZodNumber) return "number";
  return "json";
}

function describeParameters(tool) {
  return Object.entries(tool.input).map(([name, schema]) => ({
    name,
    type: valueKind(schema),
    required: !schema.isOptional(),
    description: schema.description,
  }));
}

function findTool(name) {
  return tools.find((tool) => tool.name === name || tool.name === `elm_${name}`);
}

function readValue(name, kind, raw) {
  if (kind === "string") return raw;
  if (kind === "number") {
    // Every numeric argument is a line, a column or a count
    if (!/^\d+$/.test(raw)) {
      throw new UsageError(`--${name} takes a whole number, got "${raw}"`);
    }
    return Number(raw);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`--${name} takes JSON, got "${raw}"`);
  }
}

// Turn ["--file_path", "src/Main.elm", "--line", "3"] into the tool's argument object.
function parseToolArguments(tool, argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const raw = argv[i + 1];
    if (!flag.startsWith("--")) {
      throw new UsageError(`Expected --<argument>, got "${flag}"`);
    }
    if (raw === undefined) {
      throw new UsageError(`${flag} needs a value`);
    }

    if (flag === "--args") {
      const parsed = readValue("args", "json", raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new UsageError("--args takes a JSON object");
      }
      Object.assign(args, parsed);
      continue;
    }

    // --file-path and --file_path both name the file_path argument
    const name = flag.slice(2).replaceAll("-", "_");
    if (!(name in tool.input)) {
      throw new UsageError(`${tool.name} has no argument ${flag}. It takes: ${Object.keys(tool.input).join(", ")}`);
    }
    args[name] = readValue(name, valueKind(tool.input[name]), raw);
  }

  const checked = z.object(tool.input).strict().safeParse(args);
  if (!checked.success) {
    const problems = checked.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`);
    throw new UsageError(`Invalid arguments for ${tool.name}:\n  ${problems.join("\n  ")}`);
  }
  return checked.data;
}

function toolHelp(tool) {
  const parameters = describeParameters(tool).map(
    ({ name, type, required, description }) =>
      `  --${name} <${type}>${required ? "" : " (optional)"}\n      ${description}`
  );
  return [`${tool.name}: ${tool.description}`, "", ...parameters].join("\n");
}

function listTools(asJson) {
  if (asJson) {
    return JSON.stringify(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly,
        parameters: describeParameters(tool),
      })),
      null,
      2
    );
  }
  const width = Math.max(...tools.map((tool) => tool.name.length));
  return tools.map((tool) => `${tool.name.padEnd(width)}  ${tool.description}`).join("\n");
}

function showConfig([target]) {
  if (target === "--markdown") {
    return renderMarkdown().trimEnd();
  }
  if (target === undefined) {
    const width = Math.max(...harnesses.map((harness) => harness.id.length));
    const rows = harnesses.map((harness) => `  ${harness.id.padEnd(width)}  ${harness.name}`);
    return [`Usage: ${SELF} config <harness>`, "", ...rows].join("\n");
  }
  const harness = findHarness(target);
  if (!harness) {
    throw new UsageError(`Unknown harness "${target}". Known: ${harnesses.map((h) => h.id).join(", ")}`);
  }
  return renderText(harness, installAt(REPO_ROOT));
}

async function runTool(name, argv) {
  const tool = findTool(name);
  if (!tool) {
    throw new UsageError(`Unknown command "${name}". Run "${SELF} tools" to list the tools.`);
  }
  if (argv.includes("--help")) {
    return toolHelp(tool);
  }
  serveOneCall();
  try {
    return await runInTurn(tool, parseToolArguments(tool, argv));
  } finally {
    stopClients();
  }
}

async function main(argv) {
  if (argv.includes("--project-tools")) {
    allowProjectTools();
  }
  const [command, ...rest] = argv.filter((argument) => argument !== "--project-tools");
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return USAGE;
    case "tools":
      return listTools(rest.includes("--json"));
    case "config":
      return showConfig(rest);
    case "doctor": {
      const { report, ok } = await runChecks();
      if (!ok) process.exitCode = 1;
      return report;
    }
    default:
      return runTool(command, rest);
  }
}

main(process.argv.slice(2)).then(
  (output) => {
    console.log(output);
  },
  (error) => {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
    } else {
      // A ToolError carries its whole message. Anything else is a bug, so keep the stack.
      console.error(error instanceof ToolError ? error.message : error);
      process.exitCode = 1;
    }
  }
);
