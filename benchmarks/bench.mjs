#!/usr/bin/env node
/**
 * Benchmark: how does a coding agent do on Elm refactoring tasks with the
 * language server and without it? See README.md in this directory.
 */

import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { runChecks } from "../mcp-wrapper/doctor.mjs";
import { RUST_LSP_PATH } from "../mcp-wrapper/lsp-client.mjs";
import { agentName, ARMS, assertMcpServer, benchmarkVersion, EFFORT_LEVELS, languageServerBuilt, languageServerVersion, serverBuild } from "./lib/agent.mjs";
import { loadConfig } from "./lib/config.mjs";
import { assertIsolated } from "./lib/isolation.mjs";
import { planCodebase } from "./lib/plan.mjs";
import { assertProcessesVisible, Interrupted, isStopped, LONGEST_TIMEOUT_MS, stopAll } from "./lib/process.mjs";
import { renderReport, summarize } from "./lib/report.mjs";
import { plural } from "./lib/tasks.mjs";
import { executeRun, runId } from "./lib/run.mjs";
import { closeLeftovers } from "./lib/sandbox.mjs";

const USAGE = `Usage: node benchmarks/bench.mjs <command> --out <dir> [options]

  plan     Pick one target per task type in each codebase and write <out>/plan.json
  run      Run every planned task in every arm and write one record per session to <out>/runs/
  report   Summarize the records into <out>/report.html and <out>/summary.json

Options
  --out <dir>            Where the plan, the records and the report go
  --config <file>        The codebases to run on (plan and run)
  --min-files <n>        Fewest files a target must involve (plan, default 5)
  --model <id>           Model for every session (run, default claude-opus-5-5)
  --effort <level>       Effort of every session: ${EFFORT_LEVELS.join(", ")} (run, default Claude Code's for the model)
  --arms <list>          Arms to run (run, default ${Object.keys(ARMS).join(",")})
  --repeat <n>           Sessions per task and arm (run, default 1)
  --concurrency <n>      Sessions running at the same time (run, default 1)
  --only <text>          Only tasks whose id contains this text (run)
  --max-budget-usd <n>   Spending limit per session (run, default 5)
  --timeout-min <n>      Time limit per session (run, default 20)
  --agent <path>         Claude Code executable (run, default claude)

A run that stops, or is stopped with Ctrl-C, goes on from its last finished
session when the same command is given again.`;

class UsageError extends Error {}

// Turn ["--out", "dir", "--repeat", "2"] into { out: "dir", repeat: "2" }.
// `known` lists the options the command takes. Any other one is a mistake.
function parseOptions(argv, known) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) {
      throw new UsageError(`Expected --<option> <value>, got "${argv.slice(i, i + 2).join(" ")}"`);
    }
    if (!known.includes(name)) {
      throw new UsageError(`Unknown option --${name}. This command takes: ${known.map((option) => `--${option}`).join(", ")}`);
    }
    options[name] = argv[i + 1];
  }
  return options;
}

function required(options, name) {
  if (options[name] === undefined) throw new UsageError(`--${name} is required`);
  return options[name];
}

function positiveNumber(options, name, fallback) {
  const value = Number(options[name] ?? fallback);
  if (!(Number.isFinite(value) && value > 0)) throw new UsageError(`--${name} must be a positive number`);
  return value;
}

// In minutes, for a timer that takes milliseconds
function timeLimit(options) {
  const minutes = positiveNumber(options, "timeout-min", 20);
  const longest = Math.floor(LONGEST_TIMEOUT_MS / 60000);
  if (minutes > longest) throw new UsageError(`--timeout-min must be at most ${longest}, the longest that a timer of Node.js waits`);
  return minutes;
}

// For options that count things: sessions, files
function wholeNumber(options, name, fallback) {
  const value = options[name] ?? String(fallback);
  if (!/^[1-9]\d*$/.test(value)) throw new UsageError(`--${name} must be a whole number of 1 or more`);
  return Number(value);
}

const hasRecords = (runsDir) => existsSync(runsDir) && readdirSync(runsDir).some((file) => file.endsWith(".json"));

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`${path} cannot be read: ${error.message}`);
  }
}

