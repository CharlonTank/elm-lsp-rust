/**
 * Disposable checkouts of a codebase. Every plan and every run works in its
 * own git worktree, so the original checkout is never edited.
 */

import { spawn } from "child_process";
import { createHash } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, relative } from "path";
import { NO_SOURCES, projectDirectories } from "./elm-source.mjs";
import { OWN_SETTINGS, ownEnvironment } from "./git.mjs";
import { placeOf } from "./place.mjs";
import { runGroup } from "./process.mjs";

// Output of a failing check is kept this long in a run record
const OUTPUT_TAIL = 2000;

/**
 * Run git to completion. Resolves with its exit status and output whether it
 * succeeds or fails, and only rejects when it cannot be started.
 *
 * It runs in a process group of its own. Ctrl-C in a terminal goes to every
 * process of the terminal's group, and a git command that is cut short while
 * it removes a checkout leaves the checkout behind, with the session's record
 * written and nothing left to come back for it. The benchmark's git commands
 * are short, and an interrupt lets each of them finish.
 */
function run(argv) {
  const [command, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, env: ownEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const chunks = { stdout: [], stderr: [] };
    child.stdout.on("data", (chunk) => chunks.stdout.push(chunk));
    child.stderr.on("data", (chunk) => chunks.stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString() });
    });
  });
}

// git keeps the records of a repository's worktrees in one directory, which it removes with the
// last of them. An add that runs beside a remove can find that directory gone under it, so the
// two take turns, repository by repository.
const turns = new Map();
function inTurn(repo, action) {
  const turn = (turns.get(repo) ?? Promise.resolve()).then(action);
  turns.set(
    repo,
    turn.catch(() => {})
  );
  return turn;
}

// A patch is read by the benchmark, so it must look the same whatever the
// operator's git is configured to color, filter or hand to another program.
// The same goes for the files it names, since a patch is made in the Elm root
// and has to name the files beside it too, for the prefixes of those names and
// for the lines of context. Without context, a blank line of the file between
// two added lines would part them. How git lines up the two versions of a file
// and cuts the changes into hunks is git's default as well. Where a new block
// repeats lines of its neighbours, the algorithm and the indent heuristic decide
// which of them show as added. OWN_SETTINGS keeps the space in front of a blank
// line of context.
const PLAIN_DIFF = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--unified=3",
  "--inter-hunk-context=0",
  "--diff-algorithm=myers",
  "--indent-heuristic",
];

