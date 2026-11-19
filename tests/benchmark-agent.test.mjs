/**
 * Tests of the parts of benchmarks/lib/agent.mjs that need no session, such as
 * how a transcript is condensed into the session's figures. They start no
 * process and read no clock.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "fs";
import { dirname, join, relative } from "path";
import { BENCHMARK_SOURCES, summarizeTranscript } from "../benchmarks/lib/agent.mjs";
import { REPO } from "./support.mjs";
import { BENCH } from "./benchmark-support.mjs";

const toolUse = (name) => ({ type: "assistant", message: { content: [{ type: "text", text: "On it." }, { type: "tool_use", name }] } });

test("a transcript is condensed into the session's figures", () => {
  const events = [
    {
      type: "system",
      subtype: "init",
      claude_code_version: "2.1.0",
      tools: ["Bash", "mcp__elm-lsp__elm_references", "mcp__elm-lsp__elm_rename_function"],
      mcp_servers: [{ name: "elm-lsp", status: "connected" }],
      plugins: [{ name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" }],
    },
    toolUse("Bash"),
    toolUse("mcp__elm-lsp__elm_references"),
    toolUse("mcp__elm-lsp__elm_rename_function"),
    // Claude Code had to ask the API a second time for the next answer
    { type: "system", subtype: "api_retry", attempt: 1 },
    toolUse("Bash"),
    {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.4,
      duration_api_ms: 9000,
      num_turns: 5,
      usage: { input_tokens: 7, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 60 },
    },
  ];
  assert.deepEqual(summarizeTranscript(events, undefined, "lsp"), {
    finished: true,
    stopReason: "success",
    endedOnApiError: false,
    apiErrorStatus: null,
    apiRetries: 1,
    waitingForApi: false,
    failureText: null,
    replies: 4,
    agentVersion: "2.1.0",
    memoryOff: true,
    lspStatus: "connected",
    lspTools: 2,
    strayTools: [],
    strayServers: [],
    strayPlugins: [],
    costUsd: 0.4,
    apiMs: 9000,
    turns: 5,
    inputTokens: 2107,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 2000,
    outputTokens: 60,
    toolCalls: { Bash: 2, "mcp__elm-lsp__elm_references": 1, "mcp__elm-lsp__elm_rename_function": 1 },
    lspCalls: 2,
  });

  // A session that was killed has no result event
  const killed = summarizeTranscript([{ type: "system", subtype: "init", mcp_servers: [] }, toolUse("Bash")]);
  assert.equal(killed.finished, false);
  assert.equal(killed.stopReason, "no result");
  assert.equal(killed.lspStatus, "absent");
  assert.equal(killed.costUsd, null);

  // Claude Code was asking the API again when the session ended, at the first request or a later one.
  // An answer that came after all ends the wait.
  const started = { type: "system", subtype: "init" };
  const askedAgain = { type: "system", subtype: "api_retry", attempt: 1 };
  assert.equal(summarizeTranscript([started, askedAgain]).waitingForApi, true);
  assert.equal(summarizeTranscript([started, toolUse("Read"), askedAgain, askedAgain]).waitingForApi, true);
  assert.equal(summarizeTranscript([started, askedAgain, toolUse("Read")]).waitingForApi, false);
  // What Claude Code says in the model's place, about a request it gave up on, is no answer
  const gaveUp = { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] }, is_api_error_message: true };
  assert.equal(summarizeTranscript([started, toolUse("Read"), askedAgain, gaveUp]).waitingForApi, true);

  // A session that never started cannot say which servers it had
  const overBudget = summarizeTranscript([{ type: "result", subtype: "error_max_budget_usd", is_error: true }]);
  assert.equal(overBudget.finished, false);
  assert.equal(overBudget.stopReason, "error_max_budget_usd");
  assert.deepEqual([overBudget.lspStatus, overBudget.memoryOff, overBudget.strayTools, overBudget.strayServers], [null, null, null, null]);
  // A subtype of an error ends the session on one, whatever is_error says
  const broken = summarizeTranscript([{ type: "system", subtype: "init" }, toolUse("Read"), { type: "result", subtype: "error_during_execution", is_error: false }]);
  assert.deepEqual([broken.finished, broken.stopReason], [false, "error_during_execution"]);

  // The API turned the first request down. Claude Code says so in a message of its own, which is no reply of the model.
  const refused = summarizeTranscript([
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: Request rejected (429)" }] },
      error: "rate_limit",
      is_api_error_message: true,
      api_error_status: 429,
    },
    { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", api_error_status: 429, num_turns: 1, total_cost_usd: 0, result: "API Error: Request rejected (429)" },
  ]);
  assert.deepEqual(
    [refused.finished, refused.replies, refused.endedOnApiError, refused.apiErrorStatus, refused.failureText],
    [false, 0, true, 429, "API Error: Request rejected (429)"]
  );
  // A connection that broke has no status to show for it
  const dropped = summarizeTranscript([{ type: "system", subtype: "init" }, toolUse("Read"), { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error" }]);
  assert.deepEqual([dropped.finished, dropped.replies, dropped.endedOnApiError, dropped.apiErrorStatus], [false, 1, true, null]);

  // A memory directory means the session reads and writes notes that outlive it
  const remembering = summarizeTranscript([{ type: "system", subtype: "init", memory_paths: { auto: "/home/me/.claude/projects/x/memory/" } }]);
  assert.equal(remembering.memoryOff, false);

  // Tools beyond the built-in ones that both arms are given are part of neither arm, and the language server's are part of one
  const overequipped = [{ type: "system", subtype: "init", tools: ["Bash", "Read", "Edit", "Write", "WebSearch", "mcp__elm-lsp__elm_symbols", "mcp__other__thing"] }];
  assert.deepEqual(summarizeTranscript(overequipped, undefined, "lsp").strayTools, ["WebSearch", "mcp__other__thing"]);
  assert.deepEqual(summarizeTranscript(overequipped, undefined, "baseline").strayTools, ["WebSearch", "mcp__elm-lsp__elm_symbols", "mcp__other__thing"]);
  // A session that was started without tools, as the isolation check is, has none to come up with
  assert.deepEqual(summarizeTranscript([{ type: "system", subtype: "init", tools: ["Bash"] }], []).strayTools, ["Bash"]);
  assert.deepEqual(summarizeTranscript([{ type: "system", subtype: "init", tools: ["mcp__elm-lsp__elm_symbols"] }], []).strayTools, ["mcp__elm-lsp__elm_symbols"]);
  assert.deepEqual(summarizeTranscript([{ type: "system", subtype: "init", tools: [] }], []).strayTools, []);
  // A server other than the arm's own is part of neither arm, also while it is still starting and has handed over no tool
  const hosted = [{ type: "system", subtype: "init", tools: ["Bash"], mcp_servers: [{ name: "elm-lsp", status: "connected" }, { name: "other", status: "pending" }] }];
  assert.deepEqual(summarizeTranscript(hosted, undefined, "lsp").strayServers, ["other"]);
  assert.deepEqual(summarizeTranscript(hosted, undefined, "baseline").strayServers, ["elm-lsp", "other"]);

  // A plugin that Claude Code has built in is part of every session. Any other comes from the machine's setup.
  const plugged = [{ type: "system", subtype: "init", plugins: [{ name: "cc-plugin-telemetry", path: "builtin" }, { name: "someones", path: "/home/me/.claude/plugins/someones" }] }];
  assert.deepEqual(summarizeTranscript(plugged).strayPlugins, ["someones"]);
  // A server can be connected and hand the session none of its tools
  const toolless = [{ type: "system", subtype: "init", tools: ["Bash"], mcp_servers: [{ name: "elm-lsp", status: "connected" }] }];
  assert.deepEqual([summarizeTranscript(toolless, undefined, "lsp").lspStatus, summarizeTranscript(toolless, undefined, "lsp").lspTools], ["connected", 0]);
});

test("every module of this repository that the benchmark imports counts toward the state of its code", () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const path = relative(REPO, file);
    assert.ok(BENCHMARK_SOURCES.some((source) => path === source || path.startsWith(`${source}/`)), `${path} is missing from BENCHMARK_SOURCES`);
    for (const match of readFileSync(file, "utf-8").matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
      visit(join(dirname(file), match[1]));
    }
  };
  visit(BENCH);
});
