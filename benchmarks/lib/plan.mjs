/**
 * Planning: pick one target per task type in each codebase and write down the
 * request and the expected outcome. The plan is the same for every arm.
 */

import { existsSync, lstatSync, readFileSync, writeFileSync } from "fs";
import { join, normalize, relative, resolve } from "path";
import { shell } from "../../mcp-wrapper/harnesses.mjs";
import { asSpelledOnDisk } from "../../mcp-wrapper/workspace.mjs";
import { compiledFiles, scanOutsiders, scanProject, withVariant } from "./elm-source.mjs";
import {
  changedFiles,
  closeCheckout,
  committedFiles,
  filesOutside,
  filesThroughLinks,
  openCheckout,
  realRootOf,
  runCheck,
  stateOf,
} from "./sandbox.mjs";
import { heldBack, plural, rankedTargets, TASK_TYPES, usedOutside } from "./tasks.mjs";

// How many targets to try for a task type that must break the build first
const MAX_ATTEMPTS = 5;

// The modules that the project's elm.json lists as exposed, in one list or in groups with a title
// each. A package has them, and an application none.
function exposedModules(elmRoot) {
  const { "exposed-modules": exposed = [] } = JSON.parse(readFileSync(join(elmRoot, "elm.json"), "utf-8"));
  return Object.values(exposed).flat();
}

// The modules Lamdera looks for by name. A project that uses it cannot rename them.
const NAMED_BY_LAMDERA = ["Env", "Types", "Frontend", "Backend"];

// True when the project's elm.json depends on a Lamdera package.
function usesLamdera(elmRoot) {
  const { dependencies = {} } = JSON.parse(readFileSync(join(elmRoot, "elm.json"), "utf-8"));
  return Object.keys({ ...dependencies.direct, ...dependencies.indirect }).some((name) => name.startsWith("lamdera/"));
}

// What the disk says of when each file was last written, by path. A build that writes a file
// the bytes it had has still written it.
function writtenAt(worktree, files) {
  const root = realRootOf(worktree);
  return new Map(
    [...files].map((file) => {
      const entry = lstatSync(join(root, file), { bigint: true, throwIfNoEntry: false });
      return [file, entry ? `${entry.ino} ${entry.size} ${entry.mtimeNs}` : null];
    })
  );
}

// True when the compiler rejects the project once `mutation` is applied to the target's file.
// Null when the mutation cannot be applied, and no build was run to find out.
async function buildBreaks(worktree, codebase, target, { type, variant }) {
  const path = join(worktree.elmRoot, target.file);
  const original = readFileSync(path, "utf-8");
  const mutated = withVariant(original, type, variant);
  if (mutated === null) return null;

  writeFileSync(path, mutated);
  let check;
  try {
    check = await runCheck(worktree, codebase);
  } finally {
    writeFileSync(path, original);
  }
  // A build that was cut short did not say whether the compiler asks for a branch. Taken for a
  // broken one, it would make a task of a variant that needs no work.
  if (check.timedOut) {
    throw new Error(
      `${codebase.label}: with the variant ${variant} added to the type ${type} in ${target.file}, ${check.problem}. ` +
        `Its limit is ${codebase.checkTimeoutMs} ms, and whether the variant breaks the build is not known. Raise checkTimeoutMs in the config.`
    );
  }
  return !check.ok;
}

// The first target that suits, how many were built in vain before the search stopped, and how
// many could not be tried. One of those, a type written on one line for one, is passed over and
// is no attempt.
async function pickTarget(taskType, targets, worktree, codebase) {
  if (!taskType.breaksBuild) return { target: targets[0], unbroken: 0, untried: 0 };

  let [unbroken, untried] = [0, 0];
  for (const target of targets) {
    const breaks = await buildBreaks(worktree, codebase, target, taskType.breaksBuild(target));
    if (breaks) return { target, unbroken, untried };
    if (breaks === null) untried++;
    else if (++unbroken === MAX_ATTEMPTS) break;
  }
  return { target: undefined, unbroken, untried };
}

/**
 * Plan the tasks for one codebase in a checkout of its own, which `workDir` keeps track of.
 * A task type without a suitable target in this codebase is left out and named in `skipped`,
 * with the file the check command does not compile that held back the most candidates, if any.
 */
