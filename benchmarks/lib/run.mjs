/**
 * One run: a fresh worktree, one agent session on one task, and the verdict.
 */

import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { agentName, runAgent } from "./agent.mjs";
import { scanProject } from "./elm-source.mjs";
import { Interrupted, isStopped } from "./process.mjs";
import {
  changedFiles,
  closeCheckout,
  committedFiles,
  filesOutside,
  isOnItsCommit,
  openCheckout,
  originalsOf,
  patchOf,
  realRootOf,
  realTopOf,
  runCheck,
  stateOf,
} from "./sandbox.mjs";
import { unmetExpectations } from "./tasks.mjs";

/**
 * How a run ended, from best to worst:
 *   passed            the project compiles and every expectation holds
 *   wrong-result      it compiles, but the change is not the one asked for
 *   does-not-compile  the check command fails, or the checkout cannot be read for it to run
 *   agent-failed      the session did not come to an end of its own, see failureOf
 *   server-failed     the language server of the lsp arm did not start
 */
function outcomeOf(arm, agent, compiles, problems) {
  // Whatever such a session did, it did without the tools its arm stands for
  if (arm === "lsp" && agent.lspStatus === "failed") return "server-failed";
  if (!agent.finished || agent.timedOut) return "agent-failed";
  if (!compiles) return "does-not-compile";
  return problems.length === 0 ? "passed" : "wrong-result";
}

/**
 * Why a session counts as agent-failed. The first two are limits the
 * operator set, and say something about the arm. The third is everything
 * else, a request that grew too long for the model for one, and says little.
 * @returns {"time-limit" | "budget-limit" | "error"}
 */
function failureOf(agent) {
  if (agent.timedOut) return "time-limit";
  return /budget/.test(agent.stopReason) ? "budget-limit" : "error";
}

// What the API, and Claude Code in its place, say of a request that holds more than the model
// takes. A session that ends on that has itself to thank.
const TOO_MUCH = /(prompt|input) is too long|request too large|request_too_large|context (window|length|limit)/i;

/**
 * True when a session ended on trouble between here and the API: a rate
 * limit, an expired login, an outage, or no answer at all. That says nothing
 * about the arm that was running. It is told by what the error says, since
 * its status alone does not tell: the API answers 400 to a prompt that is too
 * long, and 400 as well once a spending limit is reached.
 */
const lostTheApi = (agent) => agent.endedOnApiError && agent.apiErrorStatus !== 413 && !TOO_MUCH.test(agent.failureText ?? "");

// What the session's end had to say for itself
function lastWords(agent) {
  if (agent.failureText !== null) return agent.failureText;
  if (agent.apiErrorStatus !== null) return `API error ${agent.apiErrorStatus}`;
  return agent.endedOnApiError ? "no answer from the API" : agent.stopReason;
}

export const runId = (task, arm, repetition) => `${task.id.replace("/", "--")}--${arm}--${repetition}`;

// A session that is set up differently from what its arm means measures nothing. Null when it is as it should be.
// `version` is the version of Claude Code that the run began with, where the caller holds its sessions to one.
function wrongSetup(arm, agent, version) {
  if (agent.memoryOff === false) return "it loaded Claude Code's auto memory, which every session on this repository shares";
  // Claude Code can update itself while a run is under way, and another version is another agent. A session
  // that has not come to its first event has reported nothing yet.
  if (version !== undefined && agent.memoryOff !== null && agent.agentVersion !== version) {
    return `it ran in ${agentName(agent.agentVersion)}, and this run began with ${agentName(version)}`;
  }
  if (arm !== "lsp" && agent.lspStatus !== null && agent.lspStatus !== "absent") return "it had the language server";
  if (agent.strayTools?.length > 0) return `it had tools that its arm is not given: ${agent.strayTools.join(", ")}`;
  if (agent.strayServers?.length > 0) return `it had MCP servers that its arm is not given: ${agent.strayServers.join(", ")}`;
  if (agent.strayPlugins?.length > 0) return `it loaded plugins of this machine's setup: ${agent.strayPlugins.join(", ")}`;
  if (arm === "lsp" && agent.lspStatus === "absent") return "it was not given the language server";
  // Without its tools the arm is the baseline under another name
  if (arm === "lsp" && agent.lspStatus === "connected" && agent.lspTools === 0) return "its language server was connected and handed it no tool";
  // Neither there nor failed, "pending" for one: whether the session went on to have the tools cannot be told
  if (arm === "lsp" && agent.lspStatus !== null && !["connected", "failed"].includes(agent.lspStatus)) {
    return `its language server was "${agent.lspStatus}" when it began`;
  }
  return null;
}

/**
 * What the session left behind, judged. A session can leave the project in a
 * state that cannot even be read, and that is a result too, so nothing here
 * may cost the run its record.
 */
