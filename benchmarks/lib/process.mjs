/**
 * The commands that run on a codebase's behalf: the agent's sessions and the
 * check command. Whatever such a command started has to end with it. A build
 * script or a session's shell command would otherwise live on, write to a
 * checkout that is being judged or removed, and load the machine while the
 * next session is timed.
 *
 * Each command is a process group of its own, which one signal reaches as a
 * whole. That is not enough for a session: Claude Code starts every shell
 * command of its Bash tool as a group of its own. So the processes a command
 * starts are also looked up while it runs, and ended one by one.
 */

import { execFile, execFileSync, spawn } from "child_process";
import { createInterface } from "readline";

// Collected output is cut to its end. Whoever reads it wants the last error, not the first megabyte.
const OUTPUT_KEPT = 64 * 1024;

// How long a command that was asked to end has before it is killed
const GRACE_MS = 5000;

// The longest a timer of Node.js waits. It takes a longer time for 1 millisecond, so a command
// with a longer time limit would be ended at once.
export const LONGEST_TIMEOUT_MS = 2 ** 31 - 1;

// How often the processes that a running command started are looked up
const WATCH_MS = 1000;

// How long the output of a command that has exited is waited for. A process
// that got away unseen can hold the pipe open for as long as it lives.
const DRAIN_MS = 2000;

// Every process, with its parent and the moment it started
const PS = ["-A", "-o", "pid=,ppid=,lstart="];
const PS_OPTIONS = { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 };

// A command that was ended from outside. It has no result worth keeping.
export class Interrupted extends Error {
  constructor() {
    super("Interrupted");
  }
}

/** @returns {Map<number, { parent: number, started: string }>} what a listing of ps says, by pid */
function parseTable(listing) {
  const table = new Map();
  for (const line of listing.split("\n")) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (row) table.set(Number(row[1]), { parent: Number(row[2]), started: row[3] });
  }
  return table;
}

function processTable() {
  try {
    return parseTable(execFileSync("ps", PS, PS_OPTIONS));
  } catch {
    // Without ps there is still the signal to the command's own group
    return new Map();
  }
}

/**
 * Throw unless the processes of this machine can be listed. A session's shell
 * commands are found through that list alone, so without it one of them could
 * outlive its session and nobody would know.
 */
export function assertProcessesVisible() {
  let table;
  try {
    table = parseTable(execFileSync("ps", PS, PS_OPTIONS));
  } catch (error) {
    throw new Error(`Cannot list the processes of this machine with "ps": ${error.message.split("\n")[0]}. Without that, what a session starts could outlive it.`);
  }
  if (!table.has(process.pid)) {
    throw new Error(`"ps ${PS.join(" ")}" does not list this process. Without that list, what a session starts could outlive it.`);
  }
}

/**
 * The processes that a command started, as far as they were seen. The system
 * hands a pid out again once its process is gone, so each one is known by its
 * pid together with the moment it started.
 */
class Family {
  constructor(leader) {
    this.leader = leader;
    this.members = new Map(); // pid -> when it started
  }

  // Take in the descendants that `table` shows. Without `leaderRuns` the
  // leader's pid may already name another process, and is not followed.
  see(table, leaderRuns) {
    const children = new Map();
    for (const [pid, { parent }] of table) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(pid);
    }
    const isMember = (pid) => this.members.has(pid) && this.members.get(pid) === table.get(pid)?.started;
    const queue = [...(leaderRuns ? [this.leader] : []), ...[...this.members.keys()].filter(isMember)];
    for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
      for (const child of children.get(pid) ?? []) {
        if (isMember(child)) continue;
        this.members.set(child, table.get(child).started);
        queue.push(child);
      }
    }
  }

  // Kill every member that `table` shows to be the process that was seen.
  kill(table) {
    for (const [pid, started] of this.members) {
      if (table.get(pid)?.started !== started) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone since the table was read
      }
    }
  }
}

// One function per running command, which ends it
const running = new Set();
let stopped = false;