export async function planCodebase(codebase, { workDir, minFiles }) {
  // One per codebase, so that a plan which is killed leaves each of its checkouts to be found again.
  // No label has a dot in it, so no session's slot has this name.
  const slot = join(workDir, `${codebase.label}.plan`);
  const worktree = await openCheckout(codebase, slot);
  try {
    // A file that git ignores, generated code for one, can be changed by a build as well as by a session
    const committed = await committedFiles(worktree);
    const fresh = await stateOf(worktree, codebase);
    const before = writtenAt(worktree, committed);
    const start = await runCheck(worktree, codebase);
    if (!start.ok) {
      throw new Error(`${codebase.label}: on ${codebase.ref}, before any change, ${start.problem}`);
    }
    // What the check command writes into a file of the commit, a bundle that is checked in for
    // one, would count against a session that runs the command and not against one that does
    // not. Here, before any change, it may write the bytes that are there. After a session's
    // changes it writes others.
    const after = writtenAt(worktree, committed);
    const changed = new Set(await changedFiles(worktree, codebase, fresh));
    const rewritten = [...committed].filter((path) => changed.has(path) || after.get(path) !== before.get(path)).sort();
    if (rewritten.length > 0) {
      throw new Error(
        `${codebase.label}: "${shell(...codebase.check)}" writes ${plural(rewritten.length, "file", "files")} that the commit holds, ` +
          `${rewritten[0]}${rewritten.length > 1 ? " for one" : ""}. A session that ran it would be judged by what it wrote there, and one that did not would not. ` +
          // The compiler's cache has no other place, so a commit that holds it cannot be built without a change
          (rewritten.every((path) => path.split("/").includes("elm-stuff"))
            ? `The commit holds the compiler's cache. Benchmark a commit without elm-stuff.`
            : `Have it write where the repository holds nothing, as with --output=/dev/null.`)
      );
    }
    // An Elm source that the commit does not hold counts against a session as well, whatever it holds.
    // A generated module can hold a digest of another module, or what "git describe --dirty" prints,
    // and then a session's edits change it and nothing else does. A fresh checkout has no such file, so
    // the first build shows that it writes one. The changed files that the commit holds stopped the plan above.
    const generated = [...changed].filter((path) => path.endsWith(".elm"));
    if (generated.length > 0) {
      throw new Error(
        `${codebase.label}: "${shell(...codebase.check)}" writes ${plural(generated.length, "Elm file", "Elm files")} that the commit does not hold, ` +
          `${generated[0]}${generated.length > 1 ? " for one" : ""}. A session that ran it would be judged by what it wrote there, and one that did not would not. ` +
          `Commit what it generates, and leave the generator out of the check command.`
      );
    }
    // A session's builds come after the one that its checkout has before the session. A build can write
    // an Elm file on its second run alone, where the first one left something behind for it. Built a
    // second time, the unchanged project shows that, and quickly.
    const builtOnce = await stateOf(worktree, codebase);
    const again = await runCheck(worktree, codebase);
    if (!again.ok) {
      throw new Error(`${codebase.label}: on ${codebase.ref}, built a second time without a change, ${again.problem}`);
    }
    const regenerated = (await changedFiles(worktree, codebase, builtOnce)).filter((path) => path.endsWith(".elm"));
    if (regenerated.length > 0) {
      throw new Error(
        `${codebase.label}: "${shell(...codebase.check)}" writes ${plural(regenerated.length, "Elm file", "Elm files")} when it runs a second time without a change, ` +
          `${regenerated[0]}${regenerated.length > 1 ? " for one" : ""}. A session that ran it would be judged by what it wrote there, and one that did not would not. ` +
          `Have it write the same files each time.`
      );
    }

    const project = scanProject(worktree.elmRoot);
    const outside = filesOutside(worktree, project.map((source) => source.file));
    if (outside.length > 0) {
      throw new Error(
        `${codebase.label}: ${plural(outside.length, "source file lies", "source files lie")} outside the Elm project root, ${outside[0]}${outside.length > 1 ? " for one" : ""}: ` +
          `behind a link that leads out of it, or in a source directory that the commit's elm.json lists there. ` +
          `A session's edits there would count as changes beside the project, and outside the checkout they would be edits of your own files.`
      );
    }
    // What the check command builds decides what its verdict covers. A word that names a file is read
    // as the disk spells that file, as the source directories are, whatever letter case it is written in.
    const root = asSpelledOnDisk(worktree.elmRoot);
    const named = codebase.check.map((word) =>
      existsSync(resolve(worktree.elmRoot, word)) ? relative(root, asSpelledOnDisk(resolve(worktree.elmRoot, word))) : normalize(word)
    );
    const entries = project.map((source) => source.file).filter((file) => named.includes(file));
    if (entries.length === 0) {
      throw new Error(
        `${codebase.label}: "${shell(...codebase.check)}" names no module of the project as a word of its own. ` +
          `Name each file it compiles as a word of the command, as in "elm make src/Main.elm", so the benchmark knows which modules the compiler reads. ` +
          `A file named inside a longer word, the script of "sh -c" for one, does not count.`
      );
    }
    const built = { entries, compiled: compiledFiles(project, entries) };
    const outsiders = scanOutsiders(worktree.elmRoot, project);
    // A source file can be a link to another place in the project. git names a change to it by
    // that place, where the verdict does not expect it.
    const behindLinks = new Set(filesThroughLinks(worktree, project.map((source) => source.file)));
    const isPlain = (target) => [target.file, ...target.affected].every((file) => !behindLinks.has(file));
    const keepsItsName = usesLamdera(worktree.elmRoot) ? (target) => NAMED_BY_LAMDERA.includes(target.module) : () => false;
    const tasks = [];
    const skipped = [];
    let usedByOutsiders = 0;
    let linked = 0;
    for (const taskType of TASK_TYPES) {
      // Found once for the three uses below, since a large project takes seconds to search
      const candidates = taskType.candidates(project, built.entries);
      const suitable = rankedTargets(taskType, project, built, minFiles, candidates);
      const inSight = suitable.filter((target) => !usedOutside(target, outsiders));
      const plain = inSight.filter(isPlain);
      const targets = plain.filter((target) => !(taskType.id === "rename-module" && keepsItsName(target)));
      usedByOutsiders += suitable.length - inSight.length;
      linked += inSight.length - plain.length;
      const { target, unbroken, untried } = await pickTarget(taskType, targets, worktree, codebase);
      if (!target) {
        // The most files that any candidate involves, or null without a candidate. With fewer than
        // --min-files asks for, that alone explains the gap.
        const largest = candidates.reduce((most, candidate) => Math.max(most ?? 0, candidate.size), null);
        // What each filter above took out of the candidates that would have suited
        const leftOut = { outside: suitable.length - inSight.length, linked: inSight.length - plain.length, named: plain.length - targets.length };
        skipped.push({ type: taskType.id, heldBack: heldBack(taskType, project, built, minFiles, candidates), largest, unbroken, untried, leftOut });
        continue;
      }
      tasks.push({
        id: `${codebase.label}/${taskType.id}`,
        codebase: codebase.label,
        type: taskType.id,
        // As a shell takes it, since the session runs it in one: an argument with a space keeps its quotes
        ...taskType.build(target, shell(...codebase.check), { exposed: exposedModules(worktree.elmRoot) }),
      });
    }

    return {
      codebase: {
        label: codebase.label,
        commit: worktree.commit,
        modules: project.length,
        compiled: built.compiled.size,
        // Elm files under the project root that are no part of the project, and the targets left out for their sake
        outsiders: outsiders.length,
        usedByOutsiders,
        // Targets left out because a file they involve is reached through a link
        linked,
        // What a run has to find unchanged in its config: the prompts name the check command,
        // and a build that takes longer than its limit counts as one that fails
        elmRoot: codebase.elmRoot,
        check: codebase.check,
        checkTimeoutMs: codebase.checkTimeoutMs,
        link: codebase.link,
        lines: project.reduce((total, source) => total + source.text.split("\n").length, 0),
      },
      tasks,
      skipped,
    };
  } finally {
    await closeCheckout(codebase, slot);
  }
}