async function git(repo, ...args) {
  const result = await run(["git", "-C", repo, ...OWN_SETTINGS, ...args]);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed in ${repo}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// True when git lists `dir` among the worktrees that were added to `repo`. Git prints resolved
// paths, and it lists the repository's own checkout first, which is never one of them.
async function isWorktreeOf(repo, dir) {
  // The directory above may be gone with the worktree, and then the path is taken as it is
  const resolved = existsSync(dirname(dir)) ? join(realpathSync(dirname(dir)), basename(dir)) : dir;
  const listed = (await git(repo, "worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree "));
  return listed.slice(1).includes(`worktree ${resolved}`);
}

// Where a linked path of the codebase points to, and where its link goes in a worktree
const linkOf = (codebase, dir, path) => ({
  target: join(codebase.repo, codebase.elmRoot, path),
  link: join(dir, codebase.elmRoot, path),
});

// True when `path`, which has to exist, really lies in the worktree at `dir`.
// A committed link can lead anywhere, and what is there is the operator's.
const liesIn = (dir, path) => existsSync(path) && `${realpathSync(path)}/`.startsWith(`${realpathSync(dir)}/`);

// True when the directory that would hold `link` really lies in the worktree at `dir`.
const isInsideWorktree = (dir, link) => liesIn(dir, dirname(link));

// The links that the commit of the worktree at `dir` holds and that do not stay in it, as paths in the repository
async function linksOutOf(dir) {
  const root = realpathSync(dir);
  // Each entry reads "<mode> <object> <stage>\t<path>", and a link has a mode of its own
  const links = (await git(dir, "ls-files", "-s", "-z"))
    .split("\0")
    .filter((entry) => entry.startsWith("120000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  return links.filter((path) => {
    const place = placeOf(join(root, path));
    return place === null || !`${place}/`.startsWith(`${root}/`);
  });
}

/**
 * Check out `codebase.ref` into a new worktree at `dir` and link the
 * untracked paths the build needs, such as node_modules.
 * @returns {Promise<{ dir: string, elmRoot: string, commit: string }>}
 */
export async function createWorktree(codebase, dir) {
  if (existsSync(dir)) {
    // A run that was interrupted leaves its worktree behind. Anything else at this path is not the benchmark's to delete.
    if (!(await isWorktreeOf(codebase.repo, dir))) {
      throw new Error(`${dir} exists and is not a worktree of ${codebase.repo}. Remove it yourself, or use another --out.`);
    }
    await removeWorktree(codebase, dir);
  }
  mkdirSync(dirname(dir), { recursive: true });
  // --force lets git reuse the record of a worktree whose directory is gone
  const add = () => git(codebase.repo, "worktree", "add", "--force", "--detach", dir, codebase.ref);
  // Another benchmark on the same repository takes no turns with this one. A second try gets past its remove.
  await inTurn(codebase.repo, () => add().catch(add));
  const elmRoot = join(dir, codebase.elmRoot);
  try {
    // Every build and every session runs in the Elm root. A commit can have a link in its place, or
    // above it, that leads back into the operator's checkout, and all of them would then work there.
    if (!liesIn(dir, elmRoot)) {
      throw new Error(`${codebase.label}: in ${codebase.ref}, the Elm root "${codebase.elmRoot}" is missing or is reached through a link that leads out of the checkout.`);
    }
    // What a session did to elm.json is read from the file. Through a link, wherever it leads, that would show nothing.
    if (!lstatSync(join(elmRoot, "elm.json"), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${codebase.label}: in ${codebase.ref}, the Elm root "${codebase.elmRoot}" has no elm.json of its own. It is missing there, or it is a link.`);
    }
    // Any other path can be a link to a file of the operator's as well. A session that edits the path edits that file.
    const checkLinks = async (configured = false) => {
      const astray = await linksOutOf(dir);
      if (astray.length > 0) {
        // A committed link to a path that the config links in ends where that path does, in the operator's checkout
        const through = configured ? " through a path that the config links into it" : "";
        const others = astray.length > 1 ? `, and so do ${astray.length - 1} more` : "";
        throw new Error(
          `${codebase.label}: in ${codebase.ref}, "${astray[0]}" is a link that leads out of the checkout${through}, or to no place that can be made out${others}. ` +
            `A session that edits such a path changes what it points to, which is outside the benchmark's sight and may be yours.`
        );
      }
    };
    await checkLinks();
    for (const path of codebase.link) {
      const { target, link } = linkOf(codebase, dir, path);
      if (!isInsideWorktree(dir, link)) {
        throw new Error(`${codebase.label}: the link "${path}" has no place in the checkout. The directory above it is missing there.`);
      }
      if (lstatSync(link, { throwIfNoEntry: false })) {
        throw new Error(`${codebase.label}: the link "${path}" names a path that the commit holds. A linked path is one that git does not track.`);
      }
      symlinkSync(target, link);
    }
    await checkLinks(true);
    const commit = (await git(dir, "rev-parse", "HEAD")).trim();
    return { dir, elmRoot, commit };
  } catch (error) {
    // Half a checkout is of no use, and its record would stay in the repository
    await removeWorktree(codebase, dir);
    throw error;
  }
}

/** Remove a worktree that createWorktree made. Git deletes the directory and its own record of it. */
export async function removeWorktree(codebase, dir) {
  // The links point into the original checkout. Drop them first so nothing can follow them.
  // Only a link in the worktree itself is dropped: createWorktree makes no other.
  for (const path of codebase.link) {
    const { link } = linkOf(codebase, dir, path);
    if (isInsideWorktree(dir, link) && lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) {
      rmSync(link);
    }
  }
  await inTurn(codebase.repo, async () => {
    const removed = await run(["git", "-C", codebase.repo, ...OWN_SETTINGS, "worktree", "remove", "--force", dir]);
    if (removed.ok) return;
    // A checkout that lost its tie to the repository, or its directory, while git still lists it. A
    // sound one is put in its place and removed, which leaves no record behind and prunes nothing.
    if (!(await isWorktreeOf(codebase.repo, dir))) {
      throw new Error(`git worktree remove failed for ${dir}: ${removed.stderr.trim()}`);
    }
    rmSync(dir, { recursive: true, force: true });
    await git(codebase.repo, "worktree", "add", "--force", "--detach", dir, "HEAD");
    await git(codebase.repo, "worktree", "remove", "--force", dir);
  });
}