async function judge(worktree, codebase, task, before) {
  // What is known of the result by the time something fails. A checkout that cannot be read
  // before the check has run, with its .git gone for one, is counted with those that do not compile.
  const known = { compiles: false, patch: "" };
  try {
    const changed = await changedFiles(worktree, codebase, before);
    const after = await runCheck(worktree, codebase);
    known.compiles = after.ok;
    const left = {
      changed,
      patch: (known.patch = await patchOf(worktree, changed)),
      patchRoot: realTopOf(worktree),
      originals: await originalsOf(worktree, changed, before),
      committed: await committedFiles(worktree),
    };
    const problems = [
      ...(after.ok ? [] : [after.problem]),
      ...unmetExpectations(realRootOf(worktree), task.expect, left),
      // Its changes are judged all the same, since they are compared with the commit the session started from
      ...((await isOnItsCommit(worktree)) ? [] : ["the session created a commit, which the task told it not to"]),
    ];
    // The files of the project that changed. What a build wrote beside them, or a note, is in the patch and no change.
    const counted = changed.filter((file) => left.committed.has(file) || file.endsWith(".elm"));
    return { compiles: after.ok, problems, changedFiles: counted.length, patch: left.patch };
  } catch (error) {
    // Ended from outside, which says nothing about what the session left behind
    if (isStopped()) throw new Interrupted();
    // The first line says what failed. git can go on with its whole usage text.
    return { ...known, problems: [`the result could not be judged: ${error.message.split("\n")[0]}`], changedFiles: null };
  }
}

/**
 * Execute one run and return its record. The agent's transcript and its
 * changes as a patch are written next to it. Those two and the record's
 * `problems` name files and symbols of the codebase. Of the rest, `commit`
 * is the codebase's own, and `failureText` holds Claude Code's words about a
 * session that failed, which can name a path. The report takes neither.
 *
 * Throws when the run measured nothing: the starting point does not compile,
 * the session was set up wrongly or lost the API, `afterSession` throws once
 * the session has ended, or the benchmark was interrupted. Such a run leaves
 * no file behind.
 */
export async function executeRun({ task, codebase, arm, repetition, options, afterSession = () => {} }) {
  const id = runId(task, arm, repetition);
  const transcriptPath = join(options.runsDir, `${id}.jsonl`);
  const patchPath = join(options.runsDir, `${id}.patch`);
  const slot = join(options.workDir, id);
  const worktree = await openCheckout(codebase, slot);
  try {
    // Builds the compiler's cache, so no arm pays for a cold build, and proves the starting point is sound
    const start = await runCheck(worktree, codebase);
    if (!start.ok) {
      throw new Error(`${codebase.label}: before the agent starts, ${start.problem}`);
    }
    // What a build generates is not the agent's doing
    const before = await stateOf(worktree, codebase);
    // The plan made sure of this for its own checkout. The links of this one come from today's config.
    const sources = scanProject(worktree.elmRoot).map((source) => source.file);
    if (filesOutside(worktree, sources).length > 0) {
      throw new Error(`${codebase.label}: source files lie outside the Elm project root, behind a link that leads out of it or in a source directory that elm.json lists there. Plan again.`);
    }

    const agent = await runAgent({
      command: options.agentCommand,
      cwd: worktree.elmRoot,
      prompt: task.prompt,
      model: options.model,
      effort: options.effort,
      arm,
      maxBudgetUsd: options.maxBudgetUsd,
      timeoutMs: options.timeoutMs,
      transcriptPath,
      // Such a session measures nothing, and every turn of it would still be paid for
      stopIf: (session) => wrongSetup(arm, session, options.agentVersion) !== null,
    });
    afterSession();
    const setup = wrongSetup(arm, agent, options.agentVersion);
    if (setup) {
      throw new Error(`${id}: the session was not set up as its arm requires: ${setup}`);
    }
    // A rate limit, an expired login or an outage: at the first request, for as long as the time
    // lasted, or in the middle of the work, where the session ended on the API's error or was still
    // asking again when its time was up. Recorded, it would count against the arm that happened
    // to be running, and no later run would do the session again.
    const waitedOut = agent.timedOut && agent.waitingForApi;
    if (waitedOut || (!agent.finished && (agent.replies === 0 || lostTheApi(agent)))) {
      const how =
        agent.replies === 0
          ? "ended before the model answered once"
          : waitedOut
            ? "was still waiting for the API when its time was up"
            : "lost the API in the middle of its work";
      throw new Error(`${id}: the session ${how} (${lastWords(agent)}). Nothing was recorded for it.`);
    }

    const { compiles, problems, changedFiles: changedCount, patch } = await judge(worktree, codebase, task, before);
    // A signal that came while the result was judged may have cut the judging short
    if (isStopped()) throw new Interrupted();
    writeFileSync(patchPath, patch);
    const outcome = outcomeOf(arm, agent, compiles, problems);
    return {
      id,
      task: task.id,
      codebase: task.codebase,
      commit: worktree.commit,
      type: task.type,
      arm,
      repetition,
      model: options.model,
      // Null where the run named none, and the session ran at the default of Claude Code for its model
      effort: options.effort ?? null,
      languageServer: options.languageServer,
      concurrency: options.concurrency,
      outcome,
      failure: outcome === "agent-failed" ? failureOf(agent) : null,
      problems,
      changedFiles: changedCount,
      ...agent,
    };
  } catch (error) {
    for (const path of [transcriptPath, patchPath]) rmSync(path, { force: true });
    throw error;
  } finally {
    try {
      await closeCheckout(codebase, slot);
    } catch (error) {
      // The next run of this session removes what is left. The record is worth more than a clean directory.
      console.error(`Could not remove ${worktree.dir}: ${error.message}`);
    }
  }
}
