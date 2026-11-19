/**
 * Running the agent: one headless Claude Code session per task, with or
 * without the Elm language server, and nothing else from the machine's setup.
 */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { createWriteStream, lstatSync, readFileSync, readlinkSync, statSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { findHarness, installAt, SERVER_NAME } from "../../mcp-wrapper/harnesses.mjs";
import { RUST_LSP_PATH } from "../../mcp-wrapper/lsp-client.mjs";
import { OWN_SETTINGS, ownEnvironment } from "./git.mjs";
import { Interrupted, runGroup } from "./process.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The same built-in tools for both arms, named when a session starts: what it reads, searches and edits files with
export const BUILT_IN_TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob"];

// A run works in a worktree, which shares its repository with the original
// checkout: branches, tags, the stash, the configuration and the remotes are
// the operator's. Denying these subcommands catches the plain way of writing
// to them. It is a guard against accidents, not a sandbox: the agent still
// has a shell.
const FORBIDDEN = [
  ...["commit", "merge", "rebase", "cherry-pick", "revert", "am", "reset", "checkout", "switch"],
  ...["branch", "tag", "stash", "notes", "update-ref", "replace", "config", "remote", "worktree"],
  ...["push", "fetch", "pull", "gc", "prune"],
].map((subcommand) => `Bash(git ${subcommand} *)`);

// The language server as a Claude Code user registers it, plus --project-tools:
// the codebases are the operator's own, and the server must use the compiler
// each of them pins, the same one the check command runs.
function languageServer() {
  const { command, args } = findHarness("claude-code").config(installAt(REPO_ROOT)).mcpServers[SERVER_NAME];
  return { [SERVER_NAME]: { command, args: [...args, "--project-tools"] } };
}

// What the binary of the language server is built from, as git pathspecs. The programs under
// src/bin are binaries of their own, and an edit to one of them leaves the server as it was.
const BINARY_SOURCES = ["src", ":(exclude)src/bin", "Cargo.toml", "Cargo.lock"];

// What the language server is made of: the binary and the wrapper that runs it. A change to anything
// else in this checkout, a document for one, leaves it the server it was, and a run that was started
// with it can go on.
const SERVER_SOURCES = [...BINARY_SOURCES, "mcp-wrapper"];

// What the benchmark is made of: the code that picks the tasks, runs the sessions and judges them, and
// the modules of the wrapper that it imports. workspace.mjs decides which source directories and entry
// files count, harnesses.mjs how a command is quoted and how the server is registered, lsp-client.mjs
// where the binary lies, and doctor.mjs whether the binary answers.
export const BENCHMARK_SOURCES = [
  "benchmarks/bench.mjs",
  "benchmarks/lib",
  "mcp-wrapper/doctor.mjs",
  "mcp-wrapper/errors.mjs",
  "mcp-wrapper/harnesses.mjs",
  "mcp-wrapper/lsp-client.mjs",
  "mcp-wrapper/workspace.mjs",
];

// What git prints in `root`, and nothing of what it says about it. Throws where `root` is no git checkout.
const gitOutput = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", env: ownEnvironment(), stdio: ["ignore", "pipe", "ignore"], maxBuffer: 2 ** 28 });

/**
 * The state of some paths of a git checkout in a few words: the last commit
 * that changed them, and a digest of the files that differ from it there, so
 * that two different edits are two states. A file counts by what it holds and
 * not by how git shows the change, which the operator's settings decide. One
 * that was written again with the bytes it had is no change. A file that git
 * does not track counts too, unless git ignores it: a new module that a
 * tracked one imports is code that runs. A directory that is a repository of
 * its own counts by its name, since git lists it and none of its files. Null
 * where `root` is no git checkout.
 * @param {string} root
 * @param {string[]} paths  Relative to `root`, as git pathspecs: ":(exclude)dir" leaves a directory out
 */
export function stateOfSources(root, paths) {
  try {
    const git = (...args) => gitOutput(root, ...OWN_SETTINGS, ...args);
    const listed = (...args) => git(...args, "--", ...paths).split("\0").filter(Boolean);
    // The whole name of the commit: how many letters git shortens one to is a setting, and grows with the repository.
    // "git log" takes settings of its own, and with log.showSignature it prints a line about the signature first.
    const commit = git("rev-list", "-1", "HEAD", "--", ...paths).trim();
    // Both lists name a file from `root`. A renamed file is the old one gone and a new one there.
    const changed = new Set([
      ...listed("diff", "--name-only", "-z", "--no-renames", "--relative", "HEAD"),
      ...listed("ls-files", "-z", "--others", "--exclude-standard"),
    ]);
    if (changed.size === 0) return commit;

    const digest = createHash("sha256");
    for (const file of [...changed].sort()) {
      const path = join(root, file);
      const entry = lstatSync(path, { throwIfNoEntry: false });
      // What the file is, with its mode, and what it holds. A file that was deleted is none.
      if (entry?.isSymbolicLink()) digest.update(`\0${file}\0link\0`).update(readlinkSync(path));
      else if (entry?.isFile()) digest.update(`\0${file}\0${entry.mode & 0o111 ? "program" : "file"}\0`).update(readFileSync(path));
      else digest.update(`\0${file}\0${entry ? "directory" : "none"}\0`);
    }
    return `${commit}, with uncommitted changes ${digest.digest("hex").slice(0, 8)}`;
  } catch {
    return null;
  }
}

/**
 * Which language server the lsp arm runs: the version of this checkout with
 * the state of its sources, where git knows one. A binary older than its
 * sources does not run, so a build of the same sources is the same server.
 */
export function languageServerVersion() {
  const { version } = JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf-8"));
  const sources = stateOfSources(REPO_ROOT, SERVER_SOURCES);
  return sources === null ? version : `${version} (${sources})`;
}

/** When the binary of the language server was built, for the record. Null where there is none. */
export function languageServerBuilt() {
  const binary = statSync(RUST_LSP_PATH, { throwIfNoEntry: false });
  return binary ? `${binary.mtime.toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

/**
 * How the binary of the language server stands to the files it was built
 * from. Cargo names those files in a dependency file beside the binary. A
 * module that git does not track is among them where a tracked one declares
 * it, and the other binaries under `src/bin` are not. `newer` is the newest of
 * them that was written after the binary, which is then of older sources than
 * the checkout holds, and null where none was.
 * Cargo.toml and Cargo.lock do not count. Cargo builds again when a source is
 * newer than the binary, and goes by what the manifest and the lock file say
 * and not by when they were written. A checkout of another branch and back
 * writes them again, and scripts/setup.sh then leaves the binary as it was.
 * `unknown` takes the place of `newer` where the sources cannot be told:
 * "unbuilt" where the binary is missing, "unlisted" where its dependency file
 * is, and "gone" where none of the files that it names is there any more, as
 * after the checkout was moved.
 * @returns {{ newer: string | null } | { unknown: "unbuilt" | "unlisted" | "gone" }}
 */
export function serverBuild() {
  const binary = statSync(RUST_LSP_PATH, { throwIfNoEntry: false });
  if (!binary) return { unknown: "unbuilt" };
  let rule;
  try {
    rule = readFileSync(`${RUST_LSP_PATH}.d`, "utf-8").split("\n")[0];
  } catch {
    return { unknown: "unlisted" };
  }
  // One rule in the manner of a makefile: the binary, a colon, and the whole path of each file it
  // was built from, with a backslash in front of a space in a path
  const words = (rule.match(/(?:\\ |\S)+/g) ?? []).map((word) => word.replaceAll("\\ ", " "));
  const colon = words.findIndex((word) => word.endsWith(":"));
  let there = 0;
  let newer = null;
  let written = binary.mtimeMs;
  for (const file of colon === -1 ? [] : words.slice(colon + 1).map((word) => resolve(REPO_ROOT, word))) {
    if (["Cargo.toml", "Cargo.lock"].includes(basename(file))) continue;
    // A file that was deleted has nothing to build from, and the module that declared it changed
    const entry = statSync(file, { throwIfNoEntry: false });
    if (entry) there++;
    if (entry && entry.mtimeMs > written) [newer, written] = [relative(REPO_ROOT, file), entry.mtimeMs];
  }
  return there === 0 ? { unknown: "gone" } : { newer };
}

/** Which benchmark judges the sessions: the state of its own sources. Two states can judge one result differently. */
export const benchmarkVersion = () => stateOfSources(REPO_ROOT, BENCHMARK_SOURCES) ?? "no git checkout";

/**
 * The two conditions that are compared. They differ in one thing only, whether
 * the session has the language server. The server hands it its MCP tools and
 * a few notes on how to call them.
 */
export const ARMS = {
  baseline: { title: "Without language server", mcpServers: {} },
  lsp: { title: "With language server", mcpServers: languageServer() },
};

// The levels of effort that Claude Code 2.1.311 takes for --effort
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

function claudeArguments({ prompt, model, effort, arm, tools, maxBudgetUsd }) {
  const { mcpServers } = ARMS[arm];
  const allowed = [...tools, ...Object.keys(mcpServers).map((server) => `mcp__${server}`)];
  return [
    "--print",
    prompt,
    "--model",
    model,
    ...(effort ? ["--effort", effort] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    // No user or project settings: no plugins, hooks, skills or instruction files of the person running this
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers }),
    "--tools",
    tools.join(","),
    ...(allowed.length > 0 ? ["--allowedTools", ...allowed] : []),
    "--disallowedTools",
    ...FORBIDDEN,
    "--max-budget-usd",
    String(maxBudgetUsd),
  ];
}

// What a Claude Code session sets for the commands it runs, as Claude Code 2.1.311 does. A benchmark
// that an agent started would hand them on to every session, which would then run as the child of
// another session, and not as one started from a plain shell. How Claude Code signs in and which
// provider it uses are told by other variables, which stay.
const PARENT_SESSION = [
  "CLAUDECODE",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
];

// How hard the model thinks. A run is held to the effort it names, or to the default of Claude Code
// for its model where it names none, and not to what the shell that started it happens to set.
const EFFORT = ["CLAUDE_CODE_EFFORT_LEVEL", "MAX_THINKING_TOKENS"];

// All worktrees of a repository share one auto memory directory, the operator's
// own. With it on, a session could read what an earlier one noted, and leave
// notes behind in the operator's memory. No command-line flag turns it off.
// And a run is held to the version of Claude Code that its first session
// reported, which an update in the background of a session would change. The
// operator's settings cannot turn that off here, since a session reads none.
function sessionEnvironment(effort) {
  const environment = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1" };
  for (const name of [...PARENT_SESSION, ...EFFORT]) delete environment[name];
  // The variable takes precedence over --effort in a session, so it says the same
  return effort ? { ...environment, CLAUDE_CODE_EFFORT_LEVEL: effort } : environment;
}

/** Start the lsp arm's MCP command, as a session does, before any session is paid for. */
export async function assertMcpServer({ cwd = REPO_ROOT, timeoutMs = 10000, mcpServers = ARMS.lsp.mcpServers } = {}) {
  for (const [name, { command, args }] of Object.entries(mcpServers)) {
    let send;
    // The id of the request whose answer is awaited: 1 for initialize, 2 for tools/list, null once a tool is listed
    let awaited = 1;
    let problem = null;
    const request = (id, method, params = {}) => send({ jsonrpc: "2.0", id, method, params });
    let result;
    try {
      result = await runGroup([command, ...args], {
        cwd,
        env: sessionEnvironment(),
        timeoutMs,
        graceMs: 200,
        onStart(input) {
          send = (message) => input.write(`${JSON.stringify(message)}\n`);
          request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "elm-benchmark", version: "1" } });
        },
        onLine(line, end) {
          let message = null;
          try {
            message = JSON.parse(line);
          } catch {
            // No JSON, and so no JSON-RPC message either
          }
          if (message?.jsonrpc !== "2.0") problem = "sent something other than a JSON-RPC message";
          // A notification, a request of the server's own such as ping, or an answer to another request
          // than the one awaited. Once a tool is listed, nothing is awaited, and the id null answers nothing.
          else if (awaited === null || message.method !== undefined || message.id !== awaited) return;
          else if (message.error) problem = `refused ${awaited === 1 ? "initialize" : "tools/list"}`;
          else if (awaited === 1) {
            awaited = 2;
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            request(2, "tools/list");
            return;
          } else {
            const offered = Array.isArray(message.result?.tools) ? message.result.tools : [];
            if (offered.some((tool) => typeof tool?.name === "string" && tool.name.length > 0)) awaited = null;
            else problem = "listed no tools";
          }
          end();
        },
      });
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      throw new Error(`The lsp arm's MCP server "${name}" could not start. ${error.message}`);
    }
    if (result.timedOut || problem || awaited !== null) {
      const reason = result.timedOut ? `did not answer initialize and tools/list within ${timeoutMs} ms` : (problem ?? `ended before it answered initialize and tools/list (exit ${result.code})`);
      throw new Error(`The lsp arm's MCP server "${name}" ${reason}. No session was started.`);
    }
  }
}

