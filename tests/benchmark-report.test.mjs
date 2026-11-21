/**
 * Tests of benchmarks/lib/report.mjs, which sums up the records of a run and
 * writes its report. They start no process and read no clock.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "fs";
import { join } from "path";
import { renderReport, summarize } from "../benchmarks/lib/report.mjs";
import { REPO } from "./support.mjs";

// `outcome` is one of the outcomes, or what stopped a failed session
const record = (arm, outcome, costUsd, wallMs, repetition = 1) => ({
  id: "private-id",
  task: "A/rename-function",
  codebase: "A",
  type: "rename-function",
  arm,
  repetition,
  model: "claude-opus-5-5",
  agentVersion: "2.1.0",
  languageServer: "0.3.39 (abcdef0)",
  outcome: ["time-limit", "budget-limit", "error"].includes(outcome) ? "agent-failed" : outcome,
  failure: ["time-limit", "budget-limit", "error"].includes(outcome) ? outcome : null,
  problems: ["src/Secret.elm does not declare hiddenName"],
  changedFiles: 3,
  wallMs,
  costUsd,
  turns: 4,
  toolCalls: { Bash: 2, "mcp__elm-lsp__elm_rename_function": arm === "lsp" ? 1 : 0 },
  lspCalls: arm === "lsp" ? 1 : 0,
  apiRetries: 0,
});

test("the summary counts and takes medians per arm, and leaves the codebase's names out", () => {
  const plan = { codebases: [{ label: "A", commit: "abc123", modules: 12, lines: 3400 }] };
  const summary = summarize(plan, [
    record("baseline", "passed", 0.2, 30000, 1),
    record("lsp", "passed", 0.1, 10000, 1),
    record("baseline", "does-not-compile", 0.6, 90000, 2),
    record("lsp", "passed", 0.3, 20000, 2),
    // Killed at its time limit, so it has a time and no cost
    record("baseline", "time-limit", null, 50000, 3),
    record("lsp", "passed", 0.5, 30000, 3),
    // The other arm has not done round 4 yet, so this session is in no figure
    record("baseline", "passed", 9, 999000, 4),
  ]);

  const endings = (counts) => ({
    passed: 0,
    "wrong-result": 0,
    "does-not-compile": 0,
    "time-limit": 0,
    "budget-limit": 0,
    error: 0,
    "server-failed": 0,
    ...counts,
  });
  assert.deepEqual(summary.overall, {
    baseline: {
      sessions: 3,
      solved: 1,
      endings: endings({ passed: 1, "does-not-compile": 1, "time-limit": 1 }),
      withoutCost: 1,
      costUsd: 0.4,
      wallMs: 50000,
      turns: 4,
      toolCalls: 2,
    },
    lsp: { sessions: 3, solved: 3, endings: endings({ passed: 3 }), withoutCost: 0, costUsd: 0.3, wallMs: 20000, turns: 4, toolCalls: 3 },
  });
  assert.equal(summary.unpaired, 1);
  assert.equal(summary.runs.length, 6);
  assert.deepEqual(summary.codebases, [{ label: "A", modules: 12, lines: 3400 }]);
  assert.equal(summary.taskTypes.length, 1);
  assert.equal(summary.taskTypes[0].lsp.solved, 3);

  const html = renderReport(summary);
  assert.match(html, /6 sessions in total\..*1 more session left out: the other arm has not done the same round of the same task yet\./);
  assert.match(html, /Ended without reporting a cost, and left out of the cost medians: 1 session without language server\./);
  // How the sessions of each arm ended, one column per ending
  assert.match(html, /Without language server<\/td>(<td class="number">\d<\/td>){7}<\/tr>/);
  assert.match(html, /Without language server<\/td><td class="number">1<\/td><td class="number">0<\/td><td class="number">1<\/td><td class="number">1<\/td>/);

  for (const secret of ["Secret", "hiddenName", "private-id", "abc123"]) {
    assert.ok(!(JSON.stringify(summary) + html).includes(secret), `${secret} stays out of the summary and the report`);
  }

  // Both arms were asked for and only one has run so far: its session waits, and no figure counts it
  const waiting = summarize(plan, [record("baseline", "passed", 0.2, 30000, 1)], ["baseline", "lsp"]);
  assert.deepEqual(
    [waiting.unpaired, waiting.runs.length, waiting.arms.map((arm) => arm.id), waiting.overall.lsp.sessions],
    [1, 0, ["baseline", "lsp"], 0]
  );
  assert.match(renderReport(waiting), /in 0 Elm codebases\. 0 sessions in total\..*1 more session left out/);
  // One arm alone was asked for, which the page says
  const alone = summarize(plan, [record("baseline", "passed", 0.2, 30000, 1)], ["baseline"]);
  assert.deepEqual([alone.unpaired, alone.runs.length], [0, 1]);
  assert.match(renderReport(alone), /Only one arm was run, so this page compares nothing\./);
  // That arm had no language server, so the page names none
  assert.ok(!renderReport(alone).includes("language server is"));
  assert.ok(!html.includes("Only one arm"));
});

test("the report states the headline figures and lists every session", () => {
  const plan = { codebases: [{ label: "A", commit: "abc123", modules: 12, lines: 3400 }] };
  const summary = summarize(plan, [record("baseline", "wrong-result", 0.25, 75000), { ...record("lsp", "passed", 0.125, 9000), apiRetries: 3 }]);
  const html = renderReport(summary);

  assert.match(
    html,
    /claude-opus-5-5 at Claude Code&#39;s default effort in Claude Code 2\.1\.0 worked on 1 kind of refactoring in 1 Elm codebase: A \(12 modules, 3,400 lines\)\. 2 sessions in total\. The language server is elm-lsp-rust 0\.3\.39 \(abcdef0\)\./
  );
  // The effort a run named is beside the model, and each one is named where the records differ
  const atHigh = summarize(plan, [record("baseline", "passed", 0.2, 30000), record("lsp", "passed", 0.1, 10000)].map((run) => ({ ...run, effort: "high" })));
  assert.deepEqual(atHigh.efforts, ["high"]);
  assert.match(renderReport(atHigh), /claude-opus-5-5 at effort high in Claude Code 2\.1\.0 worked on/);
  const mixed = summarize(plan, [{ ...record("baseline", "passed", 0.2, 30000), effort: "high" }, { ...record("lsp", "passed", 0.1, 10000), effort: null }]);
  assert.deepEqual(mixed.efforts, ["high", null]);
  assert.match(renderReport(mixed), /claude-opus-5-5 at effort high and Claude Code&#39;s default effort in Claude Code 2\.1\.0 worked on/);
  assert.match(html, /<span class="value">0 of 1<\/span>/);
  assert.match(html, /<span class="value">1 of 1<\/span>/);
  assert.match(html, /<td>Wrong result<\/td><td class="number">1 min 15 s<\/td><td class="number">\$0\.25<\/td>/);
  assert.match(html, /<td>Solved<\/td><td class="number">9 s<\/td><td class="number">\$0\.13<\/td>/);
  // How often a session had to ask the API again, which tells waiting from slow work
  assert.deepEqual(summary.runs.map((run) => run.apiRetries), [0, 3]);
  assert.match(html, /<th class="number">Files<\/th><th class="number">API retries<\/th><\/tr>/);
  assert.match(html, /<td>Solved<\/td>(<td class="number">[^<]+<\/td>){6}<td class="number">3<\/td><\/tr>/);
  // Every bar can be read without hovering: its value is printed at its tip and in its tooltip
  assert.match(html, /data-tip="Rename a function with a unique name · With language server · Median cost: \$0\.13 \(1 session\)"/);
  assert.match(html, /<text x="[\d.]+" y="[\d.]+">\$0\.13<\/text>/);
  assert.ok(!html.includes("left out") && !html.includes("without reporting a cost"), "notes appear only when they apply");
  // After a run of one codebase alone, the page names that one and not every codebase of the plan
  const both = { codebases: [...plan.codebases, { label: "B", commit: "def456", modules: 30, lines: 9000 }] };
  const one = summarize(both, [record("baseline", "passed", 0.2, 30000), record("lsp", "passed", 0.1, 10000)]);
  assert.deepEqual(one.codebases, [{ label: "A", modules: 12, lines: 3400 }]);
  assert.match(renderReport(one), /worked on 1 kind of refactoring in 1 Elm codebase: A \(12 modules, 3,400 lines\)\. 2 sessions in total\./);

  // A failed session is listed by what stopped it
  const failed = renderReport(
    summarize(plan, [record("baseline", "budget-limit", 5, 75000), record("lsp", "error", 0.4, 9000)])
  );
  assert.match(failed, /<td>Out of budget<\/td>/);
  assert.match(failed, /<td>Session error<\/td>/);

  // Sessions of several minutes get a time axis in minutes, like the labels at their bars
  const long = renderReport(summarize(plan, [record("baseline", "passed", 1, 300000), record("lsp", "passed", 1, 200000)]));
  assert.match(long, />5 min 0 s<\/text>/);
  assert.match(long, />2 min<\/text>.*>4 min<\/text>.*>6 min<\/text>/);
  assert.ok(!/>\d+ s<\/text>/.test(long.replace(/>0 s<\/text>/g, "")), "no tick in seconds beside bars in minutes");

  // 119.6 seconds are two minutes, and an axis that ends at four cents needs more than cents
  const small = renderReport(summarize(plan, [record("baseline", "passed", 0.031, 119600), record("lsp", "passed", 0.012, 59400)]));
  assert.match(small, /<td class="number">2 min 0 s<\/td>/);
  assert.match(small, /<td class="number">59 s<\/td>/);
  assert.match(small, />\$0\.010<\/text>.*>\$0\.020<\/text>.*>\$0\.030<\/text>.*>\$0\.040<\/text>/);
  // So does one that ends at ten cents, whose steps are two and a half
  const dime = renderReport(summarize(plan, [record("baseline", "passed", 0.09, 1000), record("lsp", "passed", 0.05, 1000)]));
  assert.match(dime, />\$0\.025<\/text>.*>\$0\.050<\/text>.*>\$0\.075<\/text>.*>\$0\.100<\/text>/);
});

test("the README's account of the run holds the figures of the run's summary", () => {
  const summary = JSON.parse(readFileSync(join(REPO, "benchmarks/results/summary.json"), "utf-8"));
  const readme = readFileSync(join(REPO, "benchmarks/README.md"), "utf-8");
  const section = readme.slice(readme.indexOf("\n## A run on three codebases\n"), readme.indexOf("\n## What it does not tell you\n"));
  // The records again, as far as the summary holds them, so the report's own code takes the medians
  const records = summary.runs.map((run) => ({
    ...run,
    task: `${run.codebase}/${run.type}`,
    failure: run.outcome === "agent-failed" ? run.ending : null,
    toolCalls: { Bash: run.toolCalls },
    model: summary.model,
  }));
  const plan = { codebases: summary.codebases };
  assert.deepEqual(summarize(plan, records).overall, summary.overall);
  assert.deepEqual(
    summarize(plan, records).taskTypes.map(({ id, baseline, lsp }) => ({ id, baseline, lsp })),
    summary.taskTypes.map(({ id, baseline, lsp }) => ({ id, baseline, lsp }))
  );

  // The four figures of the page's tiles, for each arm, as the page writes them
  const tiles = (subset) => {
    const page = renderReport(summarize(plan, subset));
    return ["Tasks solved", "Median cost per session", "Median time per session", "Median tool calls per session"].map((label) => {
      const tile = page.slice(page.indexOf(`<div class="label">${label}</div>`)).split('<div class="card tile">')[0];
      return [...tile.matchAll(/<span class="value">([^<]*)<\/span>/g)].map((match) => match[1]);
    });
  };
  const KINDS = {
    "Rename a function": "rename-function",
    "Rename a function whose name other modules use": "rename-shared-function",
    "Rename a variant": "rename-variant",
    "Rename a record field whose name other records use": "rename-field",
    "Rename a module": "rename-module",
    "Add a variant": "add-variant",
  };
  const rowsUnder = (header) => {
    const lines = section.split("\n");
    const start = lines.indexOf(header);
    assert.notEqual(start, -1, header);
    const rows = [];
    for (let index = start + 2; lines[index]?.startsWith("| "); index++) {
      rows.push(lines[index].slice(2, -2).split(" | "));
    }
    return rows;
  };

  const byKind = rowsUnder("| Kind of task | Without the server | With the server |");
  assert.deepEqual(byKind.map(([kind]) => KINDS[kind]), summary.taskTypes.map((type) => type.id));
  for (const [kind, ...cells] of byKind) {
    const [solved, cost, time, calls] = tiles(records.filter((record) => record.type === KINDS[kind]));
    assert.deepEqual(cells, [0, 1].map((arm) => `${solved[arm]}, ${cost[arm]}, ${time[arm]}, ${calls[arm]} tool calls`), kind);
  }

  const byCodebase = rowsUnder("| Kind of task | Codebase | Without the server | With the server | Files changed |");
  assert.equal(byCodebase.length, summary.taskTypes.length * summary.codebases.length);
  for (const [kind, codebase, without, withIt, files] of byCodebase) {
    const subset = records.filter((record) => record.type === KINDS[kind] && record.codebase === codebase);
    const [solved, cost, time, calls] = tiles(subset);
    // The section says that every one of those sessions solved its task
    assert.deepEqual(solved, ["3 of 3", "3 of 3"], `${kind} on ${codebase}`);
    assert.deepEqual([without, withIt], [0, 1].map((arm) => `${cost[arm]}, ${time[arm]}, ${calls[arm]} tool calls`), `${kind} on ${codebase}`);
    // Every session of the row changed that many files, in both arms
    assert.deepEqual(subset.map((record) => String(record.changedFiles)), Array(6).fill(files), `${kind} on ${codebase}`);
  }

  // The overall figures: the tiles, and beside them the totals, the means and the rounds of the two arms
  const [solved, cost, time, calls] = tiles(records);
  assert.ok(section.includes(`each arm solved ${solved[0]}. `) && solved[0] === solved[1], "both arms solved as many");
  assert.ok(section.includes(`The median session cost ${cost[0]}, took ${time[0]} and made ${calls[0]} tool calls without the server.`));
  assert.ok(section.includes(`With it, the median session cost ${cost[1]}, took ${time[1]} and made ${calls[1]} tool calls.`));
  const arms = ["baseline", "lsp"].map((arm) => records.filter((record) => record.arm === arm));
  const total = (runs, figure) => runs.reduce((sum, run) => sum + run[figure], 0);
  const both = (format) => arms.map(format).join(" and ");
  assert.ok(
    section.includes(
      `the sessions cost ${both((runs) => `$${total(runs, "costUsd").toFixed(2)}`)} in total and ${both((runs) => `$${(total(runs, "costUsd") / runs.length).toFixed(3)}`)} on average, ` +
        `took ${both((runs) => `${(total(runs, "wallMs") / runs.length / 1000).toFixed(1)} s`)} on average, ` +
        `and made ${both((runs) => (total(runs.map((run) => ({ calls: run.toolCalls.Bash })), "calls") / runs.length).toFixed(1))} tool calls on average.`
    )
  );
  const rounds = arms[0].map((without) => [without, arms[1].find((other) => other.task === without.task && other.repetition === without.repetition)]);
  const count = (holds) => rounds.filter(([without, withIt]) => holds(without, withIt)).length;
  assert.ok(
    section.includes(
      `The session with the server was the cheaper one in ${count((a, b) => b.costUsd < a.costUsd)} of the ${rounds.length} rounds and the faster one in ${count((a, b) => b.wallMs < a.wallMs)}. ` +
        `It made fewer tool calls in ${count((a, b) => b.toolCalls.Bash < a.toolCalls.Bash)} and the same number in ${count((a, b) => b.toolCalls.Bash === a.toolCalls.Bash)}.`
    )
  );
  assert.ok(section.includes(`Every session of the \`lsp\` arm but one called a tool of the server, ${arms[1].filter((run) => run.lspCalls > 0).length} of ${arms[1].length}.`));

  // Where one arm lies wholly above the other: a row of the table by codebase, and its cost or its time
  const apart = byCodebase.flatMap(([kind, codebase]) =>
    ["costUsd", "wallMs"].map((figure) => {
      const [without, withIt] = arms.map((runs) => runs.filter((run) => run.type === KINDS[kind] && run.codebase === codebase).map((run) => run[figure]));
      return Math.min(...withIt) > Math.max(...without) ? "above" : Math.max(...withIt) < Math.min(...without) ? "below" : "neither";
    })
  );
  const times = (where) => apart.filter((order) => order === where).length;
  assert.ok(section.includes(`The run shows it ${times("above") + times("below")} times, ${times("above")} with the server above and ${times("below")} with the server below.`));
});
