#!/usr/bin/env node
/**
 * Stands in for the Claude Code executable in the benchmark tests. It reads
 * the arguments the benchmark passes, acts on the working directory as
 * FAKE_AGENT says, and prints stream-json events the way Claude Code does.
 *
 *   FAKE_AGENT=solve        carry out a "Rename the function `a` ... to `b`" prompt with a text replace
 *   FAKE_AGENT=idle         change nothing
 *   FAKE_AGENT=break        leave a file the stand-in compiler rejects
 *   FAKE_AGENT=crash        start to work and exit before reporting a result
 *   FAKE_AGENT=unreachable  get no answer from the model, as when the API turns the request down
 *   FAKE_AGENT=cutoff       start to work, and have the API turn the next request down for a rate limit
 *   FAKE_AGENT=overlong     start to work, and have the API turn the next request down as too long,
 *                           in the words of FAKE_TOO_LONG where that is set
 *   FAKE_AGENT=oversized    start to work, and have the API turn the next request down with a 413, in other words
 *   FAKE_AGENT=capped       start to work, and have the API turn the next request down for a spending limit
 *   FAKE_AGENT=dropped      start to work, and get no answer to the next request at all
 *   FAKE_AGENT=stalled      get no answer either, and wait for one until told to stop
 *   FAKE_AGENT=stalled-later  start to work, get no answer to the next request, and ask again until told to stop
 *   FAKE_AGENT=linger       start a command that would write the file "lingered" later, and finish while it runs
 *   FAKE_AGENT=busy         start the same command and work on until told to stop, as Claude Code does on Ctrl-C
 *   FAKE_AGENT=hang         start the same command, never finish, and take no telling
 *   FAKE_AGENT=wreck        delete elm.json, so that what is left cannot even be read
 *   FAKE_AGENT=unreadable   delete what makes the directory a checkout, so that git cannot say what changed
 *   FAKE_AGENT=leaky        behave like a session that read the project's instruction file
 *   FAKE_AGENT=nosy         behave like a session that was handed every instruction file in its directory
 *   FAKE_AGENT=personal     behave like a session that was handed the CLAUDE.md of the user's settings, and name its
 *                           whole path when the isolation check asks for paths
 *   FAKE_AGENT=personal-home   name that path from ~ instead
 *   FAKE_AGENT=named        name the path in FAKE_AGENT_NAMED when the isolation check asks for paths
 *   FAKE_AGENT=remembering  report a memory directory
 *   FAKE_AGENT=serverless   report that its MCP servers failed to start
 *   FAKE_AGENT=starting     report that its MCP servers were still starting
 *   FAKE_AGENT=overequipped report a tool that no arm is given, in every session
 *   FAKE_AGENT=equipped-later  report such a tool in the sessions that work on a task
 *   FAKE_AGENT=equipped-busy   report such a tool in those sessions, and work on like busy
 *   FAKE_AGENT=served       report the language server and one of its tools in every session, asked for or not
 *   FAKE_AGENT=toolless     report the language server as connected, and none of its tools
 *   FAKE_AGENT=foreign      report an MCP server that no arm is given, still starting and with no tools yet, in every session
 *   FAKE_AGENT=foreign-later   report such a server in the sessions that work on a task
 *   FAKE_AGENT=plugged      report a plugin that is not built into Claude Code, in every session
 *   FAKE_AGENT=plugged-later   report such a plugin in the sessions that work on a task
 *
 * FAKE_AGENT_VERSION is the version of Claude Code that every session reports, and
 * FAKE_AGENT_VERSION_LATER the one that the sessions that work on a task report.
 * FAKE_AGENT_STARTED names a file where each session notes the arguments it was
 * started with, the names of its environment variables and the value of
 * CLAUDE_CODE_EFFORT_LEVEL, one line each.
 */

import { spawn } from "child_process";
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const valueOf = (flag) => args[args.indexOf(flag) + 1];
const prompt = valueOf("--print");
const { mcpServers } = JSON.parse(valueOf("--mcp-config"));
const emit = (event) => console.log(JSON.stringify(event));