// What a run calls the agent of its sessions. Claude Code names its version in the first event of a
// session, and a stand-in may name none.
export const agentName = (version) => (version ? `Claude Code ${version}` : "an agent that names no version");

// Claude Code reports a failed API request as a message of its own, in the model's place
const isOwnWords = (event) => event.is_api_error_message === true || event.message?.model === "<synthetic>";

// And it says so each time it asks the API again for an answer that did not come
const isRetry = (event) => event.type === "system" && event.subtype === "api_retry";

/**
 * What one session did, read from Claude Code's stream-json events.
 * `finished` is false when the session ended without a result event or with
 * an error. `replies` counts the model's messages: a session without one
 * never got to work, as when the API turns the first request down.
 * `lspStatus`, `lspTools`, `memoryOff`, `strayTools`, `strayServers`,
 * `strayPlugins` and `agentVersion` are null when the session never got as
 * far as its first event, which describes its setup.
 * @param {object[]} events
 * @param {string[]} [given]  The built-in tools the session was started with
 * @param {string} [arm]  The arm it ran in. Only the lsp arm is given the language server's tools.
 */
export function summarizeTranscript(events, given = BUILT_IN_TOOLS, arm) {
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const result = events.find((event) => event.type === "result");
  const toolCalls = {};
  let replies = 0;
  for (const event of events) {
    if (event.type !== "assistant" || isOwnWords(event)) continue;
    replies++;
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use") {
        toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
      }
    }
  }

  // Claude Code 2.1.311 ends a session over its budget with is_error and the subtype "error_max_budget_usd".
  // Its other subtypes that begin with "error_" are not known to come with is_error, so those count on their own.
  const failed = result?.is_error === true || /^error_/.test(result?.subtype ?? "");
  const usage = result?.usage ?? {};
  const lspPrefix = `mcp__${SERVER_NAME}__`;
  const lspCalls = Object.entries(toolCalls)
    .filter(([name]) => name.startsWith(lspPrefix))
    .reduce((total, [, count]) => total + count, 0);
  return {
    finished: result !== undefined && !failed,
    stopReason: result?.subtype ?? "no result",
    // True when the session ended on a request that the API did not answer, or turned down
    endedOnApiError: result?.terminal_reason === "api_error" || (result?.api_error_status ?? null) !== null,
    // The HTTP status of the API error that ended the session, if one did and had one
    apiErrorStatus: result?.api_error_status ?? null,
    // How often Claude Code had to ask the API again, which tells a session that waited from one that worked slowly
    apiRetries: events.filter(isRetry).length,
    // True when the session's last request was never answered: Claude Code asked again, and no word of the model followed
    waitingForApi: events.findLastIndex(isRetry) > events.findLastIndex((event) => event.type === "assistant" && !isOwnWords(event)),
    // What Claude Code said about a session that ended on an error, as far as it said anything
    failureText: failed && typeof result.result === "string" && result.result !== "" ? result.result : null,
    replies,
    agentVersion: init?.claude_code_version ?? null,
    // The first event names the memory directories the session loads from. The
    // field is not part of Claude Code's documented output: without it, the
    // session counts as having none.
    memoryOff: init ? Object.keys(init.memory_paths ?? {}).length === 0 : null,
    // "connected", "failed", "pending" while it was still starting, or "absent"
    lspStatus: init ? ((init.mcp_servers ?? []).find((server) => server.name === SERVER_NAME)?.status ?? "absent") : null,
    // How many of the language server's tools the session was handed. A server can be connected and hand over none.
    lspTools: init ? (init.tools ?? []).filter((tool) => tool.startsWith(lspPrefix)).length : null,
    // Tools that the session was not given: neither built in for it, nor the language server's in the arm that has it
    strayTools: init ? (init.tools ?? []).filter((tool) => !given.includes(tool) && !(arm === "lsp" && tool.startsWith(lspPrefix))) : null,
    // MCP servers other than the language server in the arm that has it, whatever their status. One that is
    // still starting lists no tools yet, and can hand some over later.
    strayServers: init ? (init.mcp_servers ?? []).map((server) => server.name).filter((name) => !(arm === "lsp" && name === SERVER_NAME)) : null,
    // Plugins beyond the ones that Claude Code has built in, which the first event lists with "builtin" for their path
    strayPlugins: init ? (init.plugins ?? []).filter((plugin) => plugin.path !== "builtin").map((plugin) => plugin.name ?? "without a name") : null,
    costUsd: result?.total_cost_usd ?? null,
    apiMs: result?.duration_api_ms ?? null,
    turns: result?.num_turns ?? null,
    inputTokens:
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    // Also on their own. The arms have different tools and so a cached prompt each, and whether a session
    // finds its arm's still there depends on how long the other arm's sessions took since one of its own ran
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    toolCalls,
    lspCalls,
  };
}