// What the directory of a checkout is called, with some letters behind it
const CHECKOUT = "checkout-";

// What a slot remembers: where its checkout is, and of which codebase. Null when the file says nothing of the kind.
function readSlot(slot) {
  try {
    const { dir, label } = JSON.parse(readFileSync(slot, "utf-8"));
    return typeof dir === "string" && typeof label === "string" ? { dir, label } : null;
  } catch {
    return null;
  }
}

/**
 * Check a codebase out for one session, or for a plan. Claude Code tells the
 * model its working directory, so the path must not say which arm a session
 * is, and nothing of the benchmark may lie near it: the plan and the other
 * arm's patch are in the output directory. The checkout is a directory named
 * after the repository, alone in a new directory among the system's temporary
 * files. `slot`, a file in the output directory, remembers where, so that a
 * checkout which a killed benchmark left behind is found and removed.
 * @returns {Promise<{ dir: string, elmRoot: string, commit: string }>}
 */
export async function openCheckout(codebase, slot) {
  await closeCheckout(codebase, slot);
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), CHECKOUT))), basename(codebase.repo));
  mkdirSync(dirname(slot), { recursive: true });
  writeFileSync(slot, JSON.stringify({ dir, label: codebase.label }));
  try {
    return await createWorktree(codebase, dir);
  } catch (error) {
    // A commit that is refused leaves no checkout. Its directory and its slot go as well.
    await closeCheckout(codebase, slot).catch(() => {});
    throw error;
  }
}

/** Remove the checkout that `slot` remembers, if there is one. */
export async function closeCheckout(codebase, slot) {
  if (!existsSync(slot)) return;
  const dir = readSlot(slot)?.dir;
  // A slot is a file like any other. On its word, only a directory of the kind that openCheckout makes is removed.
  if (dir !== undefined && basename(dirname(dir)).startsWith(CHECKOUT)) {
    if (await isWorktreeOf(codebase.repo, dir)) {
      await removeWorktree(codebase, dir);
    }
    // The directory that was made for it alone, which is empty now. Anything else stays as it is.
    try {
      rmdirSync(dirname(dir));
    } catch {
      // Not empty, or gone already
    }
  }
  rmSync(slot);
}

/**
 * Remove the checkouts that the slots in `workDir` still remember. A benchmark
 * that was killed leaves them, and so does one whose cleanup failed after its
 * session's record was written, which no later session comes back for.
 * A slot of a codebase that the config no longer has stays as it is, since
 * the repository whose worktree it would be is not known. Where its checkout
 * is still there, stderr says so.
 * @param {import("./config.mjs").Codebase[]} codebases
 */
export async function closeLeftovers(workDir, codebases) {
  for (const name of existsSync(workDir) ? readdirSync(workDir) : []) {
    const slot = join(workDir, name);
    const remembered = readSlot(slot);
    const codebase = codebases.find((candidate) => candidate.label === remembered?.label);
    if (codebase) await closeCheckout(codebase, slot);
    else if (remembered && existsSync(remembered.dir)) {
      console.error(
        `Left ${remembered.dir} where it is. It is a checkout of the codebase "${remembered.label}", which the config no longer names, ` +
          `and the benchmark removes a directory only where git lists it as a worktree of a codebase of the config. ` +
          `"git worktree remove --force ${remembered.dir}" in the repository of that codebase removes it.`
      );
    }
  }
}

// What is no work of a session, among the paths that the commit does not hold: the links that
// the harness itself puts into a worktree, and in whatever directory the compiler's cache and
// the packages of a tool. Such a package can bring Elm files of its own, a template for one,
// and none of them is a source of the project. A source directory of the project is no such
// place, wherever it lies: elm.json can list a package that came through npm, and a module
// that a session moves or adds there is one of the project's. Below a source directory the two
// names are passed over again, as the scan of the project passes them over.
const holdsNoSources = (path) => path.split("/").some((part) => NO_SOURCES.includes(part));
const isScaffolding = (path, codebase, sources) =>
  codebase.link.includes(path) ||
  (holdsNoSources(path) && !sources.some((directory) => path.startsWith(`${directory}/`) && !holdsNoSources(path.slice(directory.length + 1))));