/**
 * End every command that is running, and let no other start. Each one fails
 * as interrupted. A command is asked first and killed when it does not end in
 * time. Calling this a second time kills at once.
 */
export function stopAll() {
  stopped = true;
  for (const end of running) {
    end();
  }
}

export const isStopped = () => stopped;

/**
 * Run a command and wait until it has ended, with everything it started.
 * Rejects when it cannot be started, and with Interrupted after stopAll().
 * @param {string[]} argv
 * @param {object} [options]
 * @param {number} [options.timeoutMs]  The command is ended when this runs out
 * @param {(line: string, end: () => void) => void} [options.onLine]  Gets each line of stdout, and a
 *   function that ends the command as running out of time does. Without it, stdout is collected.
 * @param {(input: import("stream").Writable) => void} [options.onStart]  Writes requests to the command's stdin
 * @param {"collect" | "inherit"} [options.stderr]
 * @param {NodeJS.Signals} [options.ask]  The signal that asks the command to end
 * @param {number} [options.graceMs]  How long it has to do so before it is killed
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function runGroup(argv, { cwd, env, timeoutMs, onLine, onStart, stderr = "collect", ask = "SIGTERM", graceMs = GRACE_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (stopped) {
      reject(new Interrupted());
      return;
    }
    const [command, ...args] = argv;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [onStart ? "pipe" : "ignore", "pipe", stderr === "inherit" ? "inherit" : "pipe"],
      // The leader of a new process group, whose id is the child's
      detached: true,
    });
    const family = new Family(child.pid);
    let exited = false;
    let timedOut = false;
    let grace = null;
    let drain = null;

    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Nothing of the group is left
      }
    };
    const kill = () => {
      const table = processTable();
      family.see(table, !exited);
      signalGroup("SIGKILL");
      family.kill(table);
    };
    // Asked once, the command may end in its own way: Claude Code ends its
    // shell commands and reports what the session cost. Asked again, or out
    // of time to do so, it is killed.
    const end = () => {
      if (exited) return;
      if (grace) {
        kill();
        return;
      }
      family.see(processTable(), true);
      signalGroup(ask);
      grace = setTimeout(kill, graceMs);
    };
    running.add(end);
    const limit = setTimeout(() => {
      timedOut = true;
      end();
    }, timeoutMs ?? LONGEST_TIMEOUT_MS);
    const watch = setInterval(() => {
      try {
        execFile("ps", PS, PS_OPTIONS, (error, listing) => {
          if (!error && !exited) family.see(parseTable(listing), true);
        });
      } catch {
        // One look fewer. The next one, or the one when the command ends, makes up for it.
      }
    }, WATCH_MS);

    const collected = { stdout: "", stderr: "" };
    const collect = (stream, name) =>
      stream?.on("data", (chunk) => {
        collected[name] = (collected[name] + chunk).slice(-OUTPUT_KEPT);
      });
    if (onLine) createInterface({ input: child.stdout }).on("line", (line) => onLine(line, end));
    else collect(child.stdout, "stdout");
    collect(child.stderr, "stderr");

    const settle = (outcome) => {
      for (const timer of [limit, grace, drain]) clearTimeout(timer);
      clearInterval(watch);
      running.delete(end);
      outcome();
    };
    child.on("error", (error) => settle(() => reject(new Error(`Could not start ${command}: ${error.message}`))));
    child.on("exit", () => {
      exited = true;
      // Done in time. The limit must not run out while the output is still being read.
      clearTimeout(limit);
      clearInterval(watch);
      // The command itself is done. What it left running goes now, and the pipes close with it.
      kill();
      drain = setTimeout(() => {
        child.stdout.destroy();
        child.stderr?.destroy();
      }, DRAIN_MS);
    });
    child.on("close", (code) => settle(() => (stopped ? reject(new Interrupted()) : resolve({ code, ...collected, timedOut }))));
    if (onStart) {
      // An early exit can close stdin before a request was written. The exit still settles the command.
      child.stdin.on("error", () => {});
      child.once("spawn", () => onStart(child.stdin));
    }
  });
}