if (process.env.FAKE_AGENT_STARTED) {
  const started = { args, variables: Object.keys(process.env).sort(), effortLevel: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null };
  appendFileSync(process.env.FAKE_AGENT_STARTED, `${JSON.stringify(started)}\n`);
}

function elmFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? elmFiles(join(dir, entry.name)) : entry.name.endsWith(".elm") ? [join(dir, entry.name)] : []
  );
}

// The benchmark's isolation check asks which planted words the session can see.
// That session only answers, whatever the mode says about the others.
const isIsolationCheck = prompt.includes("SENTINEL");
const mode = process.env.FAKE_AGENT;
const work = isIsolationCheck ? "answer" : mode;
const version = (!isIsolationCheck && process.env.FAKE_AGENT_VERSION_LATER) || process.env.FAKE_AGENT_VERSION;
emit({
  type: "system",
  subtype: "init",
  ...(version ? { claude_code_version: version } : {}),
  tools: [
    ...valueOf("--tools").split(",").filter(Boolean),
    ...(mode === "overequipped" || (["equipped-later", "equipped-busy"].includes(mode) && !isIsolationCheck) ? ["WebSearch"] : []),
    // A server that is connected hands the session its tools
    ...(mode === "served" ? ["mcp__elm-lsp__elm_symbols"] : []),
    ...(["served", "serverless", "starting", "toolless"].includes(mode) ? [] : Object.keys(mcpServers).map((name) => `mcp__${name}__elm_symbols`)),
  ],
  mcp_servers: [
    ...(mode === "served"
      ? [{ name: "elm-lsp", status: "connected" }]
      : Object.keys(mcpServers).map((name) => ({ name, status: { serverless: "failed", starting: "pending" }[mode] ?? "connected" }))),
    ...(mode === "foreign" || (mode === "foreign-later" && !isIsolationCheck) ? [{ name: "someones-server", status: "pending" }] : []),
  ],
  // Claude Code 2.1.311 lists the plugins it has built in like this, whatever the setup
  plugins: [
    { name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" },
    ...(mode === "plugged" || (mode === "plugged-later" && !isIsolationCheck)
      ? [{ name: "someones-plugin", path: "/somewhere/plugins/someones-plugin", source: "someones-plugin@somewhere" }]
      : []),
  ],
  ...(mode === "remembering" ? { memory_paths: { auto: "/somewhere/memory/" } } : {}),
});

// Where the session finds itself, and what lies beside its checkout, for a test that looks at both
if (process.env.FAKE_AGENT_PLACES && !isIsolationCheck) {
  appendFileSync(process.env.FAKE_AGENT_PLACES, `${JSON.stringify({ cwd: process.cwd(), beside: readdirSync("..") })}\n`);
}

const toolUse = (name) => emit({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });
const result = (fields) =>
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    total_cost_usd: 0.25,
    duration_api_ms: 1200,
    num_turns: 3,
    usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 40 },
    ...fields,
  });