// The directories that hold the project's modules, relative to the Elm root: the ones that the
// elm.json of the starting commit lists, which a session cannot change, and the tests beside
// them. None where that file cannot be read, which a build will have said by then.
async function sourceDirectoriesOf(worktree) {
  const elmJson = await run(["git", "-C", worktree.elmRoot, ...OWN_SETTINGS, "cat-file", "--filters", `${worktree.commit}:./elm.json`]);
  try {
    return projectDirectories(JSON.parse(elmJson.stdout), worktree.elmRoot);
  } catch {
    return [];
  }
}

// git lists paths separated by NUL and unquoted, whatever characters they hold
const pathsIn = (output) => output.split("\0").filter(Boolean);

/**
 * Where the Elm root of a worktree really lies. The commit can have a link to
 * another directory of the checkout in its place, and git names a file by
 * where it really is. A path that leaves the root, "../README.md", is read
 * from here.
 */
export const realRootOf = (worktree) => realpathSync(worktree.elmRoot);

/** The top of a worktree's checkout as the system names it. Git names every path it lists there, and every path of a patch, from here. */
export const realTopOf = (worktree) => realpathSync(worktree.dir);

// What git lists when it is asked about the whole checkout. It names a path from the top of it.
// Here a path is told from the Elm root, where a session works, so a file beside that root is
// "../README.md".
const listed = async (worktree, ...args) => {
  const top = realTopOf(worktree);
  return pathsIn(await git(top, ...args)).map((path) => relative(realRootOf(worktree), join(top, path)));
};

// The files whose text a verdict reads: Elm sources, and elm.json, where a package lists what it exposes
const isRead = (path) => path.endsWith(".elm") || basename(path) === "elm.json";

// How a patch shows a file. One that a verdict reads is shown as text whatever the repository's
// attributes call it: generated Elm code can count as no text there, and git would then say of it
// only that it differs. For any other file that is no text, a bundle that a build wrote, that one
// line is enough.
const shown = (file) => [...PLAIN_DIFF, ...(isRead(file) ? ["--text"] : [])];

