/**
 * The benchmark configuration: which codebases to run on and how to build them.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { asSpelledOnDisk } from "../../mcp-wrapper/workspace.mjs";
import { projectDirectories } from "./elm-source.mjs";
import { placeOf } from "./place.mjs";
import { LONGEST_TIMEOUT_MS } from "./process.mjs";

const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @typedef {object} Codebase
 * @property {string} label     Name shown in plans and reports
 * @property {string} repo      Absolute path of the git repository
 * @property {string} ref       Commit to benchmark
 * @property {string} elmRoot   Directory that holds elm.json, relative to the repository
 * @property {string[]} check   Command, run in elmRoot, that succeeds when the project compiles
 * @property {string[]} link    Untracked paths under elmRoot that every checkout needs
 * @property {number} checkTimeoutMs
 */

function fail(message) {
  throw new Error(`Invalid benchmark config: ${message}`);
}

// True when one of the two paths, both relative to the Elm root, lies inside the other or equals it.
const overlap = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * What the layout of the project rules out. The benchmark sees a session's
 * changes through git, inside the Elm root of the session's own checkout.
 * Sources that live elsewhere would be edited where it cannot see them.
 */
function checkLayout(at, { repo, elmRoot, link }) {
  const root = join(repo, elmRoot);
  const sources = projectDirectories(parsed(join(root, "elm.json")), root);

  for (const directory of sources) {
    if (directory.startsWith("..")) {
      fail(`${at}: the source directory "${directory}" of elm.json is outside elmRoot. Changes there cannot be told apart from your own.`);
    }
  }
  for (const path of link) {
    // Each one becomes a link at the same place in a checkout, which the benchmark makes and removes again
    if (path === ".") fail(`${at}.link: "${path}" has to be a path below elmRoot`);
    if (path.split("/").includes("elm-stuff")) {
      fail(
        `${at}.link: "${path}" is the compiler's cache or lies in it. Every session's builds would write your own cache through the link, ` +
          `and sessions that run at the same time would share one. Leave it out: each checkout builds a cache of its own.`
      );
    }
    if (!existsSync(join(root, path))) fail(`${at}.link: ${join(root, path)} does not exist`);
    if (!`${realpathSync(dirname(join(root, path)))}/`.startsWith(`${realpathSync(root)}/`)) {
      fail(`${at}.link: "${path}" lies behind a link that leads out of elmRoot. Its place in a checkout would be outside the checkout.`);
    }
    const sourceDirectory = sources.find((directory) => overlap(directory, relative(root, resolve(root, path))));
    if (sourceDirectory !== undefined) {
      fail(
        `${at}.link: "${path}" holds Elm sources of the project (${sourceDirectory}). ` +
          `A session would edit your own files through the link. Commit those sources, or leave the directory out.`
      );
    }
  }
}

// The marks that can end a path in a word: a space, a quote, "=" and what joins the words of a shell script
const MARKS = "\\s'\"`=:;,&|<>()";
const MARK = new RegExp(`[${MARKS}]`, "g");
// What may stand in a word before a path: nothing, one of the marks, or an option as in "-o" or "--output="
const BEFORE_A_PATH = new RegExp(`(?:^|[${MARKS}])(?:-[\\w-]*)?$`);

/**
 * A test of whether a path leads to `root`, by what the places are and not by how they are
 * spelled. A file system that ignores letter case finds one directory under many spellings, and
 * the data volume of macOS has a second path to each place, under /System/Volumes/Data.
 */
function isPlaceOf(root) {
  // The device and the inode of what a path leads to, or null where nothing is there to look at
  const identity = (path) => {
    try {
      const stats = statSync(path, { throwIfNoEntry: false });
      return stats ? `${stats.dev} ${stats.ino}` : null;
    } catch {
      return null;
    }
  };
  const rootIs = identity(root);
  return (path) => rootIs !== null && identity(path) === rootIs;
}

/**
 * The path inside the repository that a word of the check command names by its whole path, if any.
 * The path can be the whole word, follow an option, as in "--output=<path>" or "-o<path>", or stand
 * in the script of `sh -c`. So every absolute path is taken out of the word. A path can hold a mark,
 * as a space under "My Projects", so it is tried up to each mark behind its start and up to the end of
 * the word. One with a space in it ends at no space, since a shell script has to quote it. One counts
 * when its way passes through the repository: the way looks up a name in the root, or leads to the root.
 * placeOf looks a name up in each directory above a place before it gets there, so a way to anything
 * in the repository looks a name up in the root.
 * Each link is followed as the system follows it, also to a file that is not there yet, as an output
 * is not. So a link from elsewhere can lead in, and a ".." behind a link leaves the place it led to.
 * A program of the repository can be a link to a place outside it, as a package manager's store
 * makes the compiler, and a session would still run the operator's copy through it.
 */