// The records of the sessions in `runsDir`, in the order of their names
const readRecords = (runsDir) =>
  existsSync(runsDir)
    ? readdirSync(runsDir)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => readJson(join(runsDir, file)))
    : [];

// Written under another name and moved to its own in one step, so a file is whole or not there.
// A record that was cut short would count as a session that is done.
function writeJson(path, value) {
  const unfinished = `${path}.part`;
  writeFileSync(unfinished, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(unfinished, path);
}

// True when a process with this id is running, whoever owns it.
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Take the output directory for this process until it exits. A second
 * benchmark in the same directory would take the checkouts of the first for
 * leftovers and remove them from under its sessions.
 */
function takeOutputDirectory(out) {
  const lock = join(out, "lock");
  const taken = (holder) =>
    new Error(
      `Another benchmark, process ${holder}, is working in ${out}. Wait for it, or use another --out. ` +
        `If no benchmark is running there, delete ${lock}.`
    );
  // The positive process id that a lock file names, or null when it names none
  const holderOf = (file) => {
    try {
      const pid = Number(readFileSync(file, "utf-8"));
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  };
  mkdirSync(out, { recursive: true });
  // Publish the holder and the lock together. Creating the lock before writing its id would
  // let another benchmark take an empty lock for one that was left behind.
  const own = `${lock}.${process.pid}.holder`;
  writeFileSync(own, String(process.pid));
  try {
    // Try a few times at most. A lock can go, or be taken over, between two looks at it
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(own, lock);
        process.on("exit", () => rmSync(lock, { force: true }));
        return;
      } catch (error) {
        // A file system without hard links refuses the link, and the lock cannot be made there
        if (["EPERM", "ENOTSUP", "EXDEV"].includes(error.code)) {
          throw new Error(`The file system of ${out} takes no hard links, so it cannot hold the lock of the benchmark. Use another --out.`);
        }
        if (error.code !== "EEXIST") throw error;
      }
      const holder = holderOf(lock);
      // A lock that names this process was left behind by an earlier benchmark with the same id, as a
      // container gives the benchmark the same id each time
      if (holder !== null && holder !== process.pid && isRunning(holder)) throw taken(holder);

      // Left by a benchmark that was killed. Of two that find it, one gets to move it aside. What
      // was moved is looked at once more, since the other may have put its own lock there by then,
      // and is put back in that case. A third that starts in the instant in between can get in.
      const aside = `${lock}.${process.pid}`;
      try {
        renameSync(lock, aside);
      } catch {
        continue;
      }
      const moved = holderOf(aside);
      if (moved !== holder && isRunning(moved)) {
        try {
          linkSync(aside, lock);
        } catch {
          // A third one holds the directory now
        }
        rmSync(aside, { force: true });
        throw taken(moved);
      }
      rmSync(aside, { force: true });
    }
    throw new Error(`Could not take ${lock}. Other benchmarks keep taking it.`);
  } finally {
    rmSync(own, { force: true });
  }
}

function readPlan(out) {
  const path = join(out, "plan.json");
  if (!existsSync(path)) throw new Error(`${path} does not exist. Run the plan command first.`);
  return readJson(path);
}