/**
 * Run one session in `cwd` and wait for it to end, with every process it
 * started. Rejects when the session cannot be started or was interrupted.
 * @param {object} options
 * @param {string[]} options.command  The Claude Code executable, as argv. Tests pass a stand-in.
 * @param {string} [options.effort]  One of EFFORT_LEVELS, or none for the default of Claude Code for the model
 * @param {string[]} [options.tools]  Built-in tools of the session. Both arms get the same ones.
 * @param {string} options.transcriptPath  Every event is appended here as it arrives
 * @param {number} [options.graceMs]  How long a session over its time limit has to end by itself
 * @param {(session: ReturnType<typeof summarizeTranscript>) => boolean} [options.stopIf]  Asked once the
 *   session's first event is there, which describes its setup. True ends the session at that point.
 * @returns {Promise<ReturnType<typeof summarizeTranscript> & { wallMs: number, timedOut: boolean }>}
 */
export async function runAgent({ command, cwd, prompt, model, effort, arm, tools = BUILT_IN_TOOLS, maxBudgetUsd, timeoutMs, transcriptPath, graceMs, stopIf }) {
  const started = Date.now();
  const transcript = createWriteStream(transcriptPath);
  // A transcript that cannot be written fails the session below, where it can be caught
  let unwritten = null;
  transcript.on("error", (error) => {
    unwritten ??= error;
  });
  const events = [];
  try {
    const { timedOut } = await runGroup([...command, ...claudeArguments({ prompt, model, effort, arm, tools, maxBudgetUsd })], {
      cwd,
      env: sessionEnvironment(effort),
      timeoutMs,
      stderr: "inherit",
      // As Ctrl-C does in a terminal: Claude Code ends the turn and its shell commands, and reports the cost so far
      ask: "SIGINT",
      graceMs,
      onLine(line, end) {
        transcript.write(`${line}\n`);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          // Not an event. The line is still in the transcript.
          return;
        }
        events.push(event);
        if (event.type === "system" && event.subtype === "init" && stopIf?.(summarizeTranscript(events, tools, arm))) end();
      },
    });
    if (unwritten) throw new Error(`Could not write ${transcriptPath}: ${unwritten.message}`);
    return { ...summarizeTranscript(events, tools, arm), wallMs: Date.now() - started, timedOut };
  } finally {
    await new Promise((resolve) => (transcript.destroyed ? resolve() : transcript.end(resolve)));
  }
}