function pathInside(word, repo) {
  const isRoot = isPlaceOf(repo);
  const ends = [...[...word.matchAll(MARK)].map(({ index }) => index), word.length];
  const paths = [...word.matchAll(/\//g)]
    .filter(({ index }) => BEFORE_A_PATH.test(word.slice(0, index)))
    .flatMap(({ index: start }) =>
      ends
        .filter((end) => end > start && !(/\s/.test(word.charAt(end)) && /\s/.test(word.slice(start, end))))
        .map((end) => word.slice(start, end))
    );
  return paths.find((path) => {
    let through = false;
    const place = placeOf(path, (directory) => {
      through ||= isRoot(directory);
    });
    return through || (place !== null && isRoot(place));
  });
}

// What a JSON file holds. One that cannot be read is named, since the parser names no file.
function parsed(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    return fail(`${path} cannot be read: ${error.message}`);
  }
}

/** @returns {{ codebases: Codebase[] }} */
export function loadConfig(path) {
  const config = parsed(path);
  if (!Array.isArray(config?.codebases) || config.codebases.length === 0) {
    fail(`"codebases" must be a non-empty array`);
  }

  const codebases = config.codebases.map((entry, index) => {
    const at = `codebases[${index}]`;
    if (typeof entry !== "object" || entry === null) fail(`${at} must be an object`);
    if (typeof entry.label !== "string" || !/^[\w -]+$/.test(entry.label)) {
      fail(`${at}.label must be a short name made of letters, digits, spaces, "-" or "_"`);
    }
    if (typeof entry.repo !== "string") fail(`${at}.repo must be a path`);
    if (!Array.isArray(entry.check) || entry.check.length === 0 || entry.check.some((word) => typeof word !== "string")) {
      fail(`${at}.check must be a command as an array of strings`);
    }
    if (entry.check.includes("--optimize")) {
      fail(`${at}.check must not pass --optimize. One task asks for Debug.todo, which an optimized build rejects.`);
    }
    if (entry.link !== undefined && (!Array.isArray(entry.link) || entry.link.some((path) => typeof path !== "string"))) {
      fail(`${at}.link must be an array of paths`);
    }
    if (entry.elmRoot !== undefined && typeof entry.elmRoot !== "string") fail(`${at}.elmRoot must be a path`);
    if (entry.ref !== undefined && (typeof entry.ref !== "string" || entry.ref === "")) fail(`${at}.ref must name a commit, a branch or a tag`);
    if (entry.checkTimeoutMs !== undefined && !(Number.isInteger(entry.checkTimeoutMs) && entry.checkTimeoutMs > 0)) {
      fail(`${at}.checkTimeoutMs must be a whole number of milliseconds above 0`);
    }
    if (entry.checkTimeoutMs > LONGEST_TIMEOUT_MS) {
      fail(`${at}.checkTimeoutMs must be at most ${LONGEST_TIMEOUT_MS}, the longest that a timer of Node.js waits`);
    }

    // A relative repo path is relative to the config file
    const repo = resolve(dirname(path), entry.repo);
    // A session works in a checkout of its own, somewhere else. A command that names a program or a file
    // of the repository by its whole path runs the operator's copy, tells every session where that copy
    // lies, and leaves the language server of a checkout without the program.
    const inside = existsSync(repo) ? entry.check.map((word) => pathInside(word, repo)).find((path) => path !== undefined) : undefined;
    if (inside !== undefined) {
      fail(
        `${at}.check names ${inside}, a path inside the repository. Every session works in a checkout of its own, ` +
          `so name the path from elmRoot, as in "./node_modules/.bin/elm", also behind an option such as --output=, ` +
          `and list under "link" what a fresh checkout lacks.`
      );
    }
    // One spelling, whichever was given: "client", never "./client/", nor "Client" where a file system
    // that ignores letter case finds "client" under it. git's paths are compared with it.
    const elmRoot = relative(asSpelledOnDisk(repo), asSpelledOnDisk(resolve(repo, entry.elmRoot ?? "."))) || ".";
    if (elmRoot.startsWith("..")) fail(`${at}.elmRoot must be inside the repository`);
    if (!existsSync(join(repo, ".git"))) fail(`${at}.repo: ${repo} is not a git repository`);
    if (!existsSync(join(repo, elmRoot, "elm.json"))) fail(`${at}.elmRoot: no elm.json in ${join(repo, elmRoot)}`);
    // One spelling here too: relative to the Elm root, with no way out of it, and as the disk spells it.
    // The guards below compare it with "elm-stuff" and with the source directories.
    const link = (entry.link ?? []).map((path) => relative(asSpelledOnDisk(join(repo, elmRoot)), asSpelledOnDisk(resolve(repo, elmRoot, path))) || ".");
    for (const path of link) {
      if (path.startsWith("..")) fail(`${at}.link: "${path}" has to be a path below elmRoot`);
    }
    checkLayout(at, { repo, elmRoot, link });

    return {
      label: entry.label,
      repo,
      ref: entry.ref ?? "HEAD",
      elmRoot,
      check: entry.check,
      link,
      checkTimeoutMs: entry.checkTimeoutMs ?? CHECK_TIMEOUT_MS,
    };
  });

  // A label names files, and some file systems take "App" and "app" for one name
  const labels = codebases.map((codebase) => codebase.label.toLowerCase());
  if (new Set(labels).size !== labels.length) fail("codebase labels must be unique, whatever their case");
  return { codebases };
}