async function plan(options) {
  const out = resolve(required(options, "out"));
  const minFiles = wholeNumber(options, "min-files", 5);
  const { codebases } = loadConfig(resolve(required(options, "config")));
  // Records are matched to tasks by name. A new plan under old records would pair them with other targets.
  if (hasRecords(join(out, "runs"))) {
    throw new Error(`${join(out, "runs")} holds the records of an earlier plan. Use another --out, or delete that directory.`);
  }
  takeOutputDirectory(out);
  await closeLeftovers(join(out, "work"), codebases);

  // The state of the code that made the plan: what a task expects is written here, and checked later
  const planned = { minFiles, benchmark: benchmarkVersion(), codebases: [], tasks: [] };
  for (const codebase of codebases) {
    const { codebase: facts, tasks, skipped } = await planCodebase(codebase, { workDir: join(out, "work"), minFiles });
    planned.codebases.push(facts);
    planned.tasks.push(...tasks);
    // A target is only taken from what the check command compiles, so this says how much of the project was in play
    console.log(
      `${codebase.label}: ${plural(tasks.length, "task", "tasks")} in ${plural(facts.modules, "module", "modules")}, of which the check command compiles ${facts.compiled}`
    );
    if (facts.outsiders > 0) {
      console.log(
        `${codebase.label}: ${plural(facts.outsiders, "Elm file lies", "Elm files lie")} outside the project's source directories. ` +
          `${plural(facts.usedByOutsiders, "possible target was", "possible targets were")} left out because such a file can use them.`
      );
    }
    if (facts.linked > 0) {
      console.log(
        `${codebase.label}: ${plural(facts.linked, "possible target was", "possible targets were")} left out because a file they involve is reached through a link.`
      );
    }
    for (const { type, heldBack, largest, unbroken, untried, leftOut } of skipped) {
      const tooSmall =
        largest === null
          ? ". Nothing in the project is a candidate for it"
          : largest < minFiles
            ? `. No candidate involves more than ${plural(largest, "file", "files")}, and --min-files asks for ${minFiles}`
            : "";
      // One file is named, the one that holds back the most. A project can have hundreds of them.
      const others = heldBack && heldBack.files > 1 ? `, and ${plural(heldBack.files - 1, "other such file holds", "other such files hold")} candidates back too` : "";
      // Targets that were tried and broke nothing are the nearest cause, whatever else was held back
      const unbrokenBuild = `. The project still compiled with the change made to ${unbroken === 1 ? "the one target that was" : `each of the ${unbroken} targets that were`} tried, so there was no work to ask for`;
      // Next come targets that could not be tried at all
      const notLaidOut = `. The plan adds a variant on a line of its own, as elm-format lays a type out, and ${untried === 1 ? "the one target is" : `none of the ${untried} targets is`} written that way`;
      // Then the candidates that suited and were left out all the same, each kind with its count
      const kinds = [
        leftOut.outside > 0 && `${leftOut.outside} that an Elm file outside the project can use`,
        leftOut.linked > 0 && `${leftOut.linked} that ${leftOut.linked === 1 ? "involves" : "involve"} a file that is reached through a link`,
        leftOut.named > 0 && `${leftOut.named} whose name Lamdera looks for`,
      ].filter(Boolean);
      const noneLeft = `. Its candidates were left out: ${kinds.join(", ")}`;
      const reason =
        unbroken > 0
          ? unbrokenBuild
          : untried > 0
            ? notLaidOut
            : kinds.length > 0
              ? noneLeft
              : heldBack
                ? `. ${heldBack.candidates} of its candidates ${heldBack.candidates === 1 ? "involves" : "involve"} ${heldBack.file}, which the check command does not compile${others}`
                : tooSmall;
      console.log(`${codebase.label}: no suitable target for ${type}${reason}`);
    }
  }
  writeJson(join(out, "plan.json"), planned);
  console.log(`Wrote ${join(out, "plan.json")}`);
}

const seconds = (ms) => `${Math.round(ms / 1000)}s`;

/**
 * Why the lsp arm cannot start a session with the binary of the language
 * server as it is, or null when it can. The report names the sources as they
 * are, and a binary built before an edit to them is not of those. Nor is one
 * whose sources nobody knows.
 */
function unfitServer() {
  const build = serverBuild();
  const known = "The lsp arm needs a language server whose sources are known, and";
  switch (build.unknown) {
    case "unbuilt":
      return `The lsp arm needs the language server, and ${RUST_LSP_PATH} is missing. Run scripts/setup.sh to build it.`;
    case "unlisted":
      return `${known} ${RUST_LSP_PATH}.d, the list of the files it was built from, is missing. Build it with scripts/setup.sh, which writes that list.`;
    case "gone":
      return `${known} none of the files that ${RUST_LSP_PATH}.d names as its sources is there any more, as after the checkout was moved. Build it again with scripts/setup.sh, which writes that list anew.`;
  }
  if (build.newer === null) return null;
  return `The lsp arm needs a language server built from its sources as they are, and ${RUST_LSP_PATH} is older than ${build.newer}. Run scripts/setup.sh to build it again.`;
}