// What a path holds: the text of a file that is read, a digest of any other file, where a link points, null for nothing.
function contentOf(path) {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (!stats) return null;
  if (stats.isSymbolicLink()) return `link to ${readlinkSync(path)}`;
  if (!stats.isFile()) return "no file";
  return isRead(path) ? readFileSync(path, "utf-8") : createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Every file of the checkout that differs from the commit the worktree
 * started from, or that git does not track, with what it holds now. The
 * checkout can be more than the Elm project: a session that rewrites the
 * README beside a project in "client" has changed a file as well.
 * "git status" does not tell enough: it compares with HEAD, which a session
 * can move with a commit, it does not list the files git ignores, and it
 * cannot say whether a file that the build generated was changed again.
 * Ignored files other than Elm sources are left out. So are the links, the
 * compiler's cache and what lies under node_modules, unless the commit holds
 * the file or the file lies in a source directory of the project.
 * @returns {Promise<Map<string, string | null>>} by path relative to the Elm root
 */
export async function stateOf(worktree, codebase) {
  const paths = new Set([
    ...(await listed(worktree, "diff", "--name-only", "-z", "--no-renames", worktree.commit)),
    ...(await listed(worktree, "ls-files", "-z", "--others", "--exclude-standard")),
    ...(await listed(worktree, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", "*.elm")),
  ]);
  const committed = await committedFiles(worktree);
  const sources = await sourceDirectoriesOf(worktree);
  const state = new Map();
  for (const path of [...paths].filter((path) => committed.has(path) || !isScaffolding(path, codebase, sources)).sort()) {
    state.set(path, contentOf(join(realRootOf(worktree), path)));
  }
  return state;
}

/**
 * The paths of the checkout that a session changed: those that differ now
 * from what they were in `before`, the state when the session began.
 * Without `before`, every path that differs from the starting commit.
 * @param {Map<string, string | null>} [before]  What stateOf returned before the session
 * @returns {Promise<string[]>} sorted, relative to the Elm root
 */
export async function changedFiles(worktree, codebase, before = new Map()) {
  const now = await stateOf(worktree, codebase);
  return [...new Set([...before.keys(), ...now.keys()])].filter((path) => now.get(path) !== before.get(path)).sort();
}

/**
 * The changes to `files` since the starting commit as one patch, new files
 * included. It lets a run be inspected or judged again after its worktree is gone.
 */
export async function patchOf(worktree, files) {
  if (files.length === 0) return "";
  const root = worktree.elmRoot;
  // Nothing is staged for this. "git add" would write the session's files into
  // the object store, which the worktree shares with the operator's checkout.
  const untracked = pathsIn(await git(root, "ls-files", "-z", "--others", "--", ...files));
  const top = realTopOf(worktree);
  const parts = [];
  for (const file of files) {
    if (untracked.includes(file)) {
      // A new file is compared with nothing. git reports "they differ" through its exit status here.
      // It is named from the top of the checkout, as the other files of the patch are.
      const fromTop = relative(top, join(realRootOf(worktree), file));
      const { stdout } = await run(["git", "-C", top, ...OWN_SETTINGS, ...shown(file), "--no-index", "--", "/dev/null", fromTop]);
      parts.push(stdout);
    } else {
      parts.push(await git(root, ...shown(file), worktree.commit, "--", file));
    }
  }
  return parts.join("");
}

/**
 * What each of `files` held when the session began, by path, for the files
 * whose text a verdict reads: what `before` has for it, and for a file that
 * was as the starting commit has it, the text in that commit as a checkout
 * writes it. Git changes the line ends on the way where the repository's
 * attributes or the operator's settings ask for it, and the file that the
 * session left has them changed. Null for a file that was not there.
 * @param {Map<string, string | null>} [before]  What stateOf returned before the session
 * @returns {Promise<Map<string, string | null>>}
 */
export async function originalsOf(worktree, files, before = new Map()) {
  const originals = new Map();
  for (const file of files.filter(isRead)) {
    if (before.has(file)) {
      originals.set(file, before.get(file));
      continue;
    }
    const written = await run(["git", "-C", worktree.elmRoot, ...OWN_SETTINGS, "cat-file", "--filters", `${worktree.commit}:./${file}`]);
    originals.set(file, written.ok ? written.stdout : null);
  }
  return originals;
}

/**
 * The files that the starting commit holds, in the whole checkout, relative
 * to the Elm project root. Read from the commit and not from the index,
 * which is the session's to change.
 * @returns {Promise<Set<string>>}
 */
export async function committedFiles(worktree) {
  return new Set(await listed(worktree, "ls-tree", "-r", "-z", "--name-only", worktree.commit));
}

/** True when the worktree is still on the commit it started from. A session is told not to commit. */
export async function isOnItsCommit(worktree) {
  return (await git(worktree.dir, "rev-parse", "HEAD")).trim() === worktree.commit;
}

/**
 * Run the codebase's check command. `problem` says in one sentence how it
 * failed, with the end of what it printed. `timedOut` tells a build that ran
 * out of time, and so said nothing about the project, from one that failed.
 */
export async function runCheck(worktree, codebase) {
  const result = await runGroup(codebase.check, { cwd: worktree.elmRoot, timeoutMs: codebase.checkTimeoutMs });
  // A build script can catch the signal that ends it and exit as if all were well
  if (result.code === 0 && !result.timedOut) return { ok: true, timedOut: false, problem: "" };
  const output = `${result.stdout}${result.stderr}`.slice(-OUTPUT_TAIL);
  return { ok: false, timedOut: result.timedOut, problem: result.timedOut ? "the check command ran out of time" : `the check command fails: ${output}` };
}

/**
 * Those of `files`, paths under the Elm project root, that are reached
 * through a link: the file is one, or a directory on the way to it. git
 * names a change to such a file by the place the link leads to, so a verdict
 * that expects the change under the file's own name would not find it.
 */
export function filesThroughLinks(worktree, files) {
  const root = realpathSync(worktree.elmRoot);
  return files.filter((file) => realpathSync(join(worktree.elmRoot, file)) !== join(root, file));
}

/**
 * Those of `files`, paths under the Elm project root, whose real place is
 * outside that root. A source directory or a file can be a link that leads
 * out of it: to the operator's own files, where git would show nothing of a
 * session's edits, or to another part of the checkout, which is no part of
 * the project.
 */
export function filesOutside(worktree, files) {
  const root = realpathSync(worktree.elmRoot);
  return files.filter((file) => {
    const real = realpathSync(join(worktree.elmRoot, file));
    return !real.startsWith(`${root}/`);
  });
}
