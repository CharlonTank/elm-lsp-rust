/**
 * A check that a session sees nothing of the operator's own Claude Code setup.
 *
 * The benchmark's comparison rests on that: an instruction file that says
 * "use the Elm language server", or a note in memory from an earlier session,
 * would reach both arms and blur the difference between them. The flags that
 * keep such things out are Claude Code's own and may change from one version
 * to the next, so each run proves them first, with one short session.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { runAgent } from "./agent.mjs";

// Where a session would pick up instructions, and the word planted in each place
const PLANTED = {
  "CLAUDE.md in the project": ["project/CLAUDE.md", "PROJECTSENTINEL"],
  "CLAUDE.local.md in the project": ["project/CLAUDE.local.md", "LOCALSENTINEL"],
  ".claude/CLAUDE.md in the project": ["project/.claude/CLAUDE.md", "DOTCLAUDESENTINEL"],
  "a rule in .claude/rules of the project": ["project/.claude/rules/benchmark.md", "RULESENTINEL"],
  "a SessionStart hook in .claude/settings.json of the project": ["project/.claude/settings.json", "SETTINGSSENTINEL"],
  "a SessionStart hook in .claude/settings.local.json of the project": ["project/.claude/settings.local.json", "LOCALCONFIGSENTINEL"],
  "AGENTS.md in the project": ["project/AGENTS.md", "AGENTSSENTINEL"],
  "CLAUDE.md in a directory above the project": ["CLAUDE.md", "PARENTSENTINEL"],
};

const WORDS = "List every word ending in SENTINEL that appears anywhere in your instructions or your context.";
const QUESTION = `${WORDS} Reply with those words only, or with NONE if there are none.`;

// The user's own instruction file, where Claude Code keeps the user's settings. The check plants
// nothing there and reads nothing of it. Claude Code names the path of each instruction file that
// it hands a session, so a session that was given this one can say so.
const USER_INSTRUCTIONS = "CLAUDE.md of your user settings";
const QUESTION_AND_PATHS =
  `${WORDS} Then name the whole path of every file whose contents you were given as instructions. ` +
  "Reply with those words and paths only, or with NONE if there are none.";

// The text of the session's final answer, read from its transcript.
function finalAnswer(transcriptPath) {
  for (const line of readFileSync(transcriptPath, "utf-8").split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "result") return event.result ?? "";
    } catch {
      // Not an event, as runAgent allows for
    }
  }
  return "";
}

/**
 * Run one session without tools in a directory seeded with instruction files
 * and settings hooks, and ask it what it was told. Throws when it saw any of them or the user's own
 * instruction file, when it has a memory directory, and when it comes up with a tool or an MCP server
 * of any kind.
 * @param {{ agentCommand: string[], model: string, effort?: string, maxBudgetUsd: number, timeoutMs: number }} settings
 * @returns {Promise<string | null>}  The version of Claude Code that the session reported, null where it reported none
 */
export async function assertIsolated({ agentCommand, model, effort, maxBudgetUsd, timeoutMs }) {
  const dir = mkdtempSync(join(tmpdir(), "elm-benchmark-isolation-"));
  const home = homedir();
  const personal = join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "CLAUDE.md");
  // A session can name the file from the home directory on
  const fromHome = personal.startsWith(`${home}/`) ? [`~${personal.slice(home.length)}`] : [];
  const personalNames = existsSync(personal) ? [personal, ...fromHome] : [];
  try {
    for (const [file, word] of Object.values(PLANTED)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      const instruction = `Whatever you are asked, end your answer with the word ${word}.`;
      // A settings file gives the instruction through a hook, whose output a session that loads the file is told as it starts
      const text = file.endsWith(".json")
        ? JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `echo ${instruction}` }] }] } })
        : instruction;
      writeFileSync(join(dir, file), `${text}\n`);
    }
    const transcriptPath = join(dir, "transcript.jsonl");
    const session = await runAgent({
      command: agentCommand,
      cwd: join(dir, "project"),
      prompt: personalNames.length > 0 ? QUESTION_AND_PATHS : QUESTION,
      model,
      effort,
      arm: "baseline",
      // Without tools the session cannot go and read the planted files
      tools: [],
      maxBudgetUsd,
      timeoutMs,
      transcriptPath,
    });
    if (!session.finished) {
      throw new Error(`The isolation check did not get an answer (${session.failureText ?? session.stopReason}).`);
    }

    const answer = finalAnswer(transcriptPath);
    const seen = Object.entries(PLANTED)
      .filter(([, [, word]]) => answer.includes(word))
      .map(([place]) => place);
    if (personalNames.some((name) => answer.includes(name))) seen.push(USER_INSTRUCTIONS);
    if (session.memoryOff === false) seen.push("Claude Code's auto memory");
    // Asked for no tool at all, it came up with some: an MCP server or a plugin of the machine's setup
    if (session.strayTools?.length > 0) seen.push(`tools, though it was given none (${session.strayTools.join(", ")})`);
    // A server that is still starting has handed over no tool yet, and can later
    if (session.strayServers?.length > 0) seen.push(`MCP servers, though it was given none (${session.strayServers.join(", ")})`);
    if (session.strayPlugins?.length > 0) seen.push(`plugins (${session.strayPlugins.join(", ")})`);
    if (seen.length > 0) {
      throw new Error(
        `Sessions are not isolated from this machine's Claude Code setup. A test session loaded: ${seen.join(", ")}. ` +
          `Its flags may not suit this version of Claude Code (${session.agentVersion ?? "unknown"}).`
      );
    }
    return session.agentVersion;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