// What every session of an output directory must have in common to be compared, as the operator named it
const SHARED = {
  model: "--model",
  effort: "--effort",
  maxBudgetUsd: "--max-budget-usd",
  timeoutMin: "--timeout-min",
  languageServer: "the language server",
  benchmark: "the benchmark's own code",
  // Not the operator's to name: the first session of a run says what it is
  agent: "the agent",
};

/**
 * Hold a run to the settings its output directory was started with. Records
 * made under another model, limit, language server or version of Claude
 * Code, or judged by another state of the benchmark, would sit in the same
 * rounds as the new ones and be compared with them. Only the lsp arm starts
 * the language server, so a directory is held to the server from the first
 * record of a session of that arm on, and to none before. A run of the arm
 * whose sessions recorded nothing leaves no record that names its server.
 * @returns {(agent: string) => void}  Takes what the first session of this run said it is, holds
 *   the run to that as well and writes the settings down, with the arms of this run. To be called
 *   once a task's session is about to start: an arm that was only asked for has no round waiting for it.
 */
function keepSettings(out, runsDir, shared, arms) {
  const path = join(out, "run.json");
  const before = existsSync(path) && hasRecords(runsDir) ? readJson(path) : null;
  const hold = (settings) => {
    // A setting that run.json does not hold is one that was not set, as an effort is where --effort was not given
    const changed = Object.keys(settings).filter((key) => before && (before[key] ?? null) !== (settings[key] ?? null));
    if (changed.length > 0) {
      const shown = (value) => value ?? "Claude Code's default";
      const differences = changed.map((key) => `${SHARED[key]} was ${shown(before[key])} and is now ${shown(settings[key])}`).join(", ");
      throw new Error(`${runsDir} holds records of sessions that ran differently: ${differences}. Run as before, or use another --out.`);
    }
  };
  // A server that no recorded session of the lsp arm ran with is none to hold a run to. The arm is read
  // from the records and not from their names, which hold the label of a codebase, and a label can hold "--lsp--".
  const { languageServer, ...withoutServer } = shared;
  hold(readRecords(runsDir).some((record) => record.arm === "lsp") ? shared : withoutServer);
  // Every arm that sessions were ever started for. The report waits for each of them before it counts a round.
  const asked = Object.keys(ARMS).filter((arm) => arms.includes(arm) || before?.arms?.includes(arm));
  return (agent) => {
    hold({ agent });
    writeJson(path, { ...before, ...shared, agent, arms: asked });
  };
}