// The events of Claude Code 2.1.311 for a request that the API turned down, after `turns` that went well
function turnedDown(status, error, said, turns) {
  emit({
    type: "assistant",
    message: { model: "<synthetic>", content: [{ type: "text", text: said }] },
    error,
    is_api_error_message: true,
    api_error_status: status,
  });
  result({ is_error: true, terminal_reason: "api_error", api_error_status: status, result: said, total_cost_usd: 0.05 * turns, num_turns: turns + 1 });
  process.exit(1);
}
const RATE_LIMITED = [429, "rate_limit", "API Error: Request rejected (429) · the stand-in is rate limited"];
if (work === "unreachable") turnedDown(...RATE_LIMITED, 0);
if (["cutoff", "overlong", "oversized", "capped", "dropped"].includes(work)) {
  toolUse("Read");
  emit({ type: "system", subtype: "api_retry", attempt: 1 });
  if (work === "cutoff") turnedDown(...RATE_LIMITED, 1);
  // The API answers 400 to both of these, and only what it says tells them apart
  if (work === "overlong") turnedDown(400, "invalid_request", process.env.FAKE_TOO_LONG ?? "Prompt is too long", 1);
  // A status that says it all, in words that do not
  if (work === "oversized") turnedDown(413, "invalid_request", "API Error: 413 · the stand-in sent more than it may", 1);
  if (work === "capped") turnedDown(400, "invalid_request", "API Error: 400 · the stand-in has reached its specified usage limits", 1);
  // A connection that broke: an end on an API error with nothing to show for it
  result({ is_error: true, terminal_reason: "api_error", result: "", total_cost_usd: 0.05, num_turns: 2 });
  process.exit(1);
}
if (work === "stalled" || work === "stalled-later") {
  const turns = work === "stalled" ? 0 : 1;
  if (turns > 0) {
    toolUse("Read");
    emit({ type: "system", subtype: "api_retry", attempt: 1 });
    emit({ type: "system", subtype: "api_retry", attempt: 2 });
  }
  const waiting = setInterval(() => {}, 1000);
  await new Promise((resolve) => process.once("SIGINT", resolve));
  clearInterval(waiting);
  result({ subtype: "error_during_execution", is_error: true, result: "", total_cost_usd: 0.05 * turns, num_turns: turns });
  process.exit(0);
}
if (work === "crash") {
  toolUse("Bash");
  process.exit(1);
}
if (["linger", "busy", "equipped-busy", "hang"].includes(work)) {
  toolUse("Bash");
  // Like a command of Claude Code's shell tool: a process group of its own. It would write its file three seconds from now.
  const later = `setTimeout(() => require("fs").writeFileSync("lingered", ""), 3000)`;
  const shellCommand = spawn(process.execPath, ["-e", later], { stdio: "inherit", detached: true });
  const keepBusy = setInterval(() => {}, 1000);
  if (work === "linger") {
    // The session is over while its command is still running
    await new Promise((resolve) => setTimeout(resolve, 1500));
    clearInterval(keepBusy);
    shellCommand.unref();
  } else if (work !== "hang") {
    await new Promise((resolve) => process.once("SIGINT", resolve));
    process.kill(-shellCommand.pid, "SIGKILL");
    clearInterval(keepBusy);
    result({ subtype: "error_during_execution", is_error: true, result: "" });
    process.exit(0);
  } else {
    process.on("SIGINT", () => {});
    process.on("SIGTERM", () => {});
    await new Promise(() => {});
  }
}

if (work === "solve") {
  const [, from, to] = /Rename the function `(\w+)`[^]*? to `(\w+)`/.exec(prompt);
  toolUse(mcpServers["elm-lsp"] ? "mcp__elm-lsp__elm_rename_function" : "Bash");
  for (const file of elmFiles("src")) {
    writeFileSync(file, readFileSync(file, "utf-8").replaceAll(new RegExp(`\\b${from}\\b`, "g"), to));
  }
} else if (work === "break") {
  toolUse("Edit");
  writeFileSync("src/Main.elm", `${readFileSync("src/Main.elm", "utf-8")}\n-- BROKEN\n`);
} else if (work === "wreck") {
  toolUse("Bash");
  rmSync("elm.json");
} else if (work === "unreadable") {
  toolUse("Bash");
  rmSync(".git");
}

// What a session that loaded every file of instructions in its directory would have been told
function planted(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? planted(join(dir, entry.name)) : (readFileSync(join(dir, entry.name), "utf-8").match(/\w+SENTINEL/g) ?? [])
  );
}
// Claude Code names the path of each instruction file it hands a session, and the user's lies in its configuration directory
const personal = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "CLAUDE.md");
const askedForPaths = prompt.includes("path");
const overheard =
  {
    leaky: () => "PROJECTSENTINEL",
    nosy: () => planted(".").join(" "),
    personal: () => (askedForPaths ? personal : "NONE"),
    "personal-home": () => (askedForPaths ? personal.replace(homedir(), "~") : "NONE"),
    named: () => (askedForPaths ? process.env.FAKE_AGENT_NAMED : "NONE"),
  }[mode]?.() ?? "NONE";
result({ result: isIsolationCheck ? overheard : "Done." });