async function run(options) {
  const out = resolve(required(options, "out"));
  const { codebases } = loadConfig(resolve(required(options, "config")));
  // Named twice, an arm still runs once
  const arms = [...new Set((options.arms ?? Object.keys(ARMS).join(",")).split(","))];
  for (const arm of arms) {
    if (!ARMS[arm]) throw new UsageError(`Unknown arm "${arm}". Known: ${Object.keys(ARMS).join(", ")}`);
  }
  // Without one, a session runs at the effort that Claude Code picks for its model
  const effort = options.effort ?? null;
  if (effort !== null && !EFFORT_LEVELS.includes(effort)) {
    throw new UsageError(`Unknown effort "${effort}". Known: ${EFFORT_LEVELS.join(", ")}`);
  }
  const repeat = wholeNumber(options, "repeat", 1);
  const concurrency = wholeNumber(options, "concurrency", 1);
  const runsDir = join(out, "runs");
  const shared = {
    model: options.model ?? "claude-opus-5-5",
    effort,
    maxBudgetUsd: positiveNumber(options, "max-budget-usd", 5),
    timeoutMin: timeLimit(options),
    benchmark: benchmarkVersion(),
  };
  const settings = {
    ...shared,
    workDir: join(out, "work"),
    runsDir,
    // A session runs in its checkout, so a path is resolved here. A bare name is looked up on PATH.
    agentCommand: [options.agent?.includes("/") ? resolve(options.agent) : (options.agent ?? "claude")],
    timeoutMs: shared.timeoutMin * 60 * 1000,
    // A record names it, since the time of a session depends on what runs beside it. A resumed run may take another.
    concurrency,
  };
  mkdirSync(runsDir, { recursive: true });
  takeOutputDirectory(out);
  // What a benchmark left here when it was killed, also for a session that has its record
  await closeLeftovers(settings.workDir, codebases);

  // The arms of a task run next to each other, so both see the same time of day and the same machine load
  const planned = readPlan(out);
  if (planned.benchmark !== shared.benchmark) {
    throw new Error(
      `${join(out, "plan.json")} was made by another state of the benchmark's code (${planned.benchmark ?? "an earlier one"}, and this is ${shared.benchmark}). ` +
        `What its tasks expect may not be what this code checks. Plan again, into another --out where this one holds records.`
    );
  }
  const tasks = planned.tasks.filter((task) => task.id.includes(options.only ?? ""));
  // A text that matches no task is a mistake, and not a run with nothing left to do
  if (tasks.length === 0 && planned.tasks.length > 0) {
    throw new Error(`No task of the plan has "${options.only}" in its id. The plan's tasks are: ${planned.tasks.map((task) => task.id).join(", ")}`);
  }
  const jobs = [];
  for (let repetition = 1; repetition <= repeat; repetition++) {
    for (const [index, task] of tasks.entries()) {
      const configured = codebases.find((candidate) => candidate.label === task.codebase);
      if (!configured) throw new Error(`The plan names codebase "${task.codebase}", which is not in the config`);
      // The targets were picked in the planned commit. The configured ref may have moved on since.
      const { commit, ...plannedWith } = planned.codebases.find((candidate) => candidate.label === task.codebase);
      // The prompts name the check command, and the targets were chosen for what it compiles.
      // Under another time limit the same build can get another verdict.
      for (const key of ["elmRoot", "check", "checkTimeoutMs", "link"]) {
        if (JSON.stringify(configured[key]) !== JSON.stringify(plannedWith[key])) {
          throw new Error(`The config's "${key}" for ${task.codebase} is not the one the plan was made with. Plan again, in another --out.`);
        }
      }
      const codebase = { ...configured, ref: commit };
      // The arms take turns at going first, so whatever that costs or saves is shared between them
      const inTurn = arms.map((_, position) => arms[(position + index + repetition) % arms.length]);
      for (const arm of inTurn) {
        // A record that is already there is kept, so an interrupted benchmark resumes where it stopped
        if (!existsSync(join(runsDir, `${runId(task, arm, repetition)}.json`))) {
          jobs.push({ task, codebase, arm, repetition });
        }
      }
    }
  }
  const needsServer = jobs.some((job) => job.arm === "lsp");
  if (needsServer) {
    const unfit = unfitServer();
    if (unfit !== null) throw new Error(unfit);
    shared.languageServer = languageServerVersion();
    const built = languageServerBuilt();
    // A record names the build too. The run is held to its version and sources alone.
    settings.languageServer = built ? `${shared.languageServer}, built ${built}` : shared.languageServer;
  }
  const writeSettings = keepSettings(out, runsDir, shared, arms);
  console.log(`${plural(jobs.length, "session", "sessions")} to run with ${settings.model}`);
  if (jobs.length === 0) return;
  // Claude Code stops a session at the first turn that ends above its limit, so a session can pass it by that turn
  console.log(
    `Each is stopped once it has spent $${settings.maxBudgetUsd}, which makes about $${(jobs.length * settings.maxBudgetUsd).toFixed(0)} if every one gets that far. ` +
      `The isolation check before them is one short session more.`
  );

  assertProcessesVisible();
  // The wrapper starts the binary at a session's first tool call. One that cannot start, or does not answer what
  // every tool call asks, would make each session of the lsp arm a baseline whose tool calls fail.
  if (needsServer) {
    const { ok, report } = await runChecks();
    if (!ok) throw new Error(`The lsp arm needs a language server that starts and answers, and the checks of "cli.mjs doctor" fail:\n${report}`);
    await assertMcpServer();
  }
  // Claude Code updates itself, also between two runs into one directory, so its version is held like the model
  settings.agentVersion = await assertIsolated(settings);
  writeSettings(agentName(settings.agentVersion));

  // A session that cannot run at all, or that lost the API, stops the
  // benchmark. No new session starts, and the ones under way finish first,
  // since they are paid for.
  let failure = null;
  // Each session of the lsp arm starts the server afresh from this checkout, at its first tool call and
  // again after ten idle minutes. A build or an edit here since the run began would give it another
  // server than its record names, before the session and while it runs.
  const assertSameServer = (consequence) => {
    const now = languageServerVersion();
    if (now !== shared.languageServer) {
      throw new Error(
        `The language server was ${shared.languageServer} when this run began, and is now ${now}. ${consequence} ` +
          `Put this checkout back as it was, or use another --out, and leave the checkout as it is while a run goes on.`
      );
    }
    const unfit = unfitServer();
    if (unfit !== null) throw new Error(unfit);
  };
  const worker = async () => {
    for (let job = jobs.shift(); job && !failure && !isStopped(); job = jobs.shift()) {
      try {
        const lsp = job.arm === "lsp";
        if (lsp) assertSameServer("A session of the lsp arm would run another server than its record names.");
        const record = await executeRun({
          ...job,
          options: settings,
          afterSession: lsp ? () => assertSameServer("The session of the lsp arm that ran meanwhile may have run another one, and nothing was recorded for it.") : undefined,
        });
        writeJson(join(runsDir, `${record.id}.json`), record);
        const cost = record.costUsd === null ? "" : `  $${record.costUsd.toFixed(2)}`;
        console.log(`${record.task}  ${record.arm}  #${record.repetition}  ${record.outcome}  ${seconds(record.wallMs)}${cost}`);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  // Interrupted sessions leave no record, so the next run starts them again
  if (isStopped()) throw new Interrupted();
  if (failure) throw failure;
}

function report(options) {
  const out = resolve(required(options, "out"));
  const runsDir = join(out, "runs");
  const records = readRecords(runsDir);
  if (records.length === 0) throw new Error(`No run records in ${runsDir}. Run the run command first.`);

  // Written by "run". Records that were made before it existed speak for themselves.
  const settingsPath = join(out, "run.json");
  const arms = existsSync(settingsPath) ? readJson(settingsPath).arms : undefined;
  const summary = summarize(readPlan(out), records, arms);
  writeJson(join(out, "summary.json"), summary);
  writeFileSync(join(out, "report.html"), renderReport(summary));
  if (summary.unpaired > 0) {
    const left = plural(summary.unpaired, "session is", "sessions are");
    console.log(`${left} left out of the report: the other arm has not done the same round of the same task yet`);
  }
  console.log(`Wrote ${join(out, "report.html")}`);
}

const COMMANDS = {
  plan: { run: plan, options: ["out", "config", "min-files"], interrupted: "No plan was written." },
  run: {
    run,
    options: ["out", "config", "model", "effort", "arms", "repeat", "concurrency", "only", "max-budget-usd", "timeout-min", "agent"],
    interrupted: "Finished sessions keep their records, and the same command picks up from there.",
  },
  report: { run: report, options: ["out"], interrupted: "" },
};

async function main([command, ...rest]) {
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (!COMMANDS[command]) throw new UsageError(`Unknown command "${command}"`);
  // A hook, or a command that "git rebase -x" runs, is told by git where its repository is. Every
  // git command below would follow that, the benchmark's own and a session's, into that repository.
  const place = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"].find((name) => process.env[name] !== undefined);
  if (place && command !== "report") {
    throw new Error(`${place} is set, so git would work in the repository it names and not in the codebases of the config. Unset it and run again.`);
  }
  // Ctrl-C, a kill and a closed terminal end the check commands and the sessions under way, each
  // with what it started. They are process groups of their own, so no signal from the terminal
  // reaches them by itself. A second signal does not wait for them to end in their own way.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, stopAll);
  }
  await COMMANDS[command].run(parseOptions(rest, COMMANDS[command].options));
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof Interrupted) {
    console.error(`Interrupted. Whatever was running has been ended. ${COMMANDS[process.argv[2]].interrupted}`.trim());
    process.exitCode = 130;
  } else {
    console.error(error.message);
    process.exitCode = 1;
  }
});
