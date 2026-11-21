/**
 * The benchmark harness, exercised without a model and without the Elm
 * compiler. tests/fakes/ holds stand-ins for both. A few tests check a verdict
 * against the real compiler and are skipped where elm 0.19.1 is not on PATH.
 * This file holds the tests that start processes, make worktrees, run the
 * command line, wait or send signals, so how long they take depends on the
 * machine's load. The tests that need none of that are in the other
 * tests/benchmark-*.test.mjs files.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, relative } from "path";
import { setTimeout as sleep } from "node:timers/promises";
import { ARMS, assertMcpServer, BENCHMARK_SOURCES, BUILT_IN_TOOLS, runAgent, stateOfSources } from "../benchmarks/lib/agent.mjs";
import { loadConfig } from "../benchmarks/lib/config.mjs";
import { assertIsolated } from "../benchmarks/lib/isolation.mjs";
import {
  changedFiles,
  closeLeftovers,
  committedFiles,
  createWorktree,
  isOnItsCommit,
  openCheckout,
  originalsOf,
  patchOf,
  removeWorktree,
  runCheck,
  stateOf,
} from "../benchmarks/lib/sandbox.mjs";
import { runGroup } from "../benchmarks/lib/process.mjs";
import { unmetExpectations } from "../benchmarks/lib/tasks.mjs";
import { copyFixture, installLanguageServerStandIn, REPO, runNode, tempDir, wrapperCopy } from "./support.mjs";
import { BENCH, left, SPREAD } from "./benchmark-support.mjs";

const FAKE_AGENT = join(REPO, "tests/fakes/claude.mjs");
const FAKE_COMPILER = join(REPO, "tests/fakes/elm-make.mjs");

// The same type and case expression in code and in a string that begins above the changed hunk.
const LAST_SHAPE_BRANCH = `        Triangle ->
            "triangle"
`;
const ADDED_SHAPE_BRANCH = `
        AddedByBenchmark ->
            Debug.todo "Handle this shape"
`;
const SHAPE_EXAMPLE = `module Main exposing (Shape(..), name, example)

type Shape
    = Circle
    | Square
    | Triangle

name : Shape -> String
name shape =
    case shape of
        Circle ->
            "circle"

        Square ->
            "square"

${LAST_SHAPE_BRANCH}
example : String
example =
    """An example

    type Shape
        = Circle
        | Square
        | Triangle

    case shape of
        Circle ->
            "circle"

        Square ->
            "square"

${LAST_SHAPE_BRANCH}    """
`;

const intoString = (text, added) => {
  const end = text.lastIndexOf(LAST_SHAPE_BRANCH) + LAST_SHAPE_BRANCH.length;
  return text.slice(0, end) + added + text.slice(end);
};
// Each mode adds the variant to the type and a branch for it to the code, and then makes its own
// edit. The verdict takes an edit that leaves the string as it was, and refuses any other.
const SHAPE_EDITS = {
  code: { edit: (text) => text, taken: true },
  body: { edit: (text) => text.replace('"Handle this shape"', '"""Handle\n\nthis shape"""'), taken: true },
  string: { edit: (text) => intoString(text, ADDED_SHAPE_BRANCH), taken: false },
  // With no blank line added, only the lexical context of the file tells these lines from a branch
  "string lines": { edit: (text) => intoString(text, ADDED_SHAPE_BRANCH.trimStart()), taken: false },
  "string type": { edit: (text) => text.replace("        | Triangle\n", "        | Triangle\n        | AddedByBenchmark\n"), taken: false },
  blank: { edit: (text) => text.replace('"""An example\n', '"""An example\n\n'), taken: false },
  remove: { edit: (text) => text.replace('"""An example\n\n', '"""An example\n'), taken: false },
};

const addShapeBranch = (before, mode) =>
  SHAPE_EDITS[mode].edit(before.replace("    | Triangle\n", "    | Triangle\n    | AddedByBenchmark\n").replace(LAST_SHAPE_BRANCH, LAST_SHAPE_BRANCH + ADDED_SHAPE_BRANCH));

test("an added branch is read in its whole file, and lines added inside a string that began further up are none", (t) => {
  const patchRoot = tempDir(t);
  const beforePath = join(tempDir(t), "Main.elm");
  writeFileSync(beforePath, SHAPE_EXAMPLE);
  for (const directory of [".", "client"]) {
    const elmRoot = join(patchRoot, directory);
    mkdirSync(join(elmRoot, "src"), { recursive: true });
    for (const [mode, { taken }] of Object.entries(SHAPE_EDITS)) {
      const file = join(elmRoot, "src/Main.elm");
      writeFileSync(file, addShapeBranch(SHAPE_EXAMPLE, mode));
      let patch;
      try {
        execFileSync("git", ["diff", "--no-index", "--no-color", beforePath, file], { stdio: "pipe" });
        assert.fail("the added variant changes the file");
      } catch (error) {
        assert.equal(error.status, 1);
        patch = error.stdout.toString().replace(/^\+\+\+ .*$/m, `+++ b/${relative(patchRoot, file)}`);
      }
      const problems = unmetExpectations(elmRoot, [{ kind: "adds-variant-and-branches", variant: "AddedByBenchmark" }],
        left({ patch, patchRoot, originals: new Map([["src/Main.elm", SHAPE_EXAMPLE]]) }));
      if (taken) assert.deepEqual(problems, [], `${directory}, ${mode}`);
      else assert.match(problems.join("\n"), /changed more than the variant and its branches/, `${directory}, ${mode}`);
    }
  }
});

test("the state of some sources is their last commit, and a digest of what is not committed in them", (t) => {
  const repo = gitRepository(copyFixture(t));
  // By its whole name: how far git shortens a commit is a setting, and changes as a repository grows
  const head = git(repo, "rev-parse", "HEAD").trim();
  const state = () => stateOfSources(repo, ["src", "elm.json"]);
  const uncommitted = new RegExp(`^${head}, with uncommitted changes [0-9a-f]{8}$`);
  assert.equal(state(), head);

  // Two different edits are two states, and the same edit is the same state again
  const main = join(repo, "src/Main.elm");
  const text = readFileSync(main, "utf-8");
  writeFileSync(main, `${text}\n-- one\n`);
  const one = state();
  assert.match(one, uncommitted);
  writeFileSync(main, `${text}\n-- two\n`);
  assert.notEqual(state(), one);
  writeFileSync(main, `${text}\n-- one\n`);
  assert.equal(state(), one);
  // A file that is made executable is another state, with the same bytes in it
  chmodSync(main, 0o755);
  assert.notEqual(state(), one);
  chmodSync(main, 0o644);
  writeFileSync(main, text);

  // A deleted file is a change, and an empty directory in its place is another one
  rmSync(main);
  const deleted = state();
  assert.match(deleted, uncommitted);
  mkdirSync(main);
  assert.notEqual(state(), deleted);
  rmSync(main, { recursive: true });
  writeFileSync(main, text);

  // A renamed file is the old one gone and a new one there. Once the rename is staged, git would name the new
  // file alone, as it does for a copy of the file beside the old one.
  const renamed = join(repo, "src/Renamed.elm");
  git(repo, "mv", "src/Main.elm", "src/Renamed.elm");
  const moved = state();
  git(repo, "mv", "src/Renamed.elm", "src/Main.elm");
  cpSync(main, renamed);
  git(repo, "add", "src/Renamed.elm");
  assert.notEqual(state(), moved);
  git(repo, "rm", "--quiet", "--cached", "src/Renamed.elm");
  rmSync(renamed);

  // A file that git does not track is code all the same once a tracked file imports it. One that git ignores is not.
  const helper = join(repo, "src/Helper.elm");
  writeFileSync(helper, "module Helper exposing (one)\n\n\none =\n    1\n");
  const untracked = state();
  assert.match(untracked, uncommitted);
  // The same file under another name is another state
  renameSync(helper, join(repo, "src/Helpers.elm"));
  assert.notEqual(state(), untracked);
  renameSync(join(repo, "src/Helpers.elm"), helper);
  writeFileSync(helper, "module Helper exposing (one)\n\n\none =\n    2\n");
  assert.notEqual(state(), untracked);
  // Staging a new file leaves the state as it was. Git moves the file from the untracked files, which come
  // after the changed ones, into the diff, which lists it before Main.elm.
  writeFileSync(main, `${text}\n-- one\n`);
  const unstaged = state();
  git(repo, "add", "src/Helper.elm");
  assert.equal(state(), unstaged);
  git(repo, "rm", "--quiet", "--cached", "src/Helper.elm");
  writeFileSync(main, text);
  rmSync(helper);
  writeFileSync(join(repo, ".git/info/exclude"), "*.elmi\n");
  writeFileSync(join(repo, "src/Main.elmi"), "built");
  assert.equal(state(), head);

  // A directory that is a repository of its own is listed by its name, with none of its files
  mkdirSync(join(repo, "src/vendored"));
  git(join(repo, "src/vendored"), "init", "--quiet");
  assert.match(state(), uncommitted);
  rmSync(join(repo, "src/vendored"), { recursive: true });
  assert.equal(state(), head);

  // A link counts by where it points. A file that holds the same path is another state.
  const link = join(repo, "src/Link.elm");
  symlinkSync("Main.elm", link);
  const linked = state();
  rmSync(link);
  symlinkSync("Types.elm", link);
  assert.notEqual(state(), linked);
  rmSync(link);
  writeFileSync(link, "Main.elm");
  assert.notEqual(state(), linked);
  rmSync(link);

  // The root can be a directory below the top of its repository, as it is where another repository vendors
  // this checkout. The changed files are named from there, as the untracked ones are.
  const below = () => stateOfSources(join(repo, "src"), ["."]);
  assert.equal(below(), head);
  writeFileSync(main, `${text}\n-- one\n`);
  const belowOne = below();
  writeFileSync(main, `${text}\n-- two\n`);
  assert.notEqual(below(), belowOne);
  writeFileSync(main, text);
  assert.equal(state(), head);

  // What changes beside those paths leaves the state alone, committed or not
  writeFileSync(join(repo, "README.md"), "# Notes\n");
  assert.equal(state(), head);
  git(repo, "add", "README.md");
  git(repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "--message", "notes");
  assert.equal(state(), head);

  // The operator's git can name the files of a diff from where it runs, give them no prefix and no lines of
  // context, and list a file as changed once it was written, until the index is refreshed. The state is the same.
  writeFileSync(main, `${text}\n-- one\n`);
  const edited = state();
  writeFileSync(main, text);
  for (const setting of ["diff.autoRefreshIndex=false", "diff.relative=true", "diff.noprefix=true", "diff.context=0"]) {
    git(repo, "config", ...setting.split("="));
  }
  // A file written again with the bytes it had is no change. Its time is set apart from the checkout's,
  // which git would otherwise take for the same moment.
  writeFileSync(main, readFileSync(main));
  execFileSync("touch", ["-m", "-t", "200001010000", main]);
  assert.equal(state(), head);
  writeFileSync(main, `${text}\n-- one\n`);
  assert.equal(state(), edited);

  // A commit of the edit makes it the last commit of those paths
  git(repo, "commit", "--quiet", "--all", "--message", "one");
  assert.equal(state(), git(repo, "rev-parse", "HEAD").trim());
  // The paths can leave a directory out
  assert.equal(stateOfSources(repo, [".", ":(exclude)src"]), git(repo, "rev-parse", "HEAD~1").trim());
  assert.equal(stateOfSources(tempDir(t), ["src"]), null);
});

test("a config is checked before anything runs", async (t) => {
  const dir = tempDir(t);
  const write = (config) => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    return join(dir, "config.json");
  };
  const repo = gitRepository(copyFixture(t));
  const valid = { label: "A", repo, check: ["true"] };

  assert.deepEqual(loadConfig(write({ codebases: [valid] })).codebases, [
    { label: "A", repo, ref: "HEAD", elmRoot: ".", check: ["true"], link: [], checkTimeoutMs: 600000 },
  ]);
  const invalid = [
    [{}, /"codebases" must be a non-empty array/],
    [{ codebases: [null] }, /codebases\[0\] must be an object/],
    [{ codebases: [{ ...valid, label: "../etc" }] }, /codebases\[0\]\.label must be a short name/],
    [{ codebases: [{ ...valid, check: "elm make" }] }, /codebases\[0\]\.check must be a command as an array of strings/],
    [{ codebases: [{ ...valid, repo: dir }] }, /is not a git repository/],
    [{ codebases: [{ ...valid, elmRoot: "client" }] }, /no elm\.json in /],
    [{ codebases: [valid, valid] }, /codebase labels must be unique/],
    // A label names files, and a file system may take the two for one
    [{ codebases: [valid, { ...valid, label: "a" }] }, /codebase labels must be unique, whatever their case/],
    [{ codebases: [{ ...valid, check: ["elm", "make", "src/Main.elm", "--optimize"] }] }, /check must not pass --optimize/],
    // A session has a checkout of its own, and the operator's copy of the compiler is no part of it
    [{ codebases: [{ ...valid, check: [join(repo, "node_modules/.bin/elm"), "make", "src/Main.elm"] }] }, /codebases\[0\]\.check names \S+node_modules\/\.bin\/elm, a path inside the repository\./],
    [{ codebases: [{ ...valid, elmRoot: 5 }] }, /codebases\[0\]\.elmRoot must be a path/],
    [{ codebases: [{ ...valid, ref: "" }] }, /codebases\[0\]\.ref must name a commit, a branch or a tag/],
    ...["soon", 0, -5, 1.5].map((checkTimeoutMs) => [{ codebases: [{ ...valid, checkTimeoutMs }] }, /codebases\[0\]\.checkTimeoutMs must be a whole number of milliseconds above 0/]),
    // A timer takes a longer time for 1 millisecond, and the check would fail at once
    [{ codebases: [{ ...valid, checkTimeoutMs: 2 ** 31 }] }, /codebases\[0\]\.checkTimeoutMs must be at most 2147483647, the longest that a timer of Node\.js waits/],
    [{ codebases: [{ ...valid, link: ["node_modules"] }] }, /codebases\[0\]\.link: .*node_modules does not exist/],
    // A link goes to the same place in every checkout, and a checkout has no place outside itself
    [{ codebases: [{ ...valid, link: ["../shared"] }] }, /link: "\.\.\/shared" has to be a path below elmRoot/],
    [{ codebases: [{ ...valid, link: ["."] }] }, /link: "\." has to be a path below elmRoot/],
    // Every session's builds would write the operator's own cache, and sessions side by side would share one
    [{ codebases: [{ ...valid, link: ["elm-stuff"] }] }, /link: "elm-stuff" is the compiler's cache or lies in it\. Every session's builds would write your own cache through the link/],
    [{ codebases: [{ ...valid, link: ["./elm-stuff/0.19.1"] }] }, /link: "elm-stuff\/0\.19\.1" is the compiler's cache or lies in it\./],
    [{ codebases: [{ ...valid, link: ["vendor/deps"] }] }, /link: "vendor\/deps" lies behind a link that leads out of elmRoot/],
    // A session would edit the original files through such a link
    [{ codebases: [{ ...valid, link: ["src"] }] }, /link: "src" holds Elm sources of the project \(src\)/],
    [{ codebases: [{ ...valid, link: ["src/Generated"] }] }, /link: "src\/Generated" holds Elm sources of the project \(src\)/],
  ];
  mkdirSync(join(repo, "src/Generated"));
  mkdirSync(join(dir, "elsewhere/deps"), { recursive: true });
  symlinkSync(join(dir, "elsewhere"), join(repo, "vendor"));
  for (const [config, message] of invalid) {
    assert.throws(() => loadConfig(write(config)), message);
  }
  // The longest that a timer waits is a limit like any other
  assert.equal(loadConfig(write({ codebases: [{ ...valid, checkTimeoutMs: 2 ** 31 - 1 }] })).codebases[0].checkTimeoutMs, 2 ** 31 - 1);
  // A program that lies elsewhere is named by its whole path like any other
  assert.deepEqual(loadConfig(write({ codebases: [{ ...valid, check: [process.execPath, "build.js"] }] })).codebases[0].check, [process.execPath, "build.js"]);
  // A package manager's store makes the compiler a link to a place outside the repository. A session still runs it from the operator's copy.
  mkdirSync(join(dir, "store/elm/bin"), { recursive: true });
  writeFileSync(join(dir, "store/elm/bin/elm"), "");
  mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
  symlinkSync(join(dir, "store/elm/bin/elm"), join(repo, "node_modules/.bin/elm"));
  assert.throws(
    () => loadConfig(write({ codebases: [{ ...valid, check: [join(repo, "node_modules/.bin/elm"), "make", "src/Main.elm"] }] })),
    /codebases\[0\]\.check names \S+node_modules\/\.bin\/elm, a path inside the repository\./
  );
  // A link in another directory leads into the repository as well, though the word spells neither of its paths
  mkdirSync(join(repo, "scripts"));
  writeFileSync(join(repo, "scripts/check.sh"), "");
  symlinkSync(join(repo, "scripts"), join(dir, "tools"));
  assert.throws(
    () => loadConfig(write({ codebases: [{ ...valid, check: [join(dir, "tools/check.sh")] }] })),
    (error) => error.message.includes(`codebases[0].check names ${join(dir, "tools/check.sh")}, a path inside the repository.`)
  );
  // A path can hold a space, as under a directory called "My Projects". The whole word is the path then.
  // Cut at the space, it would end in a place that is not there.
  const spaced = gitRepository(copyFixture(t, "My Projects"));
  assert.throws(
    () => loadConfig(write({ codebases: [{ ...valid, repo: spaced, check: [join(spaced, "node_modules/.bin/elm"), "make", "src/Main.elm"] }] })),
    (error) => error.message.includes(`codebases[0].check names ${join(spaced, "node_modules/.bin/elm")}, a path inside the repository.`)
  );
  // Behind an option such a path runs to the end of the word, and in a shell script to its closing quote
  const spacedBundle = join(spaced, "bundle.js");
  const spacedNamed = [
    [["elm", "make", "src/Main.elm", `--output=${spacedBundle}`], spacedBundle],
    [["sh", "-c", `elm make src/Main.elm --output="${spacedBundle}"`], spacedBundle],
    [["sh", "-c", `"${join(spaced, "node_modules/.bin/elm")}" make src/Main.elm`], join(spaced, "node_modules/.bin/elm")],
    [["sh", "-c", `cd "${spaced}" && elm make src/Main.elm`], spaced],
  ];
  for (const [check, path] of spacedNamed) {
    assert.throws(
      () => loadConfig(write({ codebases: [{ ...valid, repo: spaced, check }] })),
      (error) => error.message.includes(`codebases[0].check names ${path}, a path inside the repository.`),
      check.join(" ")
    );
  }
  // A path with a space of its own lies elsewhere, also one that begins like the repository's. Its part up to the
  // space would be the repository, but a path with a space in it ends at no space.
  const spacedNeighbour = join(dirname(spaced), "My Projects copy/elm.js");
  const spacedElsewhere = [
    ["elm", "make", "src/Main.elm", `--output=${spacedNeighbour}`],
    ["sh", "-c", `elm make src/Main.elm --output="${join(dir, "Other Builds/elm.js")}"`],
    ["sh", "-c", `elm make src/Main.elm --output="${join(dir, "elm.js")}" && cp "${join(dir, "elm.js")}" "${spacedNeighbour}"`],
  ];
  for (const check of spacedElsewhere) {
    assert.deepEqual(loadConfig(write({ codebases: [{ ...valid, repo: spaced, check }] })).codebases[0].check, check);
  }

  // A path of the repository behind an option or in a shell script would write the operator's copy all the same,
  // spelled as the config gives the repository, here through a link, and as it really lies
  const linked = join(dir, "linked");
  symlinkSync(repo, linked);
  const bundle = join(repo, "bundle.js");
  const named = [
    [`--output=${bundle}`, bundle],
    [`-o${bundle}`, bundle],
    [`--output=${join(linked, "bundle.js")}`, join(linked, "bundle.js")],
    [join(linked, "bundle.js"), join(linked, "bundle.js")],
    [`elm make src/Main.elm --output="${bundle}" && echo built`, bundle],
    [`cd ${linked} && elm make src/Main.elm`, linked],
  ];
  for (const [word, path] of named) {
    for (const check of [["elm", "make", "src/Main.elm", word], ["sh", "-c", word]]) {
      assert.throws(
        () => loadConfig(write({ codebases: [{ ...valid, repo: linked, check }] })),
        (error) => error.message.includes(`codebases[0].check names ${path}, a path inside the repository.`),
        word
      );
    }
  }
  // A path that only begins like the repository's, or ends like it, lies elsewhere. So does one that leads out of it,
  // also from behind the link, where ".." leaves the place the link led to and not the directory of the link.
  // Read as it is written, the last one would lie in the repository behind the link, where the system does not go.
  const elsewhere = [
    `--output=${repo}-build/elm.js`,
    `${repo}lication/x`,
    `-o${repo}lication/x`,
    `/elsewhere${repo}/x`,
    `--output=${repo}/../elm.js`,
    "--output=build/elm.js",
    `--output=${linked}/../linked/elm.js`,
  ];
  for (const word of elsewhere) {
    for (const check of [["elm", "make", "src/Main.elm", word], ["sh", "-c", `elm make src/Main.elm ${word}`]]) {
      assert.deepEqual(loadConfig(write({ codebases: [{ ...valid, repo: linked, check }] })).codebases[0].check, check);
    }
  }
  // Every link on the way is followed, also to a file that is not there yet, as an output is not. Here the config
  // spells the repository as it really lies, and the words spell it neither that way nor as the link does.
  writeFileSync(bundle, "");
  // The repository's path with its last "/" spelled another way, and a file in it
  const spelled = (slash) => `${repo.replace(/\/(?=[^/]*$)/, slash)}/x`;
  const through = [
    [join(linked, "elm.json"), join(linked, "elm.json")],
    [join(linked, "public/main.js"), join(linked, "public/main.js")],
    [`--output=${join(linked, "public/main.js")}`, join(linked, "public/main.js")],
    [`--output=${join(linked, "bundle.js")}`, join(linked, "bundle.js")],
    [`--output=${spelled("/./")}`, spelled("/./")],
    [`--output=${spelled("//")}`, spelled("//")],
    // The same ".." leads into the repository where the path, spelled out, would lie beside the link
    [`--output=${linked}/../${repo.split("/").pop()}/x`, `${linked}/../${repo.split("/").pop()}/x`],
    // The way to the compiler of the store passes through the repository, though the place it leads to lies outside
    [join(linked, "node_modules/.bin/elm"), join(linked, "node_modules/.bin/elm")],
    [`--compiler=${join(linked, "node_modules/.bin/elm")}`, join(linked, "node_modules/.bin/elm")],
  ];
  for (const [word, path] of through) {
    for (const check of [["elm", "make", "src/Main.elm", word], ["sh", "-c", word]]) {
      assert.throws(
        () => loadConfig(write({ codebases: [{ ...valid, check }] })),
        (error) => error.message.includes(`codebases[0].check names ${path}, a path inside the repository.`),
        word
      );
    }
  }
  // A neighbour of the repository lies elsewhere, behind the link as well
  for (const word of [`--output=${linked}-build/elm.js`, `--output=${spelled("//").replace(/\/x$/, "-build/x")}`]) {
    assert.deepEqual(loadConfig(write({ codebases: [{ ...valid, check: ["elm", "make", word] }] })).codebases[0].check, ["elm", "make", word]);
  }

  // A file that is no JSON is named, the config and the elm.json of a codebase alike
  writeFileSync(join(dir, "config.json"), '{ "codebases": [');
  assert.throws(() => loadConfig(join(dir, "config.json")), /config\.json cannot be read: /);
  mkdirSync(join(repo, "broken"));
  writeFileSync(join(repo, "broken/elm.json"), "{");
  assert.throws(() => loadConfig(write({ codebases: [{ ...valid, elmRoot: "broken" }] })), /broken\/elm\.json cannot be read: /);

  // However the Elm root is spelled, it is kept in the form git's paths are compared with
  mkdirSync(join(repo, "client"));
  writeFileSync(join(repo, "client/elm.json"), "{}");
  const rootOf = (elmRoot) => loadConfig(write({ codebases: [{ ...valid, elmRoot }] })).codebases[0].elmRoot;
  assert.deepEqual(["./", ".", "./client/", "client/../client"].map(rootOf), [".", ".", "client", "client"]);
  assert.throws(() => rootOf("../elsewhere"), /elmRoot must be inside the repository/);

  // One directory can have spellings that are no links. The guard tells a place by what it is, and the Elm root
  // is spelled as the disk spells it. Lowercasing would take two directories for one where letter case counts.
  const refused = (check, path, more = {}) =>
    assert.throws(
      () => loadConfig(write({ codebases: [{ ...valid, ...more, check }] })),
      (error) => error.message.includes(`codebases[0].check names ${path}, a path inside the repository.`),
      check.join(" ")
    );
  const shouted = repo.replace(/[^/]+$/, (name) => name.toUpperCase());
  await t.test("another letter case", { skip: !sameDirectory(repo, shouted) && "the file system of the test tells upper from lower case" }, () => {
    refused([join(shouted, "node_modules/.bin/elm"), "make", "src/Main.elm"], join(shouted, "node_modules/.bin/elm"));
    // An output that is there and one that is not yet
    refused(["elm", "make", "src/Main.elm", `--output=${join(shouted, "bundle.js")}`], join(shouted, "bundle.js"));
    refused(["elm", "make", "src/Main.elm", `--output=${join(shouted, "build/elm.js")}`], join(shouted, "build/elm.js"));
    // The config spells the repository in another case than the disk, and the check spells it as the disk does
    refused(["elm", "make", "src/Main.elm", `--output=${bundle}`], bundle, { repo: shouted });
    // A neighbour in another case lies elsewhere still
    const neighbour = ["elm", "make", "src/Main.elm", `--output=${shouted}-build/elm.js`];
    assert.deepEqual(loadConfig(write({ codebases: [{ ...valid, check: neighbour }] })).codebases[0].check, neighbour);
    assert.equal(rootOf("CLIENT"), "client");
    assert.equal(loadConfig(write({ codebases: [{ ...valid, repo: shouted, elmRoot: "Client" }] })).codebases[0].elmRoot, "client");
    // A link is read as the disk spells it, so the operator's cache and a source directory are known in any case
    mkdirSync(join(repo, "elm-stuff"));
    mkdirSync(join(repo, "generated"));
    const elmJson = readFileSync(join(repo, "elm.json"), "utf-8");
    writeFileSync(join(repo, "elm.json"), JSON.stringify({ ...JSON.parse(elmJson), "source-directories": ["src", "generated"] }));
    try {
      assert.deepEqual(loadConfig(write({ codebases: [{ ...valid, repo: shouted, link: ["Node_Modules"] }] })).codebases[0].link, ["node_modules"]);
      assert.throws(() => loadConfig(write({ codebases: [{ ...valid, link: ["Elm-Stuff"] }] })), /link: "elm-stuff" is the compiler's cache or lies in it\./);
      assert.throws(() => loadConfig(write({ codebases: [{ ...valid, link: ["Generated"] }] })), /link: "generated" holds Elm sources of the project \(generated\)/);
    } finally {
      writeFileSync(join(repo, "elm.json"), elmJson);
      for (const directory of ["elm-stuff", "generated"]) rmSync(join(repo, directory), { recursive: true });
    }
  });
  // macOS keeps every place of its data volume under a second path as well
  const onDataVolume = join("/System/Volumes/Data", repo);
  await t.test("the data volume of macOS", { skip: !(existsSync(onDataVolume) && sameDirectory(repo, onDataVolume)) && "no /System/Volumes/Data leads to the test's directory" }, () => {
    refused(["elm", "make", "src/Main.elm", `--output=${join(onDataVolume, "bundle.js")}`], join(onDataVolume, "bundle.js"));
    refused(["elm", "make", "src/Main.elm", `--output=${bundle}`], bundle, { repo: onDataVolume });
  });
  // A letter with an accent can be written as one character or as a letter and the accent
  const accented = gitRepository(copyFixture(t, "Caf\u00e9"));
  const decomposed = accented.normalize("NFD");
  await t.test("the two Unicode forms of a name", { skip: !sameDirectory(accented, decomposed) && "the file system of the test takes the two forms for two names" }, () => {
    refused(["elm", "make", "src/Main.elm", `--output=${join(decomposed, "bundle.js")}`], join(decomposed, "bundle.js"), { repo: accented });
    refused(["elm", "make", "src/Main.elm", `--output=${join(accented, "bundle.js")}`], join(accented, "bundle.js"), { repo: decomposed });
  });

  // Sources outside the Elm root are out of the benchmark's sight
  const elmJson = JSON.parse(readFileSync(join(repo, "elm.json"), "utf-8"));
  writeFileSync(join(repo, "elm.json"), JSON.stringify({ ...elmJson, "source-directories": ["src", "../shared"] }));
  assert.throws(() => loadConfig(write({ codebases: [valid] })), /the source directory "\.\.\/shared" of elm\.json is outside elmRoot/);
});

// Inside a hook git tells its commands where the repository is. Every git command of these
// tests would then work there, and not in the repository that the test made.
for (const place of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
  delete process.env[place];
}

// git in a test repository, with an identity and without signing, whatever this machine's configuration says
const git = (repo, ...args) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]).toString();

const worktreesOf = (repo) => git(repo, "worktree", "list").trim().split("\n").length;

// True when two paths lead to one directory: a file written under the one is there under the other
function sameDirectory(a, b) {
  const probe = `same-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(join(a, probe), probe);
  try {
    return existsSync(join(b, probe)) && readFileSync(join(b, probe), "utf-8") === probe;
  } finally {
    rmSync(join(a, probe), { force: true });
  }
}

// Turn a directory into a git repository with one commit.
function gitRepository(dir) {
  git(dir, "init", "--quiet");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "--message", "fixture");
  return dir;
}

test("a worktree reports what the agent changed, and nothing the harness put there", async (t) => {
  const repo = copyFixture(t);
  // A package that came through npm and is committed, and that elm.json lists as a source directory
  mkdirSync(join(repo, "vendor/node_modules/shared/src"), { recursive: true });
  writeFileSync(join(repo, "vendor/node_modules/shared/src/Palette.elm"), "module Palette exposing (red)\n");
  const elmJson = JSON.parse(readFileSync(join(repo, "elm.json"), "utf-8"));
  writeFileSync(join(repo, "elm.json"), JSON.stringify({ ...elmJson, "source-directories": ["src", "./vendor/node_modules/shared/src/"] }));
  gitRepository(repo);
  mkdirSync(join(repo, "node_modules"));
  const codebase = { repo, ref: "HEAD", elmRoot: ".", link: ["node_modules"] };
  const dir = join(tempDir(t), "worktree");

  // A hook of the operator's repository, which a checkout would set off
  writeFileSync(join(repo, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch "${join(repo, "hook-ran")}"\n`, { mode: 0o755 });
  // The operator's git colors its output, shows changes through a program of its own, and shows no lines of context around them
  git(repo, "config", "color.ui", "always");
  git(repo, "config", "diff.external", "false");
  git(repo, "config", "diff.context", "0");
  const objects = () => git(repo, "count-objects", "-v");
  const objectsBefore = objects();

  const worktree = await createWorktree(codebase, dir);
  assert.equal(existsSync(join(repo, "hook-ran")), false, "the repository's hooks stay out of it");
  assert.equal(realpathSync(join(dir, "node_modules")), realpathSync(join(repo, "node_modules")));
  assert.deepEqual(await changedFiles(worktree, codebase), []);
  assert.equal(await patchOf(worktree, []), "");

  // An edit, a new file with a space and an accent in its path, a deletion, and the compiler's cache
  writeFileSync(join(dir, "src/Main.elm"), "module Main exposing (main)\n");
  mkdirSync(join(dir, "src/New Dir"));
  writeFileSync(join(dir, "src/New Dir/Extra.elm"), "module Extra exposing (x)\n");
  writeFileSync(join(dir, "src/Café.elm"), "module Café exposing (x)\n");
  rmSync(join(dir, "src/Utils.elm"));
  mkdirSync(join(dir, "elm-stuff/0.19.1"), { recursive: true });
  writeFileSync(join(dir, "elm-stuff/0.19.1/Main.elmo"), "cache");
  // And the packages of a tool that a session installed, with the Elm files such a package brings:
  // one that git does not track, and one that it ignores
  mkdirSync(join(dir, "review/node_modules/elm-review/template"), { recursive: true });
  writeFileSync(join(dir, "review/node_modules/elm-review/template/ReviewConfig.elm"), "module ReviewConfig exposing (config)\n");
  writeFileSync(join(repo, ".git/info/exclude"), "/tools/\n");
  mkdirSync(join(dir, "tools/node_modules/elm-test/templates"), { recursive: true });
  writeFileSync(join(dir, "tools/node_modules/elm-test/templates/Example.elm"), "module Example exposing (suite)\n");

  const changed = await changedFiles(worktree, codebase);
  assert.deepEqual(changed, ["src/Café.elm", "src/Main.elm", "src/New Dir/Extra.elm", "src/Utils.elm"]);
  const patch = await patchOf(worktree, changed);
  assert.match(patch, /^\+module Extra exposing \(x\)$/m);
  assert.match(patch, /^deleted file mode/m);
  assert.match(patch, /^-main =$/m, "the patch is plain text, whatever the repository is configured to show");
  assert.match(patch, /^ module Main exposing \(main\)$/m);
  // The verdict reads the file names off these lines, so they are printed as they are
  assert.match(patch, /^diff --git a\/src\/Café\.elm b\/src\/Café\.elm$/m);
  assert.ok(!patch.includes("elm-stuff") && !patch.includes("node_modules"), "the patch holds the agent's changes only");
  // The worktree shares its object store with the operator's checkout. Reading the changes adds nothing to it.
  assert.equal(objects(), objectsBefore);
  // What already differed before the session began, and still does in the same way, is not the session's doing
  const before = await stateOf(worktree, codebase);
  assert.deepEqual([...before.keys()], changed);
  assert.deepEqual(await changedFiles(worktree, codebase, before), []);
  writeFileSync(join(dir, "src/Main.elm"), "module Main exposing (main)\n\n-- once more\n");
  assert.deepEqual(await changedFiles(worktree, codebase, before), ["src/Main.elm"]);
  // What the commit holds below a directory called node_modules is a source like any other
  writeFileSync(join(dir, "vendor/node_modules/shared/src/Palette.elm"), "module Palette exposing (blue)\n");
  assert.deepEqual(await changedFiles(worktree, codebase, before), ["src/Main.elm", "vendor/node_modules/shared/src/Palette.elm"]);
  assert.match(await patchOf(worktree, ["vendor/node_modules/shared/src/Palette.elm"]), /^\+module Palette exposing \(blue\)$/m);
  // And so is a module that a session adds to that source directory, or moves within it. What a
  // package below it brings is none, as the scan of the project has it.
  writeFileSync(join(dir, "vendor/node_modules/shared/src/Tint.elm"), "module Tint exposing (tint)\n");
  mkdirSync(join(dir, "vendor/node_modules/shared/src/node_modules/dep"), { recursive: true });
  writeFileSync(join(dir, "vendor/node_modules/shared/src/node_modules/dep/Deep.elm"), "module Deep exposing (deep)\n");
  const withTint = ["src/Main.elm", "vendor/node_modules/shared/src/Palette.elm", "vendor/node_modules/shared/src/Tint.elm"];
  assert.deepEqual(await changedFiles(worktree, codebase, before), withTint);
  assert.match(await patchOf(worktree, withTint), /^\+module Tint exposing \(tint\)$/m);

  // A second worktree at the same place replaces what an interrupted run left behind
  await createWorktree(codebase, dir);
  assert.deepEqual(await changedFiles(worktree, codebase), []);
  await removeWorktree(codebase, dir);
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(join(repo, "node_modules")), true, "removing a worktree leaves the linked directory alone");
});

test("a patch shows the lines of a file that the repository's attributes call no text", async (t) => {
  // The repository shows no diff of its Elm files, as one can for generated code
  const repo = copyFixture(t);
  writeFileSync(join(repo, ".gitattributes"), "*.elm -diff\n");
  writeFileSync(join(repo, "src/Shapes.elm"), "module Shapes exposing (Shape(..), sides)\n\n\ntype Shape\n    = Circle\n    | Square\n\n\nsides : Shape -> Int\nsides shape =\n    case shape of\n        Circle ->\n            0\n\n        Square ->\n            4\n");
  gitRepository(repo);
  const codebase = { repo, ref: "HEAD", elmRoot: ".", link: [] };
  const dir = join(tempDir(t), "worktree");
  const worktree = await createWorktree(codebase, dir);
  const judged = async () => {
    const changed = await changedFiles(worktree, codebase);
    return unmetExpectations(worktree.elmRoot, [{ kind: "adds-variant-and-branches", variant: "Dot" }], left({ changed, patch: await patchOf(worktree, changed) }));
  };

  // The variant and its branch, in a file whose changes git would sum up as "Binary files differ"
  const shapes = readFileSync(join(dir, "src/Shapes.elm"), "utf-8");
  writeFileSync(join(dir, "src/Shapes.elm"), `${shapes.replace("    | Square\n", "    | Square\n    | Dot\n")}\n        Dot ->\n            Debug.todo "Dot"\n`);
  assert.match(await patchOf(worktree, ["src/Shapes.elm"]), /^\+    \| Dot$/m);
  assert.deepEqual(await judged(), []);

  // And a string that the task did not ask to change, in another such file
  const main = readFileSync(join(dir, "src/Main.elm"), "utf-8");
  writeFileSync(join(dir, "src/Main.elm"), main.replace('" - Formatted: "', '" - formatted: "'));
  assert.match((await judged())[0], /^changed more than the variant and its branches: /);
  // A file the commit does not hold is shown as text too
  writeFileSync(join(dir, "src/New.elm"), "module New exposing (x)\n");
  assert.match(await patchOf(worktree, ["src/New.elm"]), /^\+module New exposing \(x\)$/m);
  await removeWorktree(codebase, dir);
});

test("a file's starting text is read as the checkout wrote it, with the line ends the repository asks for", async (t) => {
  const repo = copyFixture(t);
  writeFileSync(join(repo, ".gitattributes"), "*.elm text eol=crlf\n");
  writeFileSync(join(repo, "src/Notes.elm"), 'module Notes exposing (heading, note)\n\n\nheading : String\nheading =\n    "Notes"\n\n\nnote : String\nnote =\n    """first line\nsecond line"""\n');
  gitRepository(repo);
  const codebase = { repo, ref: "HEAD", elmRoot: ".", link: [] };
  const dir = join(tempDir(t), "worktree");
  const worktree = await createWorktree(codebase, dir);
  // The commit has the file with line feeds. The checkout has a carriage return in front of each, in the string too.
  const notes = readFileSync(join(dir, "src/Notes.elm"), "utf-8");
  assert.match(notes, /first line\r\nsecond line/);

  writeFileSync(join(dir, "src/Notes.elm"), notes.replaceAll("heading", "headingRenamed"));
  const changed = await changedFiles(worktree, codebase);
  assert.deepEqual(changed, ["src/Notes.elm"]);
  const renames = { kind: "renames-only", of: "function", from: "heading", to: "headingRenamed" };
  assert.deepEqual(unmetExpectations(worktree.elmRoot, [renames], left({ changed, originals: await originalsOf(worktree, changed) })), []);
  await removeWorktree(codebase, dir);
});

test("a patch shows a file that is no text in one line, unless a verdict reads it", async (t) => {
  const repo = gitRepository(copyFixture(t));
  const codebase = { repo, ref: "HEAD", elmRoot: ".", link: [] };
  const dir = join(tempDir(t), "worktree");
  const worktree = await createWorktree(codebase, dir);
  // What a build leaves behind, and an Elm file with the same bytes in it
  const bytes = Buffer.from([0x6d, 0x00, 0x01, 0x02, 0x0a]);
  writeFileSync(join(dir, "bundle.bin"), bytes);
  writeFileSync(join(dir, "src/Odd.elm"), bytes);

  const patch = await patchOf(worktree, ["bundle.bin", "src/Odd.elm"]);
  assert.match(patch, /^Binary files \/dev\/null and b\/bundle\.bin differ$/m);
  assert.match(patch, /^\+\+\+ b\/src\/Odd\.elm$/m);
  assert.doesNotMatch(patch, /^Binary files .*Odd\.elm/m);
  await removeWorktree(codebase, dir);
});

test("a worktree reports a change beside the Elm project as well, named from the project's root", async (t) => {
  // The Elm project is one directory of the repository, and a README and another program lie beside it
  const repo = tempDir(t);
  cpSync(copyFixture(t), join(repo, "client"), { recursive: true });
  mkdirSync(join(repo, "admin"));
  writeFileSync(join(repo, "README.md"), "How to build\n");
  writeFileSync(join(repo, "admin/elm.json"), "{}\n");
  gitRepository(repo);
  // The operator's git names the files of a diff from where it runs and leaves out the rest, gives
  // them no prefix, and lists a file as changed once it was written, until the index is refreshed
  git(repo, "config", "diff.relative", "true");
  git(repo, "config", "diff.noprefix", "true");
  git(repo, "config", "diff.autoRefreshIndex", "false");
  const codebase = { repo, ref: "HEAD", elmRoot: "client", link: [] };
  const dir = join(tempDir(t), "worktree");
  const worktree = await createWorktree(codebase, dir);
  assert.deepEqual(await changedFiles(worktree, codebase), []);
  // A file written again with the bytes it had, as a script that rewrites every file does, is no change.
  // Its time is set apart from the checkout's, which git would otherwise take for the same moment.
  const rewritten = ["README.md", "client/src/Main.elm"].map((file) => join(dir, file));
  for (const file of rewritten) writeFileSync(file, readFileSync(file));
  execFileSync("touch", ["-m", "-t", "200001010000", ...rewritten]);
  assert.deepEqual(await changedFiles(worktree, codebase), []);
  const committed = await committedFiles(worktree);
  assert.deepEqual(["src/Main.elm", "elm.json", "../README.md", "../admin/elm.json", "README.md"].map((file) => committed.has(file)), [true, true, true, true, false]);

  // What a build did before the session is not the session's doing, beside the project as in it
  writeFileSync(join(dir, "build.log"), "built\n");
  const before = await stateOf(worktree, codebase);
  assert.deepEqual([...before.keys()], ["../build.log"]);

  writeFileSync(join(dir, "README.md"), "Nothing to build\n");
  writeFileSync(join(dir, "admin/elm.json"), '{ "type": "application" }\n');
  writeFileSync(join(dir, "notes.txt"), "done\n");
  writeFileSync(join(dir, "client/src/Main.elm"), "module Main exposing (main)\n");
  const changed = await changedFiles(worktree, codebase, before);
  assert.deepEqual(changed, ["../README.md", "../admin/elm.json", "../notes.txt", "src/Main.elm"]);
  const patch = await patchOf(worktree, changed);
  assert.match(patch, /^-How to build$/m);
  assert.match(patch, /^\+done$/m);
  // A new file is named from the top of the checkout, like the files the commit holds
  assert.match(patch, /^diff --git a\/notes\.txt b\/notes\.txt$/m);
  assert.match(patch, /^diff --git a\/client\/src\/Main\.elm b\/client\/src\/Main\.elm$/m);
  writeFileSync(join(dir, "client/src/New.elm"), "module New exposing (x)\n");
  assert.match(await patchOf(worktree, ["src/New.elm"]), /^diff --git a\/client\/src\/New\.elm b\/client\/src\/New\.elm$/m);
  // The text of an elm.json is kept for the verdict, wherever the file lies
  assert.deepEqual([...(await originalsOf(worktree, changed, before))], [
    ["../admin/elm.json", "{}\n"],
    ["src/Main.elm", readFileSync(join(repo, "client/src/Main.elm"), "utf-8")],
  ]);

  // The operator's git can also line up the two versions of a file another way, cut the changes into
  // hunks another way, and leave a blank line of context empty. Each of those would change the patch of
  // this edit: a module imported twice, a new variant, and the branches of a case in another order.
  const main = readFileSync(join(repo, "client/src/Main.elm"), "utf-8")
    .replace("import Browser\n", "import Browser\nimport Browser\n")
    .replace("    | Decrement\n", "    | Decrement\n    | Reset\n")
    .replace(/( {8}Increment ->\n.*\n)\n( {8}Decrement ->\n.*\n)/, "$2\n$1\n        Reset ->\n            { model | count = 0 }\n");
  writeFileSync(join(dir, "client/src/Main.elm"), main);
  const plain = await patchOf(worktree, ["src/Main.elm"]);
  for (const added of ["import Browser", "    | Reset", "        Decrement ->", "        Reset ->"]) assert.ok(plain.includes(`\n+${added}\n`), added);
  for (const setting of ["diff.algorithm=patience", "diff.indentHeuristic=false", "diff.interHunkContext=10", "diff.suppressBlankEmpty=true"]) {
    git(repo, "config", ...setting.split("="));
  }
  // And the environment can ask for no lines of context, which git takes over the benchmark's --unified
  process.env.GIT_DIFF_OPTS = "-u0";
  t.after(() => delete process.env.GIT_DIFF_OPTS);
  assert.equal(await patchOf(worktree, ["src/Main.elm"]), plain);
  await removeWorktree(codebase, dir);
});

test("a session's changes are seen through a commit, in a file git ignores and in one the build made", async (t) => {
  const repo = copyFixture(t);
  writeFileSync(join(repo, ".gitignore"), "src/Generated.elm\nsrc/Copy.ELM\n");
  gitRepository(repo);
  const codebase = { repo, ref: "HEAD", elmRoot: ".", link: [] };
  const worktree = await createWorktree(codebase, join(tempDir(t), "worktree"));
  const at = (file) => join(worktree.dir, file);
  const generated = (value) => `module Generated exposing (x)\n\n\nx =\n    ${value}\n`;
  const main = readFileSync(at("src/Main.elm"), "utf-8");

  // The operator's shell can tell git how to read a pathspec. Then "*.elm" names no file in a directory, or also one
  // that ends in ".ELM". git takes no glob and noglob at once, and the benchmark's git has to go without each of them.
  const pathspecs = ["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"];
  const underPathspecs = async (action) => {
    for (const name of pathspecs) process.env[name] = "1";
    try {
      return await action();
    } finally {
      for (const name of pathspecs) delete process.env[name];
    }
  };

  // The build before the session generates a module, which git ignores
  writeFileSync(at("src/Generated.elm"), generated(1));
  const before = await underPathspecs(() => stateOf(worktree, codebase));
  assert.deepEqual([...before.keys()], ["src/Generated.elm"]);
  assert.deepEqual(await changedFiles(worktree, codebase, before), []);

  // The session edits that module and a tracked one, and commits, though it was told not to. Its copy of a module
  // that git ignores is no Elm source.
  writeFileSync(at("src/Generated.elm"), generated(2));
  writeFileSync(at("src/Main.elm"), `${main}\n-- more\n`);
  writeFileSync(at("src/Copy.ELM"), generated(2));
  git(worktree.dir, "commit", "--quiet", "--all", "--message", "out of sight");
  assert.equal(git(worktree.dir, "status", "--porcelain"), "", "git status has nothing to show for it");

  const changed = await underPathspecs(() => changedFiles(worktree, codebase, before));
  assert.deepEqual(changed, ["src/Generated.elm", "src/Main.elm"]);
  assert.equal(await isOnItsCommit(worktree), false);
  const patch = await patchOf(worktree, changed);
  assert.match(patch, /^\+-- more$/m);
  assert.match(patch, /^\+    2$/m);
  // What each file held when the session began: the build's text for one, the commit's for the other
  assert.deepEqual([...(await originalsOf(worktree, changed, before))], [
    ["src/Generated.elm", generated(1)],
    ["src/Main.elm", main],
  ]);
  // What the starting commit holds is read from that commit, whatever the session did to its index
  git(worktree.dir, "rm", "--quiet", "--cached", "src/Types.elm");
  const committed = await committedFiles(worktree);
  assert.deepEqual(["src/Main.elm", "src/Types.elm", "src/Generated.elm"].map((file) => committed.has(file)), [true, true, false]);
  await removeWorktree(codebase, worktree.dir);
  assert.equal(worktreesOf(repo), 1);
});

test("a commit with a link that leads out of the checkout is not checked out, and no link is made or removed behind one", async (t) => {
  // The repository commits "vendor" as a link to a directory of the operator's, where a link called "deps" already is
  const repo = copyFixture(t);
  const elsewhere = join(tempDir(t), "elsewhere");
  mkdirSync(join(elsewhere, "real-deps"), { recursive: true });
  symlinkSync("real-deps", join(elsewhere, "deps"));
  symlinkSync(elsewhere, join(repo, "vendor"));
  // And a link to a file that is not there yet. A session that wrote to it would put one there.
  symlinkSync(join(elsewhere, "later.json"), join(repo, "settings.json"));
  gitRepository(repo);
  const codebase = { label: "Linked", repo, ref: "HEAD", elmRoot: ".", link: ["vendor/deps"] };
  const dir = join(tempDir(t), "worktree");

  await assert.rejects(
    createWorktree(codebase, dir),
    /Linked: in HEAD, "settings\.json" is a link that leads out of the checkout, or to no place that can be made out, and so do 1 more\. A session that edits such a path changes what it points to/
  );
  // Neither the failed setup nor its cleanup touched what is the operator's
  assert.equal(readlinkSync(join(elsewhere, "deps")), "real-deps");
  assert.equal(existsSync(dir), false);
  assert.equal(worktreesOf(repo), 1);

  // A link that stays in the checkout is a file of the checkout under another name: one to a file
  // that is there, one to a file that is not there yet, and one to the top of the checkout
  git(repo, "rm", "--quiet", "vendor", "settings.json");
  mkdirSync(join(repo, "vendor"));
  writeFileSync(join(repo, "vendor/README"), "third-party code\n");
  symlinkSync("vendor/README", join(repo, "NOTICE"));
  symlinkSync("build/out.js", join(repo, "latest.js"));
  symlinkSync("..", join(repo, "vendor/top"));
  writeFileSync(join(repo, ".gitignore"), "vendor/deps\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "--message", "vendor as a directory");
  mkdirSync(join(repo, "vendor/deps"));
  await createWorktree(codebase, dir);
  assert.equal(realpathSync(join(dir, "vendor/deps")), realpathSync(join(repo, "vendor/deps")));

  // A session puts a link in the place of the directory. The cleanup removes no link behind it.
  rmSync(join(dir, "vendor"), { recursive: true });
  symlinkSync(elsewhere, join(dir, "vendor"));
  await removeWorktree(codebase, dir);
  assert.equal(readlinkSync(join(elsewhere, "deps")), "real-deps");
  assert.equal(existsSync(dir), false);

  // A linked path that the commit holds itself is in the way of its link
  await assert.rejects(createWorktree({ ...codebase, link: ["vendor/README"] }, dir), /Linked: the link "vendor\/README" names a path that the commit holds\. A linked path is one that git does not track\./);
  assert.equal(existsSync(dir), false);
  // A linked path whose directory the commit does not have has no place in a checkout
  await assert.rejects(createWorktree({ ...codebase, link: ["cache/deps"] }, dir), /Linked: the link "cache\/deps" has no place in the checkout\. The directory above it is missing there\./);
  assert.equal(worktreesOf(repo), 1);

  // A link is followed as the system follows it. "vendor/top/.." is the directory above the checkout,
  // where a reading of the words alone finds "vendor". Each of these leads out through that link.
  const outside = join(dirname(dir), "outside.txt");
  writeFileSync(outside, "the operator's\n");
  const refusedFor = async (name, target) => {
    symlinkSync(target, join(repo, name));
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "--message", name);
    await assert.rejects(
      createWorktree({ ...codebase, link: [] }, dir),
      new RegExp(`Linked: in HEAD, "${name}" is a link that leads out of the checkout, or to no place that can be made out\\. `)
    );
    assert.equal(existsSync(dir), false);
    git(repo, "rm", "--quiet", name);
    git(repo, "commit", "--quiet", "--message", `without ${name}`);
  };
  // To a file that is there, and to one that a write would put there
  await refusedFor("there", "vendor/top/../outside.txt");
  await refusedFor("later", "vendor/top/../later.txt");
  // Through the link a second time
  await refusedFor("twice", "vendor/top/vendor/top/../outside.txt");
  // Up from a directory that is not there. Whatever is put there later decides where that leads.
  await refusedFor("unknown", "missing/../elm.json");
  // In a circle, and through a file, where the system goes no further and the words alone would lead back in
  await refusedFor("circle", "circle");
  await refusedFor("through", "elm.json/../src");
  assert.equal(readFileSync(outside, "utf-8"), "the operator's\n");
  assert.equal(worktreesOf(repo), 1);
});

test("a configured link cannot take a committed link into the operator's checkout", async (t) => {
  for (const [alias, target] of [["elm-stuff", "cache"], ["sources", "cache/src"]]) {
    const repo = copyFixture(t);
    writeFileSync(join(repo, ".gitignore"), "cache/\n");
    symlinkSync(target, join(repo, alias));
    gitRepository(repo);
    mkdirSync(join(repo, "cache/src"), { recursive: true });
    writeFileSync(join(repo, "cache/src/Own.elm"), "the operator's source\n");
    const dir = join(tempDir(t), "worktree");
    await assert.rejects(
      createWorktree({ label: "Linked", repo, ref: "HEAD", elmRoot: ".", link: ["cache"] }, dir),
      new RegExp(`"${alias}" is a link that leads out of the checkout through a path that the config links into it, or to no place that can be made out\\.`)
    );
    assert.equal(existsSync(dir), false);
    assert.equal(worktreesOf(repo), 1);
    assert.deepEqual(readdirSync(join(repo, "cache")), ["src"]);
    assert.equal(readFileSync(join(repo, "cache/src/Own.elm"), "utf-8"), "the operator's source\n");
  }
});

test("an Elm root that a link takes out of the checkout stops the checkout", async (t) => {
  // The commit has "client" as a link to the project where it lies in the operator's checkout
  const repo = tempDir(t);
  cpSync(join(REPO, "tests/fixture"), join(repo, "realclient"), { recursive: true, filter: (source) => !source.endsWith("elm-stuff") });
  symlinkSync(join(repo, "realclient"), join(repo, "client"));
  gitRepository(repo);
  const codebase = { label: "Linked", repo, ref: "HEAD", elmRoot: "client", link: [] };
  const dir = join(tempDir(t), "worktree");

  // A build or a session there would work on the operator's own files
  await assert.rejects(createWorktree(codebase, dir), /Linked: in HEAD, the Elm root "client" is missing or is reached through a link that leads out of the checkout\./);
  assert.equal(existsSync(dir), false);
  assert.equal(worktreesOf(repo), 1);

  // A link that stays in the checkout is a spelling of a directory in it
  rmSync(join(repo, "client"));
  symlinkSync("realclient", join(repo, "client"));
  git(repo, "commit", "--quiet", "--all", "--message", "relative");
  const worktree = await createWorktree(codebase, dir);
  assert.ok(existsSync(join(worktree.elmRoot, "elm.json")));
  // The files of the commit are named from the Elm root, as the changes of a session are
  assert.ok((await committedFiles(worktree)).has("src/Main.elm"));
  writeFileSync(join(worktree.elmRoot, "src/Main.elm"), "module Main exposing (main)\n");
  assert.deepEqual(await changedFiles(worktree, codebase), ["src/Main.elm"]);
  await removeWorktree(codebase, dir);

  // elm.json as a link, here to a file in the checkout: what a session did to it would not show
  renameSync(join(repo, "realclient/elm.json"), join(repo, "shared-elm.json"));
  symlinkSync("../shared-elm.json", join(repo, "realclient/elm.json"));
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "--message", "shared elm.json");
  await assert.rejects(createWorktree(codebase, dir), /Linked: in HEAD, the Elm root "client" has no elm\.json of its own\. It is missing there, or it is a link\./);
  assert.equal(existsSync(dir), false);
  assert.equal(worktreesOf(repo), 1);
});

test("only a worktree of the codebase is ever replaced or removed", async (t) => {
  const repo = gitRepository(copyFixture(t));
  const codebase = { repo, ref: "HEAD", elmRoot: ".", link: [] };
  const dir = join(tempDir(t), "work", "plan");

  // Somebody's directory that happens to sit where a worktree would go
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.txt"), "keep me");
  await assert.rejects(createWorktree(codebase, dir), /work\/plan exists and is not a worktree of .*\. Remove it yourself, or use another --out\./);
  assert.equal(readFileSync(join(dir, "notes.txt"), "utf-8"), "keep me");
  await assert.rejects(removeWorktree(codebase, dir), /git worktree remove failed for .*work\/plan/);
  assert.equal(readFileSync(join(dir, "notes.txt"), "utf-8"), "keep me");

  // A worktree whose directory was deleted by hand is still on git's list, and is made anew
  const lost = join(tempDir(t), "work", "lost");
  await createWorktree(codebase, lost);
  rmSync(lost, { recursive: true });
  await createWorktree(codebase, lost);
  assert.ok(existsSync(join(lost, "elm.json")));
  await removeWorktree(codebase, lost);
  assert.equal(worktreesOf(repo), 1);

  // The repository's own checkout is on git's list too, and is no worktree of the benchmark's
  await assert.rejects(removeWorktree(codebase, repo), /git worktree remove failed for /);
  assert.ok(existsSync(join(repo, "elm.json")));

  // One that lost its tie to the repository, which a session can cut, is removed as well, and so is its record
  await createWorktree(codebase, lost);
  rmSync(join(lost, ".git"));
  await removeWorktree(codebase, lost);
  assert.equal(existsSync(lost), false);
  assert.equal(worktreesOf(repo), 1);
  assert.equal(git(repo, "worktree", "list", "--porcelain").includes("prunable"), false);
});

test("a leftover checkout of a codebase that the config no longer names, or names in another repository, stays, and stderr says how to remove it", async (t) => {
  const repo = gitRepository(copyFixture(t));
  const codebase = { label: "Fixture", repo, ref: "HEAD", elmRoot: ".", link: [] };
  const dir = join(tempDir(t), "checkout-left", "fixture");
  await createWorktree(codebase, dir);
  writeFileSync(join(dir, "src/Main.elm"), "edited by a session");
  // Two slots of codebases that the config no longer has. The checkout of one of them was deleted since.
  // A third slot cannot be read, and names neither a codebase nor a checkout.
  const workDir = join(tempDir(t), "work");
  mkdirSync(workDir);
  writeFileSync(join(workDir, "Earlier--rename-function--baseline--1"), JSON.stringify({ dir, label: "Earlier" }));
  writeFileSync(join(workDir, "Gone--rename-function--baseline--1"), JSON.stringify({ dir: join(tempDir(t), "gone"), label: "Gone" }));
  writeFileSync(join(workDir, "Unread--rename-function--baseline--1"), "{");
  // A slot whose label the config now gives to another repository, while the checkout it remembers is still there
  const moved = join(tempDir(t), "checkout-moved", "fixture");
  await createWorktree(codebase, moved);
  writeFileSync(join(workDir, "Moved--rename-function--baseline--1"), JSON.stringify({ dir: moved, label: "Moved" }));
  const other = { label: "Moved", repo: gitRepository(copyFixture(t)), ref: "HEAD", elmRoot: ".", link: [] };
  // And two slots of codebases that the config still has: a checkout of its repository, and one that is gone
  const own = join(tempDir(t), "checkout-own", "fixture");
  await createWorktree(codebase, own);
  writeFileSync(join(workDir, "Fixture--rename-function--baseline--1"), JSON.stringify({ dir: own, label: "Fixture" }));
  writeFileSync(join(workDir, "Moved--rename-function--lsp--1"), JSON.stringify({ dir: join(tempDir(t), "checkout-gone", "fixture"), label: "Moved" }));

  const printed = t.mock.method(console, "error", () => {});
  await closeLeftovers(workDir, [codebase, other]);
  const note = (left, label, why) =>
    `Left ${left} where it is. It is a checkout of the codebase "${label}", ${why}, ` +
    `and the benchmark removes a directory only where git lists it as a worktree of a codebase of the config. ` +
    `"git worktree remove --force ${left}" in the repository of that codebase removes it.`;
  assert.deepEqual(
    printed.mock.calls.map((call) => call.arguments.join(" ")).sort(),
    [note(dir, "Earlier", "which the config no longer names"), note(moved, "Moved", "whose label the config now gives to another repository")].sort()
  );
  assert.deepEqual(readdirSync(workDir).sort(), [
    "Earlier--rename-function--baseline--1",
    "Gone--rename-function--baseline--1",
    "Moved--rename-function--baseline--1.aside",
    "Unread--rename-function--baseline--1",
  ]);
  assert.equal(readFileSync(join(dir, "src/Main.elm"), "utf-8"), "edited by a session");
  assert.deepEqual([existsSync(join(moved, "elm.json")), existsSync(own)], [true, false]);
  git(repo, "worktree", "remove", "--force", dir);
  git(repo, "worktree", "remove", "--force", moved);
  assert.equal(existsSync(dir), false);
  assert.equal(worktreesOf(repo), 1);
  assert.equal(worktreesOf(other.repo), 1);
});

test("a slot that is put aside keeps its checkout in mind after a session of the same name, and goes once the checkout is gone", async (t) => {
  // A killed benchmark left a checkout of the first repository. The config now gives its label to the second.
  const first = { label: "Moved", repo: gitRepository(copyFixture(t)), ref: "HEAD", elmRoot: ".", link: [] };
  const second = { ...first, repo: gitRepository(copyFixture(t)) };
  const left = join(tempDir(t), "checkout-left", "fixture");
  await createWorktree(first, left);
  const workDir = join(tempDir(t), "work");
  const slot = join(workDir, "Moved--rename-function--baseline--1");
  mkdirSync(workDir);
  writeFileSync(slot, JSON.stringify({ dir: left, label: "Moved" }));
  const printed = t.mock.method(console, "error", () => {});
  const notes = () => printed.mock.calls.filter((call) => call.arguments.join(" ").startsWith(`Left ${left} where it is.`)).length;

  await closeLeftovers(workDir, [second]);
  assert.equal(notes(), 1);
  // The session of the same name in the second repository, which a killed benchmark leaves behind as well
  const opened = await openCheckout(second, slot);
  assert.deepEqual(readdirSync(workDir).sort(), ["Moved--rename-function--baseline--1", "Moved--rename-function--baseline--1.aside"]);

  await closeLeftovers(workDir, [second]);
  assert.equal(notes(), 2, "the checkout of the first repository is still remembered");
  assert.equal(existsSync(opened.dir), false);
  assert.deepEqual(readdirSync(workDir), ["Moved--rename-function--baseline--1.aside"]);
  assert.ok(existsSync(join(left, "elm.json")));

  // Another slot of that name is put aside beside the first
  const later = join(tempDir(t), "checkout-later", "fixture");
  await createWorktree(first, later);
  writeFileSync(slot, JSON.stringify({ dir: later, label: "Moved" }));
  await closeLeftovers(workDir, [second]);
  assert.deepEqual(readdirSync(workDir).sort(), ["Moved--rename-function--baseline--1.aside", "Moved--rename-function--baseline--1.aside-2"]);

  // Removed as the note says, the checkouts take their slots along at the next run
  git(first.repo, "worktree", "remove", "--force", left);
  git(first.repo, "worktree", "remove", "--force", later);
  await closeLeftovers(workDir, [second]);
  assert.deepEqual(readdirSync(workDir), []);
  assert.equal(notes(), 3);
  assert.deepEqual([worktreesOf(first.repo), worktreesOf(second.repo)], [1, 1]);
});

test("a check command that runs out of time is ended with everything it started", async (t) => {
  const elmRoot = tempDir(t);
  // A build script that starts a compiler and waits for it. The compiler would write a file a second later.
  const later = `setTimeout(() => require("fs").writeFileSync("built", ""), 1000)`;
  const script = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(later)}], { stdio: "inherit" }); setInterval(() => {}, 1000);`;
  const codebase = { check: [process.execPath, "-e", script], checkTimeoutMs: 300 };

  const started = Date.now();
  assert.deepEqual(await runCheck({ elmRoot }, codebase), { ok: false, timedOut: true, problem: "the check command ran out of time" });
  assert.ok(Date.now() - started < 5000);
  await sleep(1500);
  assert.equal(existsSync(join(elmRoot, "built")), false, "a process of the check command outlived it");

  // A build script that cleans up when it is told to end, and exits as one that succeeded
  const polite = `process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);`;
  assert.deepEqual(await runCheck({ elmRoot }, { check: [process.execPath, "-e", polite], checkTimeoutMs: 300 }), { ok: false, timedOut: true, problem: "the check command ran out of time" });
  // And one that is done in time
  assert.deepEqual(await runCheck({ elmRoot }, { check: [process.execPath, "-e", ""], checkTimeoutMs: 30000 }), { ok: true, timedOut: false, problem: "" });
});

// Run the stand-in agent directly, in the given mode, with a time limit and the time it has to end when that is up.
async function standInSession(t, mode, timeoutMs, graceMs, stopIf) {
  const cwd = tempDir(t);
  process.env.FAKE_AGENT = mode;
  t.after(() => delete process.env.FAKE_AGENT);
  const started = Date.now();
  const session = await runAgent({
    command: [process.execPath, FAKE_AGENT],
    cwd,
    prompt: "Do nothing.",
    model: "none",
    arm: "baseline",
    maxBudgetUsd: 1,
    timeoutMs,
    graceMs,
    stopIf,
    transcriptPath: join(cwd, "transcript.jsonl"),
  });
  return { session, cwd, took: Date.now() - started };
}

// The stand-in's command is a process group of its own, as Claude Code's shell commands are, and
// would write a file three seconds after it started. Wait that long and look for the file.
async function assertNothingOutlived(cwd, sinceStart) {
  await sleep(Math.max(0, 3500 - sinceStart));
  assert.equal(existsSync(join(cwd, "lingered")), false, "a process of the session outlived it");
}

test("a command that a session leaves running ends with the session", async (t) => {
  const { session, cwd, took } = await standInSession(t, "linger", 30000);
  assert.equal(session.finished, true);
  await assertNothingOutlived(cwd, took);
});

test("a session is started with auto memory and the updates of Claude Code turned off", async (t) => {
  // Whatever the shell that starts the benchmark has set
  for (const name of ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "DISABLE_AUTOUPDATER"]) {
    const was = process.env[name];
    delete process.env[name];
    t.after(() => was !== undefined && (process.env[name] = was));
  }
  const cwd = tempDir(t);
  const note = `require("fs").writeFileSync("environment.json", JSON.stringify(process.env))`;
  await runAgent({
    // The options of a session come after "--", where Node.js takes no more options of its own
    command: [process.execPath, "-e", note, "--"],
    cwd,
    prompt: "Do nothing.",
    model: "none",
    arm: "baseline",
    maxBudgetUsd: 1,
    timeoutMs: 30000,
    transcriptPath: join(cwd, "transcript.jsonl"),
  });
  const { CLAUDE_CODE_DISABLE_AUTO_MEMORY, DISABLE_AUTOUPDATER } = JSON.parse(readFileSync(join(cwd, "environment.json"), "utf-8"));
  assert.deepEqual([CLAUDE_CODE_DISABLE_AUTO_MEMORY, DISABLE_AUTOUPDATER], ["1", "1"]);
});

// Sets each variable for the rest of the test, or unsets it where the value is undefined, whatever the shell had
function setForTest(t, variables) {
  for (const [name, value] of Object.entries(variables)) {
    const was = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => (was === undefined ? delete process.env[name] : (process.env[name] = was)));
  }
}

// What the stand-in noted of each session it started as: its arguments, the names of its variables and its effort level
async function notedSessions(t, run) {
  const notes = join(tempDir(t), "started.jsonl");
  process.env.FAKE_AGENT_STARTED = notes;
  try {
    await run();
  } finally {
    delete process.env.FAKE_AGENT_STARTED;
  }
  return readFileSync(notes, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
}

test("a session runs at the effort it is given, and at Claude Code's default where it is given none", async (t) => {
  // Whatever the shell that starts the benchmark has set for how the model thinks and how long it answers
  const shell = {
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
    CLAUDE_CODE_MAX_EFFORT_REMINDER: "1",
    MAX_THINKING_TOKENS: "32000",
    CLAUDE_CODE_DISABLE_THINKING: "1",
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
    DISABLE_INTERLEAVED_THINKING: "1",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4000",
  };
  setForTest(t, { FAKE_AGENT: "idle", CLAUDE_CODE_EFFORT_LEVEL: "max", ...shell });
  const cwd = tempDir(t);
  const session = (effort) =>
    runAgent({
      command: [process.execPath, FAKE_AGENT],
      cwd,
      prompt: "Do nothing.",
      model: "none",
      effort,
      arm: "baseline",
      maxBudgetUsd: 1,
      timeoutMs: 30000,
      transcriptPath: join(cwd, "transcript.jsonl"),
    });
  const [high, unset] = await notedSessions(t, async () => {
    await session("high");
    await session(undefined);
  });
  const effortOf = ({ args, variables, effortLevel }) => ({
    flag: args.includes("--effort") ? args[args.indexOf("--effort") + 1] : null,
    effortLevel,
    shell: Object.keys(shell).filter((name) => variables.includes(name)),
  });
  assert.deepEqual(effortOf(high), { flag: "high", effortLevel: "high", shell: [] });
  assert.deepEqual(effortOf(unset), { flag: null, effortLevel: null, shell: [] });
  assert.equal(unset.variables.includes("CLAUDE_CODE_EFFORT_LEVEL"), false);

  // The isolation check's session is started the same way
  const [isolation] = await notedSessions(t, () =>
    assertIsolated({ agentCommand: [process.execPath, FAKE_AGENT], model: "none", effort: "low", maxBudgetUsd: 1, timeoutMs: 30000 })
  );
  assert.deepEqual(effortOf(isolation), { flag: "low", effortLevel: "low", shell: [] });
});

test("a session and the lsp pre-flight get none of the variables of a session that started the benchmark", async (t) => {
  const parent = [
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
  // How Claude Code signs in and which provider it uses
  const signIn = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_OAUTH_TOKEN"];
  setForTest(t, { FAKE_AGENT: "idle", ...Object.fromEntries([...parent, ...signIn].map((name) => [name, "from the test"])) });
  const cwd = tempDir(t);
  const [session] = await notedSessions(t, () =>
    runAgent({
      command: [process.execPath, FAKE_AGENT],
      cwd,
      prompt: "Do nothing.",
      model: "none",
      arm: "baseline",
      maxBudgetUsd: 1,
      timeoutMs: 30000,
      transcriptPath: join(cwd, "transcript.jsonl"),
    })
  );
  assert.deepEqual(parent.filter((name) => session.variables.includes(name)), []);
  assert.deepEqual(signIn.filter((name) => session.variables.includes(name)), signIn);

  const noted = join(cwd, "server.json");
  const server = join(cwd, "server.cjs");
  writeFileSync(server, `require("fs").writeFileSync(${JSON.stringify(noted)}, JSON.stringify(Object.keys(process.env)));
require("readline").createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id) console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.id === 1 ? {} : { tools: [{ name: "any_tool" }] } }));
});`);
  await assertMcpServer({ mcpServers: { "elm-lsp": { command: process.execPath, args: [server] } } });
  const variables = JSON.parse(readFileSync(noted, "utf-8"));
  assert.deepEqual(parent.filter((name) => variables.includes(name)), []);
  assert.deepEqual(signIn.filter((name) => variables.includes(name)), signIn);
});

test("a session over its time limit is asked to end, and says what it spent", async (t) => {
  // The stand-in works until it gets the signal Ctrl-C sends. Then it ends its command and reports, as Claude Code does.
  const { session, cwd, took } = await standInSession(t, "busy", 1000);
  assert.deepEqual(
    { timedOut: session.timedOut, finished: session.finished, costUsd: session.costUsd, waitingForApi: session.waitingForApi },
    { timedOut: true, finished: false, costUsd: 0.25, waitingForApi: false }
  );
  assert.ok(took < 3000, `the session ended ${took} ms after it started, long after its limit`);
  await assertNothingOutlived(cwd, took);
});

test("a session that was asking the API again when its time ran out says so", async (t) => {
  // The stand-in works one turn, gets no answer to its next request and asks again until it is told to stop
  const { session } = await standInSession(t, "stalled-later", 1000);
  assert.deepEqual(
    { timedOut: session.timedOut, replies: session.replies, apiRetries: session.apiRetries, waitingForApi: session.waitingForApi },
    { timedOut: true, replies: 1, apiRetries: 2, waitingForApi: true }
  );
});

test("a session can be ended at its first event, long before its time is up", async (t) => {
  // The stand-in would work until its half minute is over. What its first event says of its setup is enough to end it.
  const seen = [];
  const stopIf = (session) => seen.push(session.strayTools) > 0;
  const { session, cwd, took } = await standInSession(t, "busy", 30000, undefined, stopIf);
  assert.deepEqual(seen, [[]]);
  assert.deepEqual({ timedOut: session.timedOut, finished: session.finished }, { timedOut: false, finished: false });
  assert.ok(took < 5000, `the session ended ${took} ms after it started`);
  await assertNothingOutlived(cwd, took);
});

test("a line of a session's output that is JSON and no object is no event", async (t) => {
  const cwd = tempDir(t);
  const events = [
    { type: "system", subtype: "init", tools: BUILT_IN_TOOLS, mcp_servers: [], plugins: [] },
    { type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0.25, num_turns: 1 },
  ];
  // Each of the first four lines parses, and none of them is an event
  const lines = ["null", "5", '"text"', "true", ...events.map((event) => JSON.stringify(event))];
  const session = await runAgent({
    // The arguments of the session go to the script and not to node
    command: [process.execPath, "-e", `for (const line of ${JSON.stringify(lines)}) console.log(line)`, "--"],
    cwd,
    prompt: "Do nothing.",
    model: "none",
    arm: "baseline",
    maxBudgetUsd: 1,
    timeoutMs: 30000,
    transcriptPath: join(cwd, "transcript.jsonl"),
  });
  assert.deepEqual({ finished: session.finished, costUsd: session.costUsd, strayTools: session.strayTools }, { finished: true, costUsd: 0.25, strayTools: [] });
  // The transcript still holds every line
  assert.deepEqual(readFileSync(join(cwd, "transcript.jsonl"), "utf-8").split("\n").slice(0, 4), lines.slice(0, 4));
});

test("a command whose reader of lines throws is ended, and fails with that error once it has ended", async (t) => {
  const cwd = tempDir(t);
  // The command prints a line. Asked to end, it prints one more and notes that it ended. Not asked, it would write
  // the file "lingered" three seconds from its start.
  const script = `const fs = require("fs");
    console.log("first");
    process.on("SIGTERM", () => setTimeout(() => { console.log("asked"); fs.writeFileSync("ended", ""); process.exit(0); }, 300));
    setTimeout(() => fs.writeFileSync("lingered", ""), 3000);
    setInterval(() => {}, 1000);`;
  const read = [];
  const started = Date.now();
  await assert.rejects(
    runGroup([process.execPath, "-e", script], {
      cwd,
      timeoutMs: 30000,
      onLine(line) {
        read.push(line);
        throw new Error(`cannot read ${line}`);
      },
    }),
    /^Error: cannot read first$/
  );
  assert.equal(existsSync(join(cwd, "ended")), true, "the command was not asked to end, or not waited for");
  assert.deepEqual(read, ["first"]);
  await assertNothingOutlived(cwd, Date.now() - started);
});

test("a session that does not end when asked is killed with everything it started", async (t) => {
  // The stand-in takes no telling, and its command holds the output pipe open as well
  const { session, cwd, took } = await standInSession(t, "hang", 1000, 400);
  assert.deepEqual(
    { timedOut: session.timedOut, finished: session.finished, costUsd: session.costUsd },
    { timedOut: true, finished: false, costUsd: null }
  );
  assert.ok(took < 3000, `the session ended ${took} ms after it started, long after its limit`);
  await assertNothingOutlived(cwd, took);
});

test("the isolation check tells a session that saw the operator's setup from one that did not", async (t) => {
  t.after(() => delete process.env.FAKE_AGENT);
  const check = (mode) => {
    process.env.FAKE_AGENT = mode;
    return assertIsolated({ agentCommand: [process.execPath, FAKE_AGENT], model: "none", maxBudgetUsd: 1, timeoutMs: 30000 });
  };

  // The check hands back the version of Claude Code that its session reported, and a stand-in reports none
  assert.equal(await check("solve"), null);
  process.env.FAKE_AGENT_VERSION = "2.1.311";
  t.after(() => delete process.env.FAKE_AGENT_VERSION);
  assert.equal(await check("solve"), "2.1.311");
  delete process.env.FAKE_AGENT_VERSION;
  await assert.rejects(check("leaky"), /A test session loaded: CLAUDE\.md in the project\. Its flags may not suit this version of Claude Code \(unknown\)\./);
  await assert.rejects(check("remembering"), /A test session loaded: Claude Code's auto memory\./);
  // Every place in the project that Claude Code reads instructions from has a file of its own
  await assert.rejects(
    check("nosy"),
    /A test session loaded: CLAUDE\.md in the project, CLAUDE\.local\.md in the project, \.claude\/CLAUDE\.md in the project, a rule in \.claude\/rules of the project, a SessionStart hook in \.claude\/settings\.json of the project, a SessionStart hook in \.claude\/settings\.local\.json of the project, AGENTS\.md in the project\. Its flags/
  );
  // The language server of the machine's own setup is no part of a session that was given no tool
  await assert.rejects(
    check("served"),
    /A test session loaded: tools, though it was given none \(mcp__elm-lsp__elm_symbols\), MCP servers, though it was given none \(elm-lsp\)\./
  );
  // Nor is a server that is still starting, though it has handed over no tool yet
  await assert.rejects(check("foreign"), /A test session loaded: MCP servers, though it was given none \(someones-server\)\./);
  // An agent that gives no answer proves nothing either way
  await assert.rejects(
    assertIsolated({ agentCommand: [process.execPath, "-e", ""], model: "none", maxBudgetUsd: 1, timeoutMs: 30000 }),
    /^Error: The isolation check did not get an answer \(no result\)\.$/
  );
});

test("the isolation check asks for the paths of instruction files, and stops at one of the user's settings", async (t) => {
  const settings = tempDir(t);
  const config = join(settings, "config");
  mkdirSync(config);
  setForTest(t, { CLAUDE_CONFIG_DIR: config });
  const check = (mode, named = "") =>
    notedSessions(t, () => {
      Object.assign(process.env, { FAKE_AGENT: mode, FAKE_AGENT_NAMED: named });
      return assertIsolated({ agentCommand: [process.execPath, FAKE_AGENT], model: "none", maxBudgetUsd: 1, timeoutMs: 30000 }).finally(() => {
        delete process.env.FAKE_AGENT;
        delete process.env.FAKE_AGENT_NAMED;
      });
    });
  const promptOf = ([{ args }]) => args[args.indexOf("--print") + 1];
  const refused = /A test session loaded: an instruction file of your user settings\. Its flags/;

  // The question asks for the paths whether the user has a CLAUDE.md or not
  assert.equal(
    promptOf(await check("solve")),
    "List every word ending in SENTINEL that appears anywhere in your instructions or your context. Then name the whole path of every file whose contents you were given as instructions. Reply with those words and paths only, or with NONE if there are none."
  );
  // A rule of the user's own with no CLAUDE.md beside it, named as the directory is configured
  await assert.rejects(check("named", join(config, "rules", "mine.md")), refused);
  await assert.rejects(check("personal"), refused);
  // And as the system resolves a directory that is configured through a link
  const linkedConfig = join(settings, "linked");
  symlinkSync(config, linkedConfig);
  setForTest(t, { CLAUDE_CONFIG_DIR: linkedConfig });
  await assert.rejects(check("named", join(realpathSync(config), "rules", "mine.md")), refused);
  await assert.rejects(check("named", join(linkedConfig, "rules", "mine.md")), refused);
  // A directory whose name only begins like it is another one
  await check("named", `${linkedConfig}-other/CLAUDE.md`);

  // A CLAUDE.md that is a link can be named by the file it leads to, and that file alone
  const dotfiles = join(settings, "dotfiles");
  mkdirSync(dotfiles);
  writeFileSync(join(dotfiles, "instructions.md"), "The operator's own instructions, which the check never reads\n");
  writeFileSync(join(dotfiles, "other.md"), "A file that is no instruction of the user's settings\n");
  symlinkSync(join(dotfiles, "instructions.md"), join(config, "CLAUDE.md"));
  await assert.rejects(check("named", join(realpathSync(dotfiles), "instructions.md")), refused);
  await check("named", join(realpathSync(dotfiles), "other.md"));
  // So can a rule of the user's that is a link, and a rules directory that is one, by a path in the directory it leads to
  mkdirSync(join(config, "rules"));
  writeFileSync(join(dotfiles, "rule.md"), "A rule of the operator's own\n");
  symlinkSync(join(dotfiles, "rule.md"), join(config, "rules", "linked.md"));
  await assert.rejects(check("named", join(realpathSync(dotfiles), "rule.md")), refused);
  const rules = join(dotfiles, "rules");
  mkdirSync(rules);
  const otherConfig = join(settings, "other-config");
  mkdirSync(otherConfig);
  symlinkSync(rules, join(otherConfig, "rules"));
  setForTest(t, { CLAUDE_CONFIG_DIR: otherConfig });
  await assert.rejects(check("named", join(realpathSync(rules), "mine.md")), refused);
  await check("named", `${realpathSync(rules)}-other/mine.md`);
  // The check wrote nothing into the user's settings
  assert.deepEqual(readdirSync(config), ["CLAUDE.md", "rules"]);
  assert.deepEqual(readdirSync(join(config, "rules")), ["linked.md"]);

  // Without the variable the settings lie in .claude of the home directory, and a session can name a file there from ~
  const home = tempDir(t);
  mkdirSync(join(home, ".claude"));
  setForTest(t, { CLAUDE_CONFIG_DIR: undefined, HOME: home });
  await assert.rejects(check("personal-home"), refused);
  await assert.rejects(check("named", "~/.claude/rules/mine.md"), refused);
  await assert.rejects(check("personal"), refused);
  await check("solve");
  // Claude Code reads a variable that is set and empty as one that is not set
  setForTest(t, { CLAUDE_CONFIG_DIR: "" });
  await assert.rejects(check("named", "~/.claude/rules/mine.md"), refused);
  await assert.rejects(check("personal"), refused);
  assert.deepEqual(readdirSync(join(home, ".claude")), []);
});

test("the lsp pre-flight tries the session's MCP command and requires at least one tool", async (t) => {
  const original = ARMS.lsp.mcpServers;
  for (const name of ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "DISABLE_AUTOUPDATER"]) {
    const was = process.env[name];
    delete process.env[name];
    t.after(() => was !== undefined && (process.env[name] = was));
  }
  const dir = tempDir(t);
  const answering = (tools) => `require("readline").createInterface({ input: process.stdin }).on("line", line => {
    const m = JSON.parse(line);
    if (m.id) console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.id === 1 ? {} : { tools: ${JSON.stringify(tools)} } }));
  });`;
  const answer = (id, result) => `console.log(JSON.stringify({ jsonrpc: "2.0", id: ${id}, result: ${JSON.stringify(result)} }))`;
  const listed = answer(2, { tools: [{ name: "any_tool" }] });
  const refusingTools = `require("readline").createInterface({ input: process.stdin }).on("line", line => {
    const { id } = JSON.parse(line);
    if (id === 1) ${answer(1, {})};
    if (id === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "broken" } }));
  });`;
  // A stand-in that has to start and answer gets a few seconds, which Node's own start can take up under load.
  // The two that are meant to run out of time get 200 ms.
  for (const [body, message, timeoutMs = 5000] of [
    ["process.exit(3)", /ended before it answered initialize and tools\/list \(exit 3\)/],
    ["setInterval(() => {}, 1000)", /did not answer initialize and tools\/list within 200 ms/, 200],
    [answering([]), /listed no tools/],
    [answering({}), /listed no tools/],
    [answering([null]), /listed no tools/],
    [answering([{ name: "" }]), /listed no tools/],
    [answering([{ name: 7 }]), /listed no tools/],
    ['console.log(JSON.stringify({ id: 1, result: {} })); setInterval(() => {}, 1000)', /sent something other than a JSON-RPC message/],
    ['console.log("not JSON"); setInterval(() => {}, 1000)', /sent something other than a JSON-RPC message/],
    ['console.log("null"); setInterval(() => {}, 1000)', /sent something other than a JSON-RPC message/],
    ['console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "broken" } })); setInterval(() => {}, 1000)', /refused initialize/],
    [refusingTools, /refused tools\/list/],
    // Also once a tool is listed
    [`${answer(1, {})}; ${listed}; console.log("not JSON")`, /sent something other than a JSON-RPC message/],
    // An answer counts only once its request was sent. This one lists tools before it is asked, and every time
    // it is asked, and never answers initialize.
    [`${listed}; require("readline").createInterface({ input: process.stdin }).on("line", line => JSON.parse(line).id === 2 && ${listed})`, /did not answer initialize and tools\/list within 200 ms/, 200],
    // The next request goes to a server that closed its input, and fails to be written
    [`require("fs").closeSync(0); ${answer(1, {})}`, /ended before it answered initialize and tools\/list \(exit 0\)/],
  ]) {
    const server = join(dir, "server.cjs");
    writeFileSync(server, body);
    const mcpServers = { "elm-lsp": { command: process.execPath, args: [server] } };
    await assert.rejects(assertMcpServer({ timeoutMs, mcpServers }), message);
  }
  const server = join(dir, "server.cjs");
  writeFileSync(server, answering([{ name: "any_tool" }]));
  await assertMcpServer({ mcpServers: { "elm-lsp": { command: process.execPath, args: [server] } } });
  // A server can send requests of its own, with ids of its own that can be those of the check's requests.
  // Once it has listed a tool, a message with the id null answers no request either.
  const pinging = `require("readline").createInterface({ input: process.stdin }).on("line", line => {
    const m = JSON.parse(line);
    if (m.method === "notifications/initialized") for (const id of [0, 1, 2]) console.log(JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }));
    if (m.id === 1) ${answer(1, {})};
    if (m.id === 2) ${listed};
  });`;
  const unanswerable = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  for (const body of [pinging, `${answer(1, {})}; ${listed}; console.log(${JSON.stringify(unanswerable)})`]) {
    writeFileSync(server, body);
    await assertMcpServer({ mcpServers: { "elm-lsp": { command: process.execPath, args: [server] } } });
  }
  await assert.rejects(assertMcpServer({ mcpServers: { "elm-lsp": { command: join(dir, "missing"), args: [] } } }), /could not start/);
  await assertMcpServer();
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; });
  const node = join(dir, "node");
  const noted = join(dir, "node.json");
  writeFileSync(node, `#!${process.execPath}
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(noted)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), memory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, updates: process.env.DISABLE_AUTOUPDATER }));
require("child_process").spawn(${JSON.stringify(process.execPath)}, process.argv.slice(2), { stdio: "inherit" }).on("exit", code => process.exit(code ?? 1));
`, { mode: 0o755 });
  process.env.PATH = `${dir}:${path}`;
  await assertMcpServer({ cwd: dir });
  assert.deepEqual(JSON.parse(readFileSync(noted, "utf-8")), {
    args: Object.values(original)[0].args, cwd: dir, memory: "1", updates: "1",
  });
});

test("the isolation check plants SessionStart hooks in both project settings files", async (t) => {
  const script = join(tempDir(t), "settings.cjs");
  writeFileSync(script, `
const fs = require("fs");
let answer = "NONE";
if (fs.existsSync(process.argv[2])) {
  const settings = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
  const hook = settings.hooks.SessionStart[0].hooks[0];
  if (hook.type === "command" && hook.command.startsWith("echo ")) answer = hook.command.slice(5);
}
console.log(JSON.stringify({ type: "result", subtype: "success", result: answer }));
`);
  for (const file of ["settings.json", "settings.local.json"]) {
    await assert.rejects(
      assertIsolated({ agentCommand: [process.execPath, script, `.claude/${file}`], model: "none", maxBudgetUsd: 1, timeoutMs: 1000 }),
      new RegExp(`A test session loaded: a SessionStart hook in \\.claude/settings\\.${file === "settings.json" ? "json" : "local\\.json"} of the project`)
    );
  }
});

test("plan, run and report work end to end on a throwaway repository", async (t) => {
  const repo = gitRepository(copyFixture(t));
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  const configWith = (check, more = {}) => writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check, ...more }] }));
  // The stand-in notes where each session found itself
  const places = join(tempDir(t), "places.jsonl");
  const bench = (args, FAKE_AGENT_MODE) =>
    runNode(BENCH, [...args, "--out", out], { env: { ...process.env, FAKE_AGENT: FAKE_AGENT_MODE, FAKE_AGENT_PLACES: places } });

  // A check command that names no module leaves open what its verdict covers
  configWith([process.execPath, FAKE_COMPILER]);
  const blind = await bench(["plan", "--config", config, "--min-files", "1"]);
  assert.equal(blind.code, 1);
  assert.match(
    blind.stderr,
    /names no module of the project as a word of its own\. Name each file it compiles as a word of the command, as in "elm make src\/Main\.elm", .*\. A file named inside a longer word, the script of "sh -c" for one, does not count\./
  );

  // The fixture has three modules that nothing imports, so the build names all three
  configWith([process.execPath, FAKE_COMPILER, "src/Main.elm", "./src/FieldRename.elm", "src/TestRemoveVariant.elm"]);
  const planned = await bench(["plan", "--config", config, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(planned.stdout, /Fixture: 4 tasks in 5 modules, of which the check command compiles 5/);
  // Nothing imports the module with the custom types, and no function name is shared by four modules
  assert.match(planned.stdout, /Fixture: no suitable target for rename-shared-function\. Nothing in the project is a candidate for it/);
  assert.match(planned.stdout, /Fixture: no suitable target for rename-variant\. No candidate involves more than 0 files, and --min-files asks for 1/);
  const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8"));
  assert.deepEqual(
    plan.tasks.map((task) => task.id),
    ["Fixture/rename-function", "Fixture/rename-field", "Fixture/rename-module", "Fixture/add-variant"]
  );
  // The limit that the config leaves out is written down as the one that held
  assert.equal(plan.codebases[0].checkTimeoutMs, 600000);
  // The codebase has as many lines as wc counts in its modules, each of which ends with a line break
  assert.equal(plan.codebases[0].lines, Number(execFileSync("sh", ["-c", "cat src/*.elm | wc -l"], { cwd: repo, encoding: "utf-8" })));
  assert.match(plan.tasks[0].prompt, /^Rename the function `defaultUser` of the module `Types` \(`src\/Types\.elm`\) to `defaultUserRenamed`/);

  // The same commit always yields the same plan, so two runs are comparable
  const again = join(tempDir(t), "out");
  await runNode(BENCH, ["plan", "--config", config, "--min-files", "1", "--out", again]);
  assert.equal(readFileSync(join(again, "plan.json"), "utf-8"), readFileSync(join(out, "plan.json"), "utf-8"));

  // The repository moves on after the plan was made. The sessions still start from the planned commit.
  writeFileSync(join(repo, "src/Later.elm"), "module Later exposing (later)\n\n\nlater : Int\nlater =\n    1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "--message", "later");

  // One invocation per way a session can end
  const runArguments = (only, ...more) => ["run", "--config", config, "--only", only, "--agent", FAKE_AGENT, "--timeout-min", "1", ...more];
  const run = (only, mode, ...more) => bench(runArguments(only, ...more), mode);
  const solved = await run("rename-function", "solve");
  assert.equal(solved.code, 0, solved.stderr);
  assert.match(solved.stdout, /2 sessions to run with claude-opus-5-5\nEach is stopped once it has spent \$5, which makes about \$10 if every one gets that far\./);
  assert.match(solved.stdout, /Fixture\/rename-function  baseline  #1  passed  \d+s  \$0\.25/);
  assert.match(solved.stdout, /Fixture\/rename-function  lsp  #1  passed/);

  // Claude Code tells the model where it works. Neither arm can read from that which one it is, and
  // the plan and the other arm's patch are nowhere near: each checkout is alone in a directory of its own.
  const found = readFileSync(places, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(found.length, 2);
  for (const { cwd, beside } of found) {
    assert.equal(basename(cwd), basename(repo));
    assert.deepEqual(beside, [basename(repo)]);
    // Only what the benchmark chose counts: the path of the temporary directory is the machine's
    const chosen = relative(realpathSync(tmpdir()), cwd);
    assert.match(chosen, /^checkout-\w+\/[^/]+$/);
    assert.ok(!/baseline|lsp|rename|Fixture/.test(chosen.replace(basename(repo), "")), chosen);
    assert.equal(existsSync(dirname(cwd)), false, "the checkout is gone when its session is judged");
  }
  assert.match((await run("rename-module", "idle")).stdout, /Fixture\/rename-module  lsp  #1  wrong-result/);
  assert.match((await run("add-variant", "break")).stdout, /Fixture\/add-variant  baseline  #1  does-not-compile/);
  assert.match((await run("rename-field", "crash")).stdout, /Fixture\/rename-field  lsp  #1  agent-failed/);

  const records = Object.fromEntries(
    readdirSync(join(out, "runs"))
      .filter((file) => file.endsWith(".json"))
      .map((file) => [file.replace(".json", ""), JSON.parse(readFileSync(join(out, "runs", file), "utf-8"))])
  );
  assert.equal(Object.keys(records).length, 8);
  const lspRename = records["Fixture--rename-function--lsp--1"];
  assert.deepEqual(
    { outcome: lspRename.outcome, problems: lspRename.problems, changedFiles: lspRename.changedFiles, lspCalls: lspRename.lspCalls, costUsd: lspRename.costUsd },
    { outcome: "passed", problems: [], changedFiles: 2, lspCalls: 1, costUsd: 0.25 }
  );
  assert.equal(records["Fixture--rename-function--baseline--1"].lspCalls, 0);
  assert.equal(lspRename.commit, plan.codebases[0].commit);
  assert.notEqual(lspRename.commit, git(repo, "rev-parse", "HEAD").trim());
  assert.deepEqual(records["Fixture--rename-module--baseline--1"].problems, [
    "src/Types.elm still exists",
    "src/TypesRenamed.elm does not declare the module TypesRenamed",
    "Types is still imported by src/Main.elm, src/Utils.elm",
  ]);
  assert.match(records["Fixture--add-variant--lsp--1"].problems[0], /^the check command fails: SYNTAX PROBLEM/);
  assert.ok(existsSync(join(out, "runs", "Fixture--rename-function--lsp--1.jsonl")), "the transcript is kept");
  // Both arms were started with the same built-in tools, and one of them with the language server's besides
  const toolsOf = (arm) => JSON.parse(readFileSync(join(out, "runs", `Fixture--rename-function--${arm}--1.jsonl`), "utf-8").split("\n")[0]).tools;
  assert.deepEqual(toolsOf("baseline"), ["Bash", "Read", "Edit", "Write", "Grep", "Glob"]);
  // The README names them as what the sessions are started with. Claude Code leaves Grep and Glob out of a session that names no tools.
  const readme = readFileSync(join(REPO, "benchmarks/README.md"), "utf-8");
  const named = /started with six of Claude Code's tools named, the ones it reads, searches and edits files with: ([^.]+)\./.exec(readme)?.[1];
  assert.deepEqual(named?.split(/, | and /), toolsOf("baseline"));
  assert.deepEqual(toolsOf("lsp"), [...toolsOf("baseline"), "mcp__elm-lsp__elm_symbols"]);
  assert.match(
    readFileSync(join(out, "runs", "Fixture--rename-function--lsp--1.patch"), "utf-8"),
    /^\+defaultUserRenamed : User$/m,
    "the agent's changes are kept as a patch"
  );

  // A new plan would give the records other targets under the same names
  const replanned = await bench(["plan", "--config", config, "--min-files", "1"]);
  assert.equal(replanned.code, 1);
  assert.match(replanned.stderr, /runs holds the records of an earlier plan\. Use another --out, or delete that directory\./);

  // The original checkout was never touched, and no worktree is left behind
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(worktreesOf(repo), 1);

  // Finished sessions are not run again
  assert.match((await run("rename-function", "crash")).stdout, /0 sessions to run/);

  // A second round runs only what is new, and the other arm goes first in it
  const second = await run("rename-function", "solve", "--repeat", "2");
  assert.match(second.stdout, /2 sessions to run/);
  assert.match(solved.stdout, /lsp  #1  passed[^]*baseline  #1  passed/);
  assert.match(second.stdout, /baseline  #2  passed[^]*lsp  #2  passed/);

  // The plan was made for one check command, which its prompts name
  configWith([process.execPath, FAKE_COMPILER, "src/Main.elm"]);
  const otherCheck = await run("rename-function", "solve", "--repeat", "3");
  assert.equal(otherCheck.code, 1);
  assert.match(otherCheck.stderr, /^The config's "check" for Fixture is not the one the plan was made with\. Plan again, in another --out\./);
  // And for one time limit of that command: a build that one limit fails can pass under another
  const build = [process.execPath, FAKE_COMPILER, "src/Main.elm", "./src/FieldRename.elm", "src/TestRemoveVariant.elm"];
  configWith(build, { checkTimeoutMs: 5000 });
  const otherLimit = await run("rename-function", "solve", "--repeat", "3");
  assert.equal(otherLimit.code, 1);
  assert.match(otherLimit.stderr, /^The config's "checkTimeoutMs" for Fixture is not the one the plan was made with\. Plan again, in another --out\./);
  assert.doesNotMatch(otherLimit.stdout, /to run/, "no session was started");
  configWith(build);
  // An arm that is named twice runs once
  assert.match((await run("rename-function", "solve", "--arms", "lsp,lsp")).stdout, /0 sessions to run/);

  // Sessions under another model or limit would sit in the same rounds as the ones on record
  const otherModel = await run("rename-function", "solve", "--repeat", "3", "--model", "claude-haiku-5-5");
  assert.equal(otherModel.code, 1);
  assert.match(
    otherModel.stderr,
    /runs holds records of sessions that ran differently: --model was claude-opus-5-5 and is now claude-haiku-5-5\. Run as before, or use another --out\./
  );

  // An agent that cannot be started stops the run with the reason
  const noAgent = await run("rename-function", "solve", "--repeat", "3", "--agent", "/no/such/claude");
  assert.equal(noAgent.code, 1);
  assert.match(noAgent.stderr, /^Could not start \/no\/such\/claude: /);
  assert.equal(worktreesOf(repo), 1);

  // A session that can see the operator's instruction files or memory makes the comparison worthless
  const leaky = await run("rename-function", "leaky", "--repeat", "3");
  assert.equal(leaky.code, 1);
  assert.match(leaky.stderr, /^Sessions are not isolated from this machine's Claude Code setup\. A test session loaded: CLAUDE\.md in the project\./);
  const remembering = await run("rename-function", "remembering", "--repeat", "3");
  assert.match(remembering.stderr, /A test session loaded: Claude Code's auto memory\./);
  // A path to the agent is taken from where the benchmark was started. A session runs in its checkout.
  const fromHere = await runNode(BENCH, [...runArguments("rename-function", "--repeat", "3", "--agent", relative(REPO, FAKE_AGENT)), "--out", out], {
    cwd: REPO,
    env: { ...process.env, FAKE_AGENT: "leaky" },
  });
  assert.match(fromHere.stderr, /^Sessions are not isolated/);

  // What a round has written so far: records, transcripts and patches
  const thirdRound = () => readdirSync(join(out, "runs")).filter((file) => file.includes("--3."));

  // The API turns the session down before the model has answered. That is no result of either arm.
  const unreachable = await run("rename-function", "unreachable", "--repeat", "3");
  assert.equal(unreachable.code, 1);
  assert.match(
    unreachable.stderr,
    /^Fixture--rename-function--\w+--3: the session ended before the model answered once \(API Error: Request rejected \(429\) · the stand-in is rate limited\)\. Nothing was recorded for it\./
  );
  assert.deepEqual(thirdRound(), []);
  // The same in the middle of the work. Recorded, the session would count against the arm that
  // happened to be running when the limit was reached, and no later run would do it again.
  const cutOff = await run("rename-function", "cutoff", "--repeat", "3");
  assert.equal(cutOff.code, 1);
  assert.match(
    cutOff.stderr,
    /^Fixture--rename-function--\w+--3: the session lost the API in the middle of its work \(API Error: Request rejected \(429\) · the stand-in is rate limited\)\. Nothing was recorded for it\./
  );
  assert.deepEqual(thirdRound(), []);

  // Ctrl-C ends the session under way and leaves nothing of it behind
  const working = spawn(process.execPath, [BENCH, ...runArguments("rename-function", "--repeat", "3"), "--out", out], {
    env: { ...process.env, FAKE_AGENT: "busy" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let complaint = "";
  working.stderr.on("data", (chunk) => (complaint += chunk));
  // A session has started once its transcript is there
  for (let waited = 0; thirdRound().length === 0 && waited < 10000; waited += 50) {
    await sleep(50);
  }
  working.kill("SIGINT");
  const [code] = await once(working, "close");
  assert.equal(code, 130);
  assert.match(complaint, /^Interrupted\. Whatever was running has been ended\./);
  assert.deepEqual(thirdRound(), []);
  assert.equal(worktreesOf(repo), 1);

  const reported = await bench(["report"]);
  assert.equal(reported.code, 0, reported.stderr);
  const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf-8"));
  assert.deepEqual(
    [summary.overall.baseline.solved, summary.overall.baseline.sessions, summary.overall.lsp.solved, summary.overall.lsp.sessions],
    [2, 5, 2, 5]
  );
  assert.match(readFileSync(join(out, "report.html"), "utf-8"), /10 sessions in total/);
});

test("sources that a link takes out of the checkout stop the plan", async (t) => {
  // The source directory is a committed link into a directory that git ignores and the config links in
  const repo = copyFixture(t);
  mkdirSync(join(repo, "deps"));
  renameSync(join(repo, "src"), join(repo, "deps/elm-src"));
  symlinkSync("deps/elm-src", join(repo, "src"));
  writeFileSync(join(repo, ".gitignore"), "deps\n");
  gitRepository(repo);
  const main = readFileSync(join(repo, "deps/elm-src/Main.elm"), "utf-8");
  const config = join(tempDir(t), "config.json");
  writeFileSync(
    config,
    JSON.stringify({ codebases: [{ label: "Linked", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"], link: ["deps"] }] })
  );
  const out = join(tempDir(t), "out");

  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 1);
  assert.match(planned.stderr, /^Linked: in HEAD, "src" is a link that leads out of the checkout through a path that the config links into it, or to no place that can be made out\./);
  assert.equal(existsSync(join(out, "plan.json")), false);
  assert.equal(readFileSync(join(repo, "deps/elm-src/Main.elm"), "utf-8"), main);
  assert.equal(worktreesOf(repo), 1);

  // A link that stays in the checkout and leaves the Elm project root: the benchmark looks for changes below that root only
  const monorepo = tempDir(t);
  cpSync(join(REPO, "tests/fixture"), join(monorepo, "client"), { recursive: true, filter: (source) => !source.endsWith("elm-stuff") });
  mkdirSync(join(monorepo, "shared"));
  renameSync(join(monorepo, "client/src/Types.elm"), join(monorepo, "shared/Types.elm"));
  symlinkSync("../../shared/Types.elm", join(monorepo, "client/src/Types.elm"));
  gitRepository(monorepo);
  writeFileSync(
    config,
    JSON.stringify({ codebases: [{ label: "Shared", repo: monorepo, elmRoot: "client", check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] })
  );
  const shared = await runNode(BENCH, ["plan", "--config", config, "--out", join(tempDir(t), "out"), "--min-files", "1"]);
  assert.equal(shared.code, 1);
  assert.match(shared.stderr, /^Shared: 1 source file lies outside the Elm project root, src\/Types\.elm: behind a link that leads out of it, or in a source directory that the commit's elm\.json lists there\. A session's edits there would count as changes beside the project/);
});

test("an elm.json that is a link to the operator's own stops the plan before anything runs", async (t) => {
  // The project shares its elm.json with others, through a link the repository holds
  const repo = copyFixture(t);
  const shared = join(tempDir(t), "shared-elm.json");
  renameSync(join(repo, "elm.json"), shared);
  symlinkSync(shared, join(repo, "elm.json"));
  gitRepository(repo);
  const sharedText = readFileSync(shared, "utf-8");
  const ran = join(tempDir(t), "check-ran");
  const config = join(tempDir(t), "config.json");
  // A check command that would write through the link, as a session that renames a package's module would
  const check = [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(ran)}, ""); require("fs").appendFileSync("elm.json", "\\n")`, "src/Main.elm"];
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Shared", repo, check }] }));
  const out = join(tempDir(t), "out");

  // With temporary files of its own, so that what the plan leaves among them can be seen
  const temporary = tempDir(t);
  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"], { env: { ...process.env, TMPDIR: temporary } });
  assert.equal(planned.code, 1);
  assert.match(planned.stderr, /^Shared: in HEAD, the Elm root "\." has no elm\.json of its own\. It is missing there, or it is a link\./);
  assert.equal(existsSync(ran), false, "no command ran in the checkout");
  assert.equal(readFileSync(shared, "utf-8"), sharedText);
  assert.equal(existsSync(join(out, "plan.json")), false);
  // Nothing of the refused checkout is left: no worktree, no directory for one, no note of where it was.
  // Apple's git keeps a cache of its own among the temporary files, which is none of the benchmark's.
  const checkoutsIn = (directory) => readdirSync(directory).filter((name) => name.startsWith("checkout-"));
  assert.equal(worktreesOf(repo), 1);
  assert.deepEqual(checkoutsIn(temporary), []);
  assert.deepEqual(readdirSync(join(out, "work")), []);

  // The same for any other path that leads out, here through a link to the directory above the one it lies in
  rmSync(join(repo, "elm.json"));
  writeFileSync(join(repo, "elm.json"), sharedText);
  symlinkSync("..", join(repo, "src/up"));
  symlinkSync("src/up/../later.json", join(repo, "settings.json"));
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "--message", "a link out of the checkout");
  const escaping = [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(ran)}, ""); require("fs").writeFileSync("settings.json", "{}")`, "src/Main.elm"];
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Shared", repo, check: escaping }] }));
  const again = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"], { env: { ...process.env, TMPDIR: temporary } });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /^Shared: in HEAD, "settings\.json" is a link that leads out of the checkout, or to no place that can be made out\. /);
  assert.equal(existsSync(ran), false);
  assert.deepEqual(checkoutsIn(temporary), []);
});

test("a field rename that deletes an Elm module or adds one is no solution", async (t) => {
  const repo = copyFixture(t);
  writeFileSync(join(repo, "src/Unused.elm"), "module Unused exposing (unused)\n\n\nunused =\n    1\n");
  gitRepository(repo);
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm", "src/FieldRename.elm", "src/TestRemoveVariant.elm"] }],
    })
  );
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);
  const { tasks } = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8"));
  assert.match(tasks.find((task) => task.type === "rename-field").prompt, /^Rename the field `name` of the record type alias `User` in `src\/Types\.elm` to `nameRenamed`\./);

  // A record travels anywhere, so this task has no list of files that may change. What a rename is still holds.
  const rename = `fs.writeFileSync("src/Types.elm", fs.readFileSync("src/Types.elm", "utf8").replace(/\\bname\\b/g, "nameRenamed"));`;
  const judged = async (edit, round) => {
    const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "rename-field", "--arms", "baseline", "--agent", standInAgent(t, edit), "--repeat", round]);
    assert.equal(ran.code, 0, ran.stderr);
    const { outcome, problems } = JSON.parse(readFileSync(join(out, "runs", `Fixture--rename-field--baseline--${round}.json`), "utf-8"));
    return { outcome, problems };
  };
  assert.deepEqual(await judged(rename, "1"), { outcome: "passed", problems: [] });
  // The module is used nowhere, so the compiler does not miss it
  assert.deepEqual(await judged(`${rename}\n  fs.rmSync("src/Unused.elm");`, "2"), {
    outcome: "wrong-result",
    problems: ["src/Unused.elm was deleted, which no rename asks for"],
  });
  assert.deepEqual(await judged(`${rename}\n  fs.writeFileSync("src/Extra.elm", "module Extra exposing (extra)\\n\\n\\nextra =\\n    1\\n");`, "3"), {
    outcome: "wrong-result",
    problems: ["src/Extra.elm is a new file, which no rename asks for"],
  });
});

test("a module in a source directory below node_modules is renamed and judged like any other", async (t) => {
  // A package that came through npm, committed, and listed as a source directory
  const repo = tempDir(t);
  const elmJson = JSON.parse(readFileSync(join(REPO, "tests/fixture/elm.json"), "utf-8"));
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "node_modules/shared/src"), { recursive: true });
  writeFileSync(join(repo, "elm.json"), JSON.stringify({ ...elmJson, "source-directories": ["src", "node_modules/shared/src"] }));
  writeFileSync(join(repo, "src/Main.elm"), "module Main exposing (main)\n\nimport Lib\n\n\nmain : String\nmain =\n    Lib.label\n");
  writeFileSync(join(repo, "node_modules/shared/src/Lib.elm"), 'module Lib exposing (label)\n\n\nlabel : String\nlabel =\n    "Lib"\n');
  gitRepository(repo);
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Shared", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);
  const { tasks } = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8"));
  assert.match(tasks.find((task) => task.type === "rename-module").prompt, /^Rename the module `Lib` to `LibRenamed`/);

  const judged = async (edit, round) => {
    const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "rename-module", "--arms", "baseline", "--agent", standInAgent(t, edit), "--repeat", round]);
    assert.equal(ran.code, 0, ran.stderr);
    const record = join(out, "runs", `Shared--rename-module--baseline--${round}`);
    const { outcome, problems } = JSON.parse(readFileSync(`${record}.json`, "utf-8"));
    return { outcome, problems, patch: readFileSync(`${record}.patch`, "utf-8") };
  };
  const move = (from, to) => `const lib = fs.readFileSync("node_modules/shared/src/Lib.elm", "utf8");
  fs.rmSync("node_modules/shared/src/Lib.elm");
  fs.writeFileSync("node_modules/shared/src/LibRenamed.elm", lib.replace(${from}, "${to}"));
  fs.writeFileSync("src/Main.elm", fs.readFileSync("src/Main.elm", "utf8").replace(/\\bLib\\b/g, "LibRenamed"));`;

  // The module at its new place is no file of the commit, and it is the project's all the same.
  // What a package below it brings along is not.
  const right = await judged(`${move("/^module Lib/", "module LibRenamed")}\n  fs.mkdirSync("node_modules/tool", { recursive: true });\n  fs.writeFileSync("node_modules/tool/Template.elm", "module Template exposing (x)\\n");`, "1");
  assert.deepEqual({ outcome: right.outcome, problems: right.problems }, { outcome: "passed", problems: [] });
  assert.match(right.patch, /^\+module LibRenamed exposing \(label\)$/m);
  assert.ok(!right.patch.includes("Template"), right.patch);
  // A text replace that reached into the string it returns is seen there
  const wrong = await judged(move("/Lib/g", "LibRenamed"), "2");
  assert.equal(wrong.outcome, "wrong-result");
  assert.match(wrong.problems.join("\n"), /^node_modules\/shared\/src\/LibRenamed\.elm changed in more than the name/);
});

test("the plan passes over what an Elm project inside the project uses", async (t) => {
  const repo = copyFixture(t);
  mkdirSync(join(repo, "examples/src"), { recursive: true });
  writeFileSync(join(repo, "examples/elm.json"), JSON.stringify({ type: "application", "source-directories": ["src", "../src"] }));
  writeFileSync(join(repo, "examples/src/Demo.elm"), "module Demo exposing (demo)\n\nimport Types\n\n\ndemo =\n    Types.defaultUser\n");
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
  const out = join(tempDir(t), "out");

  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(
    planned.stdout,
    /Fixture: 1 Elm file lies outside the project's source directories\. \d+ possible targets? w(as|ere) left out because such a file can use them\./
  );
  // Without the example, the function to rename is defaultUser of Types, which the example calls
  const { tasks } = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8"));
  const prompts = tasks.map((task) => task.prompt).join("\n");
  assert.ok(tasks.length > 0 && !/`Types`/.test(prompts), prompts);

  // An elm.json can name "src" as "Src" where the file system ignores letter case, and the compiler builds the project.
  // Its modules are those under "src", and none of them lies outside the source directories.
  const shouting = copyFixture(t, "shouting");
  const ignoring = sameDirectory(join(shouting, "src"), join(shouting, "SRC"));
  await t.test("a source directory in another letter case", { skip: !ignoring && "the file system of the test tells upper from lower case" }, async () => {
    const elmJson = JSON.parse(readFileSync(join(shouting, "elm.json"), "utf-8"));
    writeFileSync(join(shouting, "elm.json"), JSON.stringify({ ...elmJson, "source-directories": ["Src"] }));
    gitRepository(shouting);
    writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo: shouting, check: [process.execPath, FAKE_COMPILER, "Src/Main.elm", "SRC/FieldRename.elm", "src/TestRemoveVariant.elm"] }] }));
    const read = await runNode(BENCH, ["plan", "--config", config, "--out", join(tempDir(t), "out"), "--min-files", "1"]);
    assert.equal(read.code, 0, read.stderr);
    assert.match(read.stdout, /^Fixture: 4 tasks in 5 modules, of which the check command compiles 5$/m);
    assert.doesNotMatch(read.stdout, /outside the project's source directories/);
  });
});

test("a plan of several codebases keeps the checkout of each apart, and Lamdera's modules their names", async (t) => {
  const first = gitRepository(copyFixture(t, "first"));
  // The second project uses Lamdera, which finds Types, Env, Frontend and Backend by their names
  const second = copyFixture(t, "second");
  const elmJson = JSON.parse(readFileSync(join(second, "elm.json"), "utf-8"));
  elmJson.dependencies.direct["lamdera/core"] = "1.0.0";
  writeFileSync(join(second, "elm.json"), JSON.stringify(elmJson));
  gitRepository(second);
  const out = join(tempDir(t), "out");
  const seen = join(tempDir(t), "slots.jsonl");
  // A check command that notes which checkouts the benchmark remembers while it runs
  const note = `require("fs").appendFileSync(${JSON.stringify(seen)}, JSON.stringify(require("fs").readdirSync(${JSON.stringify(join(out, "work"))})) + "\\n")`;
  const check = [process.execPath, "-e", note, "src/Main.elm"];
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "First", repo: first, check }, { label: "Second", repo: second, check }] }));

  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  // One slot per codebase: a plan that is killed in the second still finds the checkout of the first
  const slots = readFileSync(seen, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual([...new Set(slots.map(String))], ["First.plan", "Second.plan"]);
  assert.deepEqual(readdirSync(join(out, "work")), []);

  const { tasks } = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8"));
  const moduleRename = (label) => tasks.find((task) => task.id === `${label}/rename-module`).prompt;
  assert.match(moduleRename("First"), /^Rename the module `Types` to `TypesRenamed`\./);
  assert.match(moduleRename("Second"), /^Rename the module `Utils` to `UtilsRenamed`\./);
  // Every prompt says that nothing else is to change, which is what the verdict holds a session to
  assert.ok(tasks.every((task) => task.prompt.includes("\n\nChange nothing else. The project compiles with ")));
  // An application lists no modules in its elm.json, so no request names that file
  assert.ok(tasks.every((task) => !task.prompt.includes("elm.json")));
  // The check command is written as a shell takes it. This one has an argument with spaces and brackets in it.
  assert.ok(tasks.every((task) => task.prompt.includes(`compiles with \`${process.execPath} -e 'require("fs").appendFileSync(`)));
});

test("the request to rename a module that a package exposes names elm.json", async (t) => {
  const repo = copyFixture(t);
  const elmJson = JSON.parse(readFileSync(join(repo, "elm.json"), "utf-8"));
  // The modules come in groups with a title each, as a package can list them
  writeFileSync(join(repo, "elm.json"), JSON.stringify({ ...elmJson, "exposed-modules": { Core: ["Types"], More: ["Utils"] } }));
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Package", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
  const out = join(tempDir(t), "out");

  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  const { tasks } = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8"));
  assert.match(
    tasks.find((task) => task.type === "rename-module").prompt,
    /^Rename the module `Types` to `TypesRenamed`\. .* The package exposes the module, so change its name in the `exposed-modules` of `elm\.json` as well\.\n\nChange nothing else\./
  );
  // No other request has to do with that list
  assert.deepEqual(tasks.filter((task) => task.prompt.includes("elm.json")).map((task) => task.type), ["rename-module"]);
});

test("a session that commits its changes is judged by all of them, and told that it committed", async (t) => {
  const repo = gitRepository(copyFixture(t));
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm", "src/FieldRename.elm", "src/TestRemoveVariant.elm"] }],
    })
  );
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);

  // It renames the function, adds a function to a module that cannot use the target, and commits both.
  // "git -C . commit" is not among the commands a session is denied.
  const agent = standInAgent(
    t,
    `for (const file of ["src/Types.elm", "src/Main.elm", "src/Utils.elm"]) {
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\\bdefaultUser\\b/g, "defaultUserRenamed"));
  }
  fs.appendFileSync("src/FieldRename.elm", "\\n\\nextra : Int\\nextra =\\n    1\\n");
  require("child_process").execFileSync("git", ["-C", ".", "-c", "user.name=agent", "-c", "user.email=agent@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "--all", "--message", "done"]);`
  );
  const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "rename-function", "--arms", "baseline", "--agent", agent]);
  assert.equal(ran.code, 0, ran.stderr);

  const record = JSON.parse(readFileSync(join(out, "runs", "Fixture--rename-function--baseline--1.json"), "utf-8"));
  assert.deepEqual(
    { outcome: record.outcome, problems: record.problems, changedFiles: record.changedFiles },
    {
      outcome: "wrong-result",
      problems: [
        "src/FieldRename.elm changed in more than the name: the end of the file became extra",
        "changed files that cannot use the target: src/FieldRename.elm",
        "the session created a commit, which the task told it not to",
      ],
      changedFiles: 3,
    }
  );
  assert.match(readFileSync(join(out, "runs", "Fixture--rename-function--baseline--1.patch"), "utf-8"), /^\+extra : Int$/m);
  assert.equal(worktreesOf(repo), 1);
});

test("a rename that also changes a data file and a build script is no solution, and what a build wrote is no change", async (t) => {
  const repo = copyFixture(t);
  writeFileSync(join(repo, "business.json"), '{"price":100}\n');
  writeFileSync(join(repo, "build.sh"), "#!/bin/sh\nexit 1\n");
  gitRepository(repo);
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm", "src/FieldRename.elm", "src/TestRemoveVariant.elm"] }],
    })
  );
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);

  const rename = `for (const file of ["src/Types.elm", "src/Main.elm"]) {
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\\bdefaultUser\\b/g, "defaultUserRenamed"));
  }`;
  const judged = async (agent, round) => {
    const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "rename-function", "--arms", "baseline", "--agent", agent, "--repeat", round]);
    assert.equal(ran.code, 0, ran.stderr);
    const { outcome, problems } = JSON.parse(readFileSync(join(out, "runs", `Fixture--rename-function--baseline--${round}.json`), "utf-8"));
    return { outcome, problems };
  };

  // The rename itself is right. The price and the script that a build would run are not the session's to change.
  const meddling = standInAgent(t, `${rename}\n  fs.writeFileSync("business.json", '{"price":0}\\n');\n  fs.writeFileSync("build.sh", "#!/bin/sh\\nexit 0\\n");`);
  assert.deepEqual(await judged(meddling, "1"), { outcome: "wrong-result", problems: ["changed files that are no Elm sources of the project: build.sh, business.json"] });

  // The page that "elm make" writes without --output, and a note. The commit holds neither, and neither changes the project.
  const untidy = standInAgent(t, `${rename}\n  fs.writeFileSync("index.html", "<html></html>\\n");\n  fs.writeFileSync("notes.txt", "done\\n");`);
  assert.deepEqual(await judged(untidy, "2"), { outcome: "passed", problems: [] });
});

test("a rename that also rewrites a file beside the Elm project is no solution", async (t) => {
  // The Elm project is one directory of the repository, and the repository's README lies beside it
  const repo = tempDir(t);
  cpSync(copyFixture(t), join(repo, "client"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "How to build\n");
  gitRepository(repo);
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  const check = [process.execPath, FAKE_COMPILER, "src/Main.elm", "src/FieldRename.elm", "src/TestRemoveVariant.elm"];
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, elmRoot: "client", check }] }));
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);

  // A session works in the Elm root
  const rename = `for (const file of ["src/Types.elm", "src/Main.elm"]) {
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\\bdefaultUser\\b/g, "defaultUserRenamed"));
  }`;
  const judged = async (agent, round) => {
    const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "rename-function", "--arms", "baseline", "--agent", agent, "--repeat", round]);
    assert.equal(ran.code, 0, ran.stderr);
    const { outcome, problems, changedFiles } = JSON.parse(readFileSync(join(out, "runs", `Fixture--rename-function--baseline--${round}.json`), "utf-8"));
    return { outcome, problems, changedFiles };
  };

  const meddling = standInAgent(t, `${rename}\n  fs.writeFileSync("../README.md", "Nothing to build\\n");`);
  assert.deepEqual(await judged(meddling, "1"), {
    outcome: "wrong-result",
    problems: ["changed files that are no Elm sources of the project: ../README.md"],
    changedFiles: 3,
  });
  assert.match(readFileSync(join(out, "runs", "Fixture--rename-function--baseline--1.patch"), "utf-8"), /^-How to build$/m);

  // A note beside the project is a file the commit does not hold, as one in the project is. It is
  // kept in the patch and is no changed file of the project.
  const untidy = standInAgent(t, `${rename}\n  fs.writeFileSync("../notes.txt", "done\\n");\n  fs.writeFileSync("index.html", "<html></html>\\n");`);
  assert.deepEqual(await judged(untidy, "2"), { outcome: "passed", problems: [], changedFiles: 2 });
  assert.match(readFileSync(join(out, "runs", "Fixture--rename-function--baseline--2.patch"), "utf-8"), /^\+done$/m);
  assert.equal(worktreesOf(repo), 1);
});

test("a plan without a target names the file that holds back the most candidates, and counts the others", async (t) => {
  // The check command builds Main.elm alone. The field to rename is "name" of a record in Types.elm, and
  // two modules outside that build name a field so called: FieldRename.elm, and Guests.elm, which is new here.
  const repo = copyFixture(t);
  writeFileSync(
    join(repo, "src/Guests.elm"),
    "module Guests exposing (first)\n\nimport FieldRename exposing (Person)\n\n\nfirst : Person -> String\nfirst person =\n    person.name\n"
  );
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));

  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", join(tempDir(t), "out"), "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(
    planned.stdout,
    /Fixture: no suitable target for rename-field\. 2 of its candidates involve src\/FieldRename\.elm, which the check command does not compile, and 1 other such file holds candidates back too$/m
  );
  assert.match(planned.stdout, /Fixture: no suitable target for add-variant\. 2 of its candidates involve src\/TestRemoveVariant\.elm, which the check command does not compile$/m);
});

test("a type that cannot be given a variant is passed over, and a plan says why no type was a target", async (t) => {
  const repo = copyFixture(t);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
  const typed = (name, oneLine) => (oneLine ? [`type ${name} = ${name}A | ${name}B | ${name}C`] : [`type ${name}`, `    = ${name}A`, `    | ${name}B`, `    | ${name}C`]);
  const used = (name) => ["", "", `name${name} : ${name} -> Int`, `name${name} value =`, "    case value of", `        ${name}A ->`, "            1", "", "        _ ->", "            2"];
  const many = (names, note = []) =>
    ["module Many exposing (..)", ...note, ...names.flatMap((name) => ["", "", ...typed(name, name !== "Last"), ...used(name)]), ""].join("\n");
  const main = readFileSync(join(repo, "src/Main.elm"), "utf-8").replace("import Browser\n", "import Browser\nimport Many\n");
  const plan = async (source) => {
    writeFileSync(join(repo, "src/Many.elm"), source);
    writeFileSync(join(repo, "src/Main.elm"), main);
    gitRepository(repo);
    const out = join(tempDir(t), "out");
    const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
    assert.equal(planned.code, 0, planned.stderr);
    return { stdout: planned.stdout, task: JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).tasks.find((task) => task.type === "add-variant") };
  };

  // Six types written on one line come first. The seventh has a line for each variant, which the plan can add to.
  const found = await plan(many(["A", "B", "C", "D", "E", "F", "Last"]));
  assert.match(found.task.prompt, /as the last variant of the custom type `Last` in `src\/Many\.elm`/);

  // The stand-in compiler takes the note for a branch, as the real one takes a catch-all: nothing breaks
  rmSync(join(repo, ".git"), { recursive: true });
  const none = await plan(many(["Last"], ["", '-- AddedByBenchmark -> Debug.todo "is what a branch would read"']));
  assert.equal(none.task, undefined);
  assert.match(none.stdout, /^Fixture: no suitable target for add-variant\. The project still compiled with the change made to the one target that was tried, so there was no work to ask for$/m);

  // Where every type is written on one line, none could be tried
  rmSync(join(repo, ".git"), { recursive: true });
  const untried = await plan(many(["A", "B"]));
  assert.equal(untried.task, undefined);
  assert.match(untried.stdout, /^Fixture: no suitable target for add-variant\. The plan adds a variant on a line of its own, as elm-format lays a type out, and none of the 2 targets is written that way$/m);

  // A build that runs out of time once the variant is added has not said whether the compiler asks for a branch
  rmSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, "src/Many.elm"), many(["Last"]));
  gitRepository(repo);
  const slow = `if (require("fs").readFileSync("src/Many.elm", "utf-8").includes("AddedByBenchmark")) setTimeout(() => {}, 60000)`;
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, "-e", slow, "--", "src/Main.elm"], checkTimeoutMs: 2000 }] }));
  const out = join(tempDir(t), "out");
  const cut = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(cut.code, 1);
  assert.match(
    cut.stderr,
    /^Fixture: with the variant AddedByBenchmark added to the type Last in src\/Many\.elm, the check command ran out of time\. Its limit is 2000 ms, and whether the variant breaks the build is not known\. Raise checkTimeoutMs in the config\.$/m
  );
  assert.equal(existsSync(join(out, "plan.json")), false);
  assert.equal(worktreesOf(repo), 1);
});

test("a check command that rewrites a file of the commit stops the plan", async (t) => {
  // The bundle is checked in, and the build writes it anew each time
  const repo = copyFixture(t);
  mkdirSync(join(repo, "public"));
  writeFileSync(join(repo, "public/elm.js"), "// built\n");
  gitRepository(repo);
  // A bundle in step with its sources is written the bytes it has, until a session changes the sources
  for (const written of ["// built again\\n", "// built\\n"]) {
    const build = `require("fs").writeFileSync("public/elm.js", "${written}")`;
    const config = join(tempDir(t), "config.json");
    writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, "-e", build, "src/Main.elm"] }] }));
    const out = join(tempDir(t), "out");

    // A session that ran the command would have changed a file that is no Elm source, and one that did not would not
    const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
    assert.equal(planned.code, 1);
    assert.match(planned.stderr, /^Fixture: ".*" writes 1 file that the commit holds, public\/elm\.js\. A session that ran it would be judged by what it wrote there, and one that did not would not\. Have it write where the repository holds nothing, as with --output=\/dev\/null\.$/m);
    assert.equal(existsSync(join(out, "plan.json")), false);
    assert.equal(worktreesOf(repo), 1);
  }

  // The compiler's cache has no other place to go, so a commit that holds it gets other advice
  const cached = copyFixture(t, "cached");
  mkdirSync(join(cached, "elm-stuff/0.19.1"), { recursive: true });
  writeFileSync(join(cached, "elm-stuff/0.19.1/Main.elmo"), "old");
  gitRepository(cached);
  const compile = `require("fs").writeFileSync("elm-stuff/0.19.1/Main.elmo", "new")`;
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Cached", repo: cached, check: [process.execPath, "-e", compile, "src/Main.elm"] }] }));
  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", join(tempDir(t), "out"), "--min-files", "1"]);
  assert.equal(planned.code, 1);
  assert.match(planned.stderr, /writes 1 file that the commit holds, elm-stuff\/0\.19\.1\/Main\.elmo\. .* would not\. The commit holds the compiler's cache\. Benchmark a commit without elm-stuff\.$/m);

  // An Elm source that the commit does not hold counts against a session as well, whatever it holds. Each of these
  // builds writes one that git ignores before it compiles, and Main imports it. A digest of another module, what
  // "git describe --dirty" prints and the day of the build are the same text in both builds of the plan, and a
  // session's edit changes the first two.
  const generators = [
    ["Digest", `require("crypto").createHash("sha256").update(require("fs").readFileSync("src/Types.elm")).digest("hex")`],
    ["Version", `require("child_process").execFileSync("git", ["describe", "--always", "--dirty"]).toString().trim()`],
    ["Day", `new Date().toISOString().slice(0, 10)`],
  ];
  for (const [module, text] of generators) {
    const stamped = copyFixture(t, module);
    const main = join(stamped, "src/Main.elm");
    writeFileSync(main, readFileSync(main, "utf-8").replace("import Browser\n", `import Browser\nimport ${module}\n`));
    writeFileSync(join(stamped, ".gitignore"), `src/${module}.elm\n`);
    gitRepository(stamped);
    const generate =
      `require("fs").writeFileSync("src/${module}.elm", "module ${module} exposing (text)\\n\\n\\ntext : String\\ntext =\\n    \\"" + ${text} + "\\"\\n"); ` +
      `import(${JSON.stringify(FAKE_COMPILER)})`;
    writeFileSync(config, JSON.stringify({ codebases: [{ label: module, repo: stamped, check: [process.execPath, "-e", generate, "src/Main.elm"] }] }));
    const out = join(tempDir(t), "out");
    const generated = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
    assert.equal(generated.code, 1, module);
    assert.match(
      generated.stderr,
      new RegExp(
        `^${module}: ".*" writes 1 Elm file that the commit does not hold, src/${module}\\.elm\\. A session that ran it would be judged by what it wrote there, and one that did not would not\\. ` +
          `Commit what it generates, and leave the generator out of the check command\\.$`,
        "m"
      )
    );
    assert.equal(existsSync(join(out, "plan.json")), false);
    assert.equal(worktreesOf(stamped), 1);
  }

  // This build writes an Elm file once an earlier build has left its log behind. A session's builds come after the
  // one that its checkout has before the session, so a session that ran the command would write that file.
  const late = copyFixture(t, "late");
  gitRepository(late);
  const second =
    `const fs = require("fs"); if (fs.existsSync("build.log")) fs.writeFileSync("src/Late.elm", "module Late exposing (late)\\n"); ` +
    `fs.writeFileSync("build.log", ""); import(${JSON.stringify(FAKE_COMPILER)})`;
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Late", repo: late, check: [process.execPath, "-e", second, "src/Main.elm"] }] }));
  const lateOut = join(tempDir(t), "out");
  const secondRun = await runNode(BENCH, ["plan", "--config", config, "--out", lateOut, "--min-files", "1"]);
  assert.equal(secondRun.code, 1);
  assert.match(
    secondRun.stderr,
    /^Late: ".*" writes 1 Elm file when it runs a second time without a change, src\/Late\.elm\. A session that ran it would be judged by what it wrote there, and one that did not would not\. Have it write the same files each time\.$/m
  );
  assert.equal(existsSync(join(lateOut, "plan.json")), false);
  assert.equal(worktreesOf(late), 1);

  // This build leaves a lock behind, and the next one fails on it. A session that ran the command twice would see it fail.
  const locked = copyFixture(t, "locked");
  gitRepository(locked);
  const lock = `const fs = require("fs"); if (fs.existsSync("build.lock")) { console.error("build.lock is in the way"); process.exit(1); } fs.writeFileSync("build.lock", "")`;
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Locked", repo: locked, check: [process.execPath, "-e", lock, "src/Main.elm"] }] }));
  const twice = await runNode(BENCH, ["plan", "--config", config, "--out", join(tempDir(t), "out"), "--min-files", "1"]);
  assert.equal(twice.code, 1);
  assert.match(twice.stderr, /^Locked: on .*, built a second time without a change, the check command fails: build\.lock is in the way$/m);
  assert.equal(worktreesOf(locked), 1);

  // A log with the time of each build is written anew each time as well. git does not track it and no verdict reads it, so the plan goes on.
  const logged = copyFixture(t, "logged");
  gitRepository(logged);
  const log = `require("fs").writeFileSync("build.log", "built at " + Date.now() + "\\n"); import(${JSON.stringify(FAKE_COMPILER)})`;
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Logged", repo: logged, check: [process.execPath, "-e", log, "src/Main.elm"] }] }));
  const loggedOut = join(tempDir(t), "out");
  const goesOn = await runNode(BENCH, ["plan", "--config", config, "--out", loggedOut, "--min-files", "1"]);
  assert.equal(goesOn.code, 0, goesOn.stderr);
  assert.ok(existsSync(join(loggedOut, "plan.json")));
});

test("a check command that names a file of the operator's checkout behind an option stops the plan before anything runs", async (t) => {
  // The bundle is checked in, and a build given its whole path would write the original one, which the worktree does not see
  const repo = copyFixture(t);
  const bundle = join(repo, "bundle.js");
  writeFileSync(bundle, "// sentinel\n");
  gitRepository(repo);
  const build = `const output = process.argv.find((word) => word.startsWith("--output=")); require("fs").writeFileSync(output.slice(9), "// built\\n")`;
  // Named as it lies, and through a link to the repository from elsewhere
  const alias = join(tempDir(t), "alias");
  symlinkSync(repo, alias);
  const stopsBefore = async (output) => {
    const config = join(tempDir(t), "config.json");
    writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, "-e", build, "src/Main.elm", `--output=${output}`] }] }));
    const out = join(tempDir(t), "out");

    const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
    assert.equal(planned.code, 1);
    assert.ok(planned.stderr.startsWith(`Invalid benchmark config: codebases[0].check names ${output}, a path inside the repository.`), planned.stderr);
    assert.equal(readFileSync(bundle, "utf-8"), "// sentinel\n");
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(worktreesOf(repo), 1);
    assert.equal(existsSync(join(out, "plan.json")), false);
  };
  for (const output of [bundle, join(alias, "bundle.js")]) {
    await stopsBefore(output);
  }
  // Named in another letter case, where the file system ignores case and the compiler would write the same file
  const shouted = join(dirname(repo), basename(repo).toUpperCase());
  await t.test("another letter case", { skip: !sameDirectory(repo, shouted) && "the file system of the test tells upper from lower case" }, () =>
    stopsBefore(join(shouted, "bundle.js"))
  );
});

test("a file beside an Elm root that is a link is named from where the root really lies", async (t) => {
  // The commit has "client" as a link to packages/app. A session works there, and "../Extra.elm" is packages/Extra.elm.
  const repo = tempDir(t);
  cpSync(copyFixture(t), join(repo, "packages/app"), { recursive: true });
  symlinkSync("packages/app", join(repo, "client"));
  gitRepository(repo);
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  const check = [process.execPath, FAKE_COMPILER, "src/Main.elm", "src/FieldRename.elm", "src/TestRemoveVariant.elm"];
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, elmRoot: "client", check }] }));
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);

  const agent = standInAgent(
    t,
    `for (const file of ["src/Types.elm", "src/Main.elm"]) {
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\\bdefaultUser\\b/g, "defaultUserRenamed"));
  }
  fs.writeFileSync("../Extra.elm", "module Extra exposing (x)\\n\\n\\nx =\\n    1\\n");`
  );
  const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "rename-function", "--arms", "baseline", "--agent", agent]);
  assert.equal(ran.code, 0, ran.stderr);
  const { outcome, problems } = JSON.parse(readFileSync(join(out, "runs", "Fixture--rename-function--baseline--1.json"), "utf-8"));
  assert.deepEqual(
    { outcome, problems },
    { outcome: "wrong-result", problems: ["../Extra.elm is a new file, which no rename asks for", "changed files that cannot use the target: ../Extra.elm"] }
  );
  assert.equal(worktreesOf(repo), 1);
});

test("the plan passes over what a source file behind a link uses", async (t) => {
  // src/Types.elm is a link to a file elsewhere in the project. git names a change to it by that
  // other file, where no expectation looks for it.
  const repo = copyFixture(t);
  mkdirSync(join(repo, "shared"));
  renameSync(join(repo, "src/Types.elm"), join(repo, "shared/Types.elm"));
  symlinkSync("../shared/Types.elm", join(repo, "src/Types.elm"));
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  const check = [process.execPath, FAKE_COMPILER, "src/Main.elm", "src/FieldRename.elm", "src/TestRemoveVariant.elm"];
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check }] }));
  const out = join(tempDir(t), "out");

  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  assert.match(planned.stdout, /Fixture: 2 possible targets were left out because a file they involve is reached through a link\./);
  const { tasks, codebases } = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8"));
  assert.equal(codebases[0].linked, 2);
  // Without the link, the function to rename is one of Types.elm
  const mayChange = tasks.flatMap((task) => task.expect.filter((expectation) => expectation.kind === "changes-only-in").flatMap((expectation) => expectation.files));
  assert.ok(tasks.length > 0 && !mayChange.includes("src/Types.elm"), JSON.stringify(mayChange));
  assert.equal(worktreesOf(repo), 1);

  // With Utils.elm behind a link as well, no module is left to rename, and the plan says what became of each candidate
  const both = copyFixture(t, "both");
  mkdirSync(join(both, "shared"));
  for (const module of ["Types", "Utils"]) {
    renameSync(join(both, `src/${module}.elm`), join(both, `shared/${module}.elm`));
    symlinkSync(`../shared/${module}.elm`, join(both, `src/${module}.elm`));
  }
  gitRepository(both);
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo: both, check }] }));
  const none = await runNode(BENCH, ["plan", "--config", config, "--out", join(tempDir(t), "out"), "--min-files", "1"]);
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stdout, /^Fixture: no suitable target for rename-function\. Its candidates were left out: 1 that an Elm file outside the project can use, 2 that involve a file that is reached through a link$/m);
  assert.match(none.stdout, /^Fixture: no suitable target for rename-module\. Its candidates were left out: 1 that an Elm file outside the project can use, 1 that involves a file that is reached through a link$/m);
});

// A git for the benchmark to find first on PATH, which hands every command on to the real one.
// It notes when a command that adds or removes a worktree starts and ends, and says when a
// listing of the worktrees begins. Those three it holds up for a moment.
function slowGit(t, { log, listing }) {
  const bin = tempDir(t);
  const real = execFileSync("which", ["git"]).toString().trim();
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
const changes = args.includes("worktree") && (args.includes("add") || args.includes("remove"));
if (changes) fs.appendFileSync(${JSON.stringify(log)}, "start " + Date.now() + "\\n");
if (args.includes("worktree") && args.includes("list")) fs.writeFileSync(${JSON.stringify(listing)}, "");
if (args.includes("worktree")) pause();
const { status } = require("child_process").spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" });
if (changes) fs.appendFileSync(${JSON.stringify(log)}, "end " + Date.now() + "\\n");
process.exit(status ?? 1);
`,
    { mode: 0o755 }
  );
  return `${bin}:${process.env.PATH}`;
}

// A planned fixture: its repository, its output directory and the arguments that name both.
async function plannedFixture(t) {
  const repo = gitRepository(copyFixture(t));
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  const check = [process.execPath, FAKE_COMPILER, "src/Main.elm", "src/FieldRename.elm", "src/TestRemoveVariant.elm"];
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check }] }));
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);
  return { repo, out, config, codebase: loadConfig(config).codebases[0], common: ["--config", config, "--out", out, "--agent", FAKE_AGENT] };
}

test("Ctrl-C in a terminal ends the sessions and lets the benchmark's own git commands finish", async (t) => {
  const { repo, out, common } = await plannedFixture(t);
  const [log, listing] = [join(tempDir(t), "git.log"), join(tempDir(t), "listing")];

  // A process group of its own, as a terminal gives a command. Ctrl-C goes to every process in it.
  const running = spawn(process.execPath, [BENCH, "run", ...common, "--arms", "baseline", "--only", "rename-function"], {
    env: { ...process.env, PATH: slowGit(t, { log, listing }), FAKE_AGENT: "solve" },
    stdio: "ignore",
    detached: true,
  });
  t.after(() => running.kill("SIGKILL"));
  // The first listing of the worktrees is the one that removes the session's checkout, with its result judged
  for (let waited = 0; !existsSync(listing) && waited < 20000; waited += 20) {
    await sleep(20);
  }
  process.kill(-running.pid, "SIGINT");
  const [code] = await once(running, "close");

  assert.equal(code, 130);
  // The session has its record, so no later run comes back for its checkout. It has to be gone now.
  assert.ok(existsSync(join(out, "runs", "Fixture--rename-function--baseline--1.json")));
  assert.deepEqual(readdirSync(join(out, "work")), []);
  assert.equal(worktreesOf(repo), 1);
});

test("a reader of stdout that goes away ends the sessions as an interrupt does", async (t) => {
  // The first session works on while two others solve their tasks one after the other, so their lines are
  // written while a session runs. Node passes over the first write that meets EPIPE, and throws at the next.
  // The reader of stderr goes as well the second time, so the benchmark's message has nowhere to go.
  for (const both of [false, true]) {
    const { repo, out, common } = await plannedFixture(t);
    const running = spawn(process.execPath, [BENCH, "run", ...common, "--arms", "baseline", "--only", "rename-function", "--repeat", "3", "--concurrency", "2"], {
      env: { ...process.env, FAKE_AGENT: "first-busy", FAKE_AGENT_FIRST: join(tempDir(t), "first") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => running.kill("SIGKILL"));
    let said = "";
    running.stderr.on("data", (chunk) => (said += chunk));
    // As "| head -n 2" does: the reader takes the two lines that come before the sessions, and goes
    let read = "";
    running.stdout.on("data", (chunk) => {
      read += chunk;
      if (read.split("\n").length > 2) {
        running.stdout.destroy();
        if (both) running.stderr.destroy();
      }
    });
    const [code] = await once(running, "close");

    assert.equal(code, 130, said);
    if (!both) {
      assert.match(said, /^write EPIPE\nInterrupted\. Whatever was running has been ended\. Finished sessions keep their records/);
      assert.doesNotMatch(said, /\n {4}at /, "no stack trace");
    }
    // The sessions that finished keep their records. The one that worked on leaves nothing.
    assert.equal(readdirSync(join(out, "runs")).filter((file) => file.endsWith(".json")).length, 2);
    assert.deepEqual(readdirSync(join(out, "work")), []);
    assert.equal(worktreesOf(repo), 1);
  }
});

test("a reader of stdout that goes away fails a run whose sessions had all ended", async (t) => {
  // Two sessions, one after the other. The line of the second is the write that throws, and by then nothing runs.
  const { repo, out, common } = await plannedFixture(t);
  const running = spawn(process.execPath, [BENCH, "run", ...common, "--arms", "baseline", "--only", "rename-function", "--repeat", "2", "--concurrency", "1"], {
    env: { ...process.env, FAKE_AGENT: "solve" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => running.kill("SIGKILL"));
  let said = "";
  running.stderr.on("data", (chunk) => (said += chunk));
  let read = "";
  running.stdout.on("data", (chunk) => {
    read += chunk;
    if (read.split("\n").length > 2) running.stdout.destroy();
  });
  const [code] = await once(running, "close");

  // Nothing was interrupted, so the status is the one of an error and not 130
  assert.equal(code, 1, said);
  assert.equal(said, "write EPIPE\n");
  assert.equal(readdirSync(join(out, "runs")).filter((file) => file.endsWith(".json")).length, 2);
  assert.deepEqual(readdirSync(join(out, "work")), []);
  assert.equal(worktreesOf(repo), 1);
});

test("a stop while the plan removes its last checkout leaves no plan", async (t) => {
  const repo = gitRepository(copyFixture(t));
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  writeFileSync(
    config,
    JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm", "src/FieldRename.elm", "src/TestRemoveVariant.elm"] }] })
  );
  // A git that stops the benchmark as Ctrl-C does before it removes a worktree, and then removes it.
  // The signal comes before the command starts, so the benchmark has it before the command ends.
  const bin = tempDir(t);
  const real = execFileSync("which", ["git"]).toString().trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" worktree remove "*) kill -INT $PPID ;; esac\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });

  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(planned.code, 130, planned.stderr);
  assert.match(planned.stderr, /^Interrupted\. Whatever was running has been ended\. No plan was written\.$/m);
  assert.equal(existsSync(join(out, "plan.json")), false);
  assert.equal(worktreesOf(repo), 1);
});

test("sessions that run side by side add and remove their checkouts one after the other", async (t) => {
  const { repo, out, common } = await plannedFixture(t);
  const [log, listing] = [join(tempDir(t), "git.log"), join(tempDir(t), "listing")];

  const ran = await runNode(BENCH, ["run", ...common, "--only", "rename-function", "--repeat", "4", "--concurrency", "4"], {
    env: { ...process.env, PATH: slowGit(t, { log, listing }), FAKE_AGENT: "solve" },
  });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(readdirSync(join(out, "runs")).filter((file) => file.endsWith(".json")).length, 8);

  // git removes the directory of a repository's worktrees with the last of them. An add
  // beside that remove finds the directory gone, so no two of these commands may overlap.
  const events = readFileSync(log, "utf-8").trim().split("\n").map((line) => line.split(" ")[0]);
  assert.equal(events.length, 2 * 2 * 8);
  assert.deepEqual([...new Set(events.map((event, index) => `${index % 2}${event}`))], ["0start", "1end"]);
  assert.equal(worktreesOf(repo), 1);

  // A record says how many sessions ran beside it, since its time depends on that. A resumed run may take another number.
  const concurrencyOf = (repetition) =>
    ["baseline", "lsp"].map((arm) => JSON.parse(readFileSync(join(out, "runs", `Fixture--rename-function--${arm}--${repetition}.json`), "utf-8")).concurrency);
  assert.deepEqual([1, 2, 3, 4].flatMap(concurrencyOf), Array(8).fill(4));
  const resumed = await runNode(BENCH, ["run", ...common, "--only", "rename-function", "--repeat", "5"], { env: { ...process.env, FAKE_AGENT: "solve" } });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual(concurrencyOf(5), [1, 1]);
});

test("a lock names its holder from the instant it exists", async (t) => {
  const { config } = await plannedFixture(t);
  const out = tempDir(t);
  const observer = join(tempDir(t), "observe.mjs");
  const observed = join(tempDir(t), "observed");
  // Run an observer immediately after either operation that can publish the lock. Buffer
  // writes use openSync even on Node versions whose string writes go straight to native code.
  writeFileSync(observer, `
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const lock = ${JSON.stringify(join(out, "lock"))};
const write = fs.writeFileSync;
const opened = fs.openSync;
const linked = fs.linkSync;
const observe = (path) => {
  if (path !== lock) return;
  assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid), "lock was visible without its holder");
  write(${JSON.stringify(observed)}, "observed");
};
fs.writeFileSync = (path, data, options) => write(path, typeof data === "string" ? Buffer.from(data) : data, options);
fs.openSync = (path, ...args) => {
  const fd = opened(path, ...args);
  if (String(args[0]).includes("w")) observe(path);
  return fd;
};
fs.linkSync = (source, destination) => {
  const result = linked(source, destination);
  observe(destination);
  return result;
};
syncBuiltinESMExports();
`);
  // Load the observer before the command, without exposing it to compiler subprocesses.
  const checked = await runNode("--import", [observer, BENCH, "plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(checked.code, 0, checked.stderr);
  assert.equal(readFileSync(observed, "utf8"), "observed");
  assert.equal(existsSync(join(out, "lock")), false);
  assert.deepEqual(readdirSync(out).filter((file) => file.endsWith(".holder")), []);
});

test("an output directory on a file system without hard links is refused, since it cannot hold the lock", async (t) => {
  const { config } = await plannedFixture(t);
  // The link that publishes the lock fails as such a file system makes it fail
  const unlinkable = join(tempDir(t), "unlinkable.mjs");
  writeFileSync(unlinkable, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.linkSync = () => {
  throw Object.assign(new Error("link refused"), { code: process.env.LINK_ERROR });
};
syncBuiltinESMExports();
`);
  for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) {
    const out = tempDir(t);
    const refused = await runNode("--import", [unlinkable, BENCH, "plan", "--config", config, "--out", out, "--min-files", "1"], {
      env: { ...process.env, LINK_ERROR: code },
    });
    assert.equal(refused.code, 1, code);
    assert.equal(refused.stderr, `The file system of ${out} takes no hard links, so it cannot hold the lock of the benchmark. Use another --out.\n`, code);
    assert.deepEqual(readdirSync(out), [], code);
  }
});

test("a lock that names no positive whole process id can be taken over", async (t) => {
  const { config } = await plannedFixture(t);
  for (const text of ["", "0", "-1", "someone", "1.5"]) {
    const out = tempDir(t);
    writeFileSync(join(out, "lock"), text);
    const ran = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
    assert.equal(ran.code, 0, `${JSON.stringify(text)}: ${ran.stderr}`);
    assert.equal(existsSync(join(out, "lock")), false);
    assert.equal(existsSync(join(out, "plan.json")), true);
  }
});

test("a lock that names the benchmark's own process id was left behind, and is taken over", async (t) => {
  const { config } = await plannedFixture(t);
  const out = tempDir(t);
  // In a container the benchmark gets the same process id each time. The shell writes its own id and makes way for the benchmark.
  const script = 'echo $$ > "$1/lock"; exec "$2" "$3" plan --config "$4" --out "$1" --min-files 1';
  const planning = spawn("sh", ["-c", script, "sh", out, process.execPath, BENCH, config], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  planning.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = await once(planning, "close");
  assert.equal(code, 0, stderr);
  assert.equal(existsSync(join(out, "plan.json")), true);
  assert.equal(existsSync(join(out, "lock")), false);
});

test("one benchmark at a time works in an output directory, and clears what an earlier one left there", async (t) => {
  const { repo, out, common, codebase } = await plannedFixture(t);
  const run = (mode, ...more) => runNode(BENCH, ["run", ...common, "--only", "rename-function", "--arms", "baseline", ...more], { env: { ...process.env, FAKE_AGENT: mode } });

  const first = spawn(process.execPath, [BENCH, "run", ...common, "--only", "rename-function", "--arms", "baseline"], {
    env: { ...process.env, FAKE_AGENT: "busy" },
    stdio: "ignore",
  });
  t.after(() => first.kill("SIGKILL"));
  for (let waited = 0; !existsSync(join(out, "lock")) && waited < 10000; waited += 20) {
    await sleep(20);
  }
  // A second one would take the checkout of the first for a leftover and remove it under its session
  const second = await run("solve");
  assert.equal(second.code, 1);
  assert.match(second.stderr, new RegExp(`^Another benchmark, process ${first.pid}, is working in .*\\. Wait for it, or use another --out\\.`));
  first.kill("SIGINT");
  assert.deepEqual(await once(first, "close"), [130, null]);
  assert.equal(existsSync(join(out, "lock")), false);

  // A benchmark that was killed outright leaves its lock, and the checkout of the session it was at
  writeFileSync(join(out, "lock"), "999999999");
  assert.equal((await run("solve")).code, 0);
  const slot = join(out, "work", "Fixture--rename-function--baseline--1");
  const left = await openCheckout(codebase, slot);
  assert.equal(worktreesOf(repo), 2);
  // That session has its record, so no run would open its slot again. The next run clears it all the same.
  const next = await run("solve");
  assert.match(next.stdout, /0 sessions to run/);
  assert.equal(existsSync(slot), false);
  assert.equal(existsSync(dirname(left.dir)), false);
  assert.equal(worktreesOf(repo), 1);

  // A slot is a file. One that names a directory which is no checkout of the benchmark's removes nothing.
  const own = join(tempDir(t), "own-worktree");
  git(repo, "worktree", "add", "--quiet", "--detach", own);
  writeFileSync(slot, JSON.stringify({ dir: own, label: "Fixture" }));
  await run("solve");
  assert.equal(existsSync(slot), false);
  assert.ok(existsSync(join(own, "elm.json")), "the operator's own worktree is still there");
});

test("Ctrl-C during the build before a session keeps the session from starting", async (t) => {
  const repo = gitRepository(copyFixture(t));
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);

  const running = spawn(process.execPath, [BENCH, "run", "--config", config, "--out", out, "--agent", FAKE_AGENT, "--arms", "baseline"], {
    env: { ...process.env, FAKE_AGENT: "solve", FAKE_COMPILER_DELAY_MS: "3000" },
    stdio: "ignore",
  });
  // The checkout of the first session is there, so its build is under way
  const work = join(out, "work");
  for (let waited = 0; !(existsSync(work) && readdirSync(work).length > 0) && waited < 10000; waited += 50) {
    await sleep(50);
  }
  const interrupted = Date.now();
  running.kill("SIGINT");
  const [code] = await once(running, "close");

  assert.equal(code, 130);
  assert.ok(Date.now() - interrupted < 2000, "the build was ended, not waited for");
  // No session began: nothing was written about one
  assert.deepEqual(existsSync(join(out, "runs")) ? readdirSync(join(out, "runs")) : [], []);
  assert.equal(worktreesOf(repo), 1);

  // The same during the build of a plan, which then writes none
  const again = join(tempDir(t), "out");
  const planning = spawn(process.execPath, [BENCH, "plan", "--config", config, "--out", again, "--min-files", "1"], {
    env: { ...process.env, FAKE_COMPILER_DELAY_MS: "3000" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let said = "";
  planning.stderr.on("data", (chunk) => (said += chunk));
  for (let waited = 0; !(existsSync(join(again, "work")) && readdirSync(join(again, "work")).length > 0) && waited < 10000; waited += 50) {
    await sleep(50);
  }
  planning.kill("SIGINT");
  assert.deepEqual(await once(planning, "close"), [130, null]);
  assert.equal(said, "Interrupted. Whatever was running has been ended. No plan was written.\n");
  assert.deepEqual(readdirSync(again), ["work"]);
  assert.deepEqual(readdirSync(join(again, "work")), []);
  assert.equal(worktreesOf(repo), 1);
});

for (const signal of ["SIGINT", "SIGHUP"]) {
  test(`${signal} while a result is judged leaves no record of it`, async (t) => {
    const repo = gitRepository(copyFixture(t));
    const out = join(tempDir(t), "out");
    const config = join(tempDir(t), "config.json");
    writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
    assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);

    // Every build takes a second and a half: the one before the session, and the one that judges it
    const running = spawn(
      process.execPath,
      [BENCH, "run", "--config", config, "--out", out, "--agent", FAKE_AGENT, "--arms", "baseline", "--only", "rename-function"],
      { env: { ...process.env, FAKE_AGENT: "solve", FAKE_COMPILER_DELAY_MS: "1500" }, stdio: "ignore" }
    );
    // The session is over once its transcript holds the result. The build that judges it follows.
    const transcript = join(out, "runs", "Fixture--rename-function--baseline--1.jsonl");
    const sessionOver = () => existsSync(transcript) && readFileSync(transcript, "utf-8").includes('"type":"result"');
    for (let waited = 0; !sessionOver() && waited < 15000; waited += 50) {
      await sleep(50);
    }
    assert.ok(sessionOver(), "the session never finished");
    await sleep(300);
    running.kill(signal);
    const [code] = await once(running, "close");

    assert.equal(code, 130);
    // A build that was cut short is no failed build: the session solved its task and is not on record as anything
    assert.deepEqual(readdirSync(join(out, "runs")), []);
    assert.equal(worktreesOf(repo), 1);
  });
}

test("run stops before its first session when it cannot list the machine's processes", async (t) => {
  const repo = gitRepository(copyFixture(t));
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);

  // A PATH that has git, and no ps
  const bin = tempDir(t);
  symlinkSync(execFileSync("which", ["git"]).toString().trim(), join(bin, "git"));
  const blind = await runNode(BENCH, ["run", "--config", config, "--out", out, "--agent", FAKE_AGENT], {
    env: { ...process.env, PATH: bin, FAKE_AGENT: "solve" },
  });

  assert.equal(blind.code, 1);
  assert.match(blind.stderr, /^Cannot list the processes of this machine with "ps": .*Without that, what a session starts could outlive it\.$/m);
  assert.deepEqual(readdirSync(join(out, "runs")), []);
  assert.equal(worktreesOf(repo), 1);
});

test("a session that waits for the model until its time is up is no result of its arm", async (t) => {
  const repo = gitRepository(copyFixture(t));
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);

  // The first stand-in gets no answer and waits. A little over a second in, the benchmark tells it to stop.
  // The second works one turn before that, and asks again for the answer to its next request.
  const waits = [
    ["stalled", /--1: the session ended before the model answered once \(error_during_execution\)\. Nothing was recorded for it\./],
    ["stalled-later", /--1: the session was still waiting for the API when its time was up \(error_during_execution\)\. Nothing was recorded for it\./],
  ];
  for (const [mode, message] of waits) {
    const stalled = await runNode(BENCH, ["run", "--config", config, "--out", out, "--agent", FAKE_AGENT, "--arms", "baseline", "--timeout-min", "0.02"], {
      env: { ...process.env, FAKE_AGENT: mode },
    });
    assert.equal(stalled.code, 1);
    assert.match(stalled.stderr, message);
    assert.deepEqual(readdirSync(join(out, "runs")), []);
    assert.equal(worktreesOf(repo), 1);
  }
});

test("a run is held to the version of Claude Code that its first session reported", async (t) => {
  const repo = gitRepository(copyFixture(t));
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);
  const run = (versions, ...more) =>
    runNode(BENCH, ["run", "--config", config, "--out", out, "--agent", FAKE_AGENT, "--only", "rename-function", "--arms", "baseline", ...more], {
      env: { ...process.env, FAKE_AGENT: "solve", ...versions },
    });
  const records = () => readdirSync(join(out, "runs")).filter((file) => file.endsWith(".json"));

  // Claude Code updated itself while a run was under way: the session of the task reports another version than the first one
  const updated = await run({ FAKE_AGENT_VERSION: "2.1.311", FAKE_AGENT_VERSION_LATER: "3.0.0" });
  assert.equal(updated.code, 1);
  assert.match(updated.stderr, /the session was not set up as its arm requires: it ran in Claude Code 3\.0\.0, and this run began with Claude Code 2\.1\.311/);
  assert.deepEqual(records(), []);

  const first = await run({ FAKE_AGENT_VERSION: "2.1.311" });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(readFileSync(join(out, "run.json"), "utf-8")).agent, "Claude Code 2.1.311");
  // It updated itself between two runs into one directory
  const later = await run({ FAKE_AGENT_VERSION: "3.0.0" }, "--repeat", "2");
  assert.equal(later.code, 1);
  assert.match(later.stderr, /runs holds records of sessions that ran differently: the agent was Claude Code 2\.1\.311 and is now Claude Code 3\.0\.0\. Run as before, or use another --out\./);
  // A stand-in that names no version is another agent as well
  const standIn = await run({}, "--repeat", "2");
  assert.equal(standIn.code, 1);
  assert.match(standIn.stderr, /the agent was Claude Code 2\.1\.311 and is now an agent that names no version/);
  assert.equal(records().length, 1);
  // The version of the first sessions goes on
  assert.equal((await run({ FAKE_AGENT_VERSION: "2.1.311" }, "--repeat", "2")).code, 0);
  assert.equal(records().length, 2);
});

test("a run is held to the effort it was started with, and the report names it", async (t) => {
  const { out, common } = await plannedFixture(t);
  const notes = join(tempDir(t), "started.jsonl");
  const run = (...more) =>
    runNode(BENCH, ["run", ...common, "--only", "rename-function", "--arms", "baseline", ...more], {
      env: { ...process.env, FAKE_AGENT: "solve", FAKE_AGENT_STARTED: notes, CLAUDE_CODE_EFFORT_LEVEL: "max", MAX_THINKING_TOKENS: "32000" },
    });
  const records = () => readdirSync(join(out, "runs")).filter((file) => file.endsWith(".json"));

  const first = await run("--effort", "high");
  assert.equal(first.code, 0, first.stderr);
  // The isolation check and the session of the task, each at the effort of the run and with no budget for thinking of the shell's
  const started = readFileSync(notes, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(started.length, 2);
  for (const { args, variables, effortLevel } of started) {
    assert.deepEqual([args[args.indexOf("--effort") + 1], effortLevel, variables.includes("MAX_THINKING_TOKENS")], ["high", "high", false]);
  }
  assert.equal(JSON.parse(readFileSync(join(out, "runs", "Fixture--rename-function--baseline--1.json"), "utf-8")).effort, "high");
  assert.equal(JSON.parse(readFileSync(join(out, "run.json"), "utf-8")).effort, "high");

  const unset = await run("--repeat", "2");
  assert.equal(unset.code, 1);
  assert.match(unset.stderr, /runs holds records of sessions that ran differently: --effort was high and is now Claude Code's default\. Run as before, or use another --out\./);
  const other = await run("--repeat", "2", "--effort", "low");
  assert.equal(other.code, 1);
  assert.match(other.stderr, /--effort was high and is now low\./);
  assert.equal(records().length, 1);
  assert.equal((await run("--repeat", "2", "--effort", "high")).code, 0);
  assert.equal(records().length, 2);
  assert.equal((await runNode(BENCH, ["report", "--out", out])).code, 0);
  assert.match(readFileSync(join(out, "report.html"), "utf-8"), /claude-opus-5-5 at effort high worked on/);

  // A run that named none is held to none: its sessions ran at the default of Claude Code for the model
  const fresh = await plannedFixture(t);
  rmSync(notes);
  const byDefault = await runNode(BENCH, ["run", ...fresh.common, "--only", "rename-function", "--arms", "baseline"], {
    env: { ...process.env, FAKE_AGENT: "solve", FAKE_AGENT_STARTED: notes, CLAUDE_CODE_EFFORT_LEVEL: "max" },
  });
  assert.equal(byDefault.code, 0, byDefault.stderr);
  for (const { args, effortLevel } of readFileSync(notes, "utf-8").trim().split("\n").map((line) => JSON.parse(line))) {
    assert.deepEqual([args.includes("--effort"), effortLevel], [false, null]);
  }
  assert.equal(JSON.parse(readFileSync(join(fresh.out, "runs", "Fixture--rename-function--baseline--1.json"), "utf-8")).effort, null);
  const named = await runNode(BENCH, ["run", ...fresh.common, "--only", "rename-function", "--arms", "baseline", "--repeat", "2", "--effort", "high"], {
    env: { ...process.env, FAKE_AGENT: "solve" },
  });
  assert.equal(named.code, 1);
  assert.match(named.stderr, /--effort was Claude Code's default and is now high\./);
  assert.equal((await runNode(BENCH, ["report", "--out", fresh.out])).code, 0);
  assert.match(readFileSync(join(fresh.out, "report.html"), "utf-8"), /claude-opus-5-5 at Claude Code&#39;s default effort worked on/);
});

test("run --only with a text that matches no task of the plan names the plan's tasks", async (t) => {
  const { out, common } = await plannedFixture(t);
  const run = (only) => runNode(BENCH, ["run", ...common, "--only", only, "--arms", "baseline"], { env: { ...process.env, FAKE_AGENT: "solve" } });
  const typo = await run("rename-fuction");
  assert.equal(typo.code, 1);
  const { tasks } = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8"));
  assert.equal(typo.stderr.trim(), `No task of the plan has "rename-fuction" in its id. The plan's tasks are: ${tasks.map((task) => task.id).join(", ")}`);
  assert.deepEqual(readdirSync(join(out, "runs")), []);
  // Where every matching session has its record, there is nothing left to do
  assert.equal((await run("rename-function")).code, 0);
  const again = await run("rename-function");
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /^0 sessions to run with claude-opus-5-5$/m);
});

test("a session that wrecks its project or comes up wrongly equipped is accounted for", async (t) => {
  const repo = gitRepository(copyFixture(t));
  const out = join(tempDir(t), "out");
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo, check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
  const bench = (args, mode) => runNode(BENCH, [...args, "--out", out], { env: { ...process.env, FAKE_AGENT: mode } });
  const run = (only, mode, ...more) => bench(["run", "--config", config, "--only", only, "--agent", FAKE_AGENT, ...more], mode);
  const recordOf = (id) => JSON.parse(readFileSync(join(out, "runs", `${id}.json`), "utf-8"));
  assert.equal((await bench(["plan", "--config", config, "--min-files", "1"])).code, 0);

  // With elm.json gone the project cannot be read, and that is still a result
  const wrecked = await run("rename-module", "wreck", "--arms", "baseline");
  assert.equal(wrecked.code, 0, wrecked.stderr);
  // So far one arm was asked for, and the report is of that arm alone
  assert.equal((await bench(["report"])).code, 0);
  const oneArm = /1 session in total\..* Only one arm was run, so this page compares nothing\./;
  assert.match(readFileSync(join(out, "report.html"), "utf-8"), oneArm);
  // A run of both arms that stops before its first session leaves the report waiting for nothing
  assert.equal((await run("rename-module", "leaky")).code, 1);
  assert.equal((await bench(["report"])).code, 0);
  assert.match(readFileSync(join(out, "report.html"), "utf-8"), oneArm);
  // The stand-in compiler reads no elm.json, so the build passed. What is known of a result is
  // kept when the rest cannot be judged.
  const judged = recordOf("Fixture--rename-module--baseline--1");
  assert.equal(judged.outcome, "wrong-result");
  assert.match(judged.problems[0], /^the result could not be judged: /);
  assert.equal(worktreesOf(repo), 1);

  // Without its .git a checkout cannot be read at all, and the check never runs. That is counted with what
  // does not compile. The record says why in one line, where git goes on with how it is to be used.
  assert.match((await run("rename-module", "unreadable", "--arms", "lsp")).stdout, /Fixture\/rename-module  lsp  #1  does-not-compile/);
  assert.match(recordOf("Fixture--rename-module--lsp--1").problems[0], /^the result could not be judged: git diff [^\n]+: [^\n]*Not a git repository[^\n]*$/);
  assert.equal(worktreesOf(repo), 1);

  // The language server not starting is the lsp arm's failure, whatever the agent then did by hand
  assert.match((await run("rename-function", "serverless")).stdout, /lsp  #1  server-failed/);
  assert.equal(recordOf("Fixture--rename-function--baseline--1").outcome, "wrong-result");

  // A tool that neither arm should have stops the run before it measures the wrong thing: at the
  // isolation check, which asks for no tool at all, or at the first session that shows one
  const overequipped = await run("rename-function", "overequipped", "--repeat", "2");
  assert.equal(overequipped.code, 1);
  assert.match(overequipped.stderr, /^Sessions are not isolated from this machine's Claude Code setup\. A test session loaded: tools, though it was given none \(WebSearch\)\./);
  const later = await run("rename-function", "equipped-later", "--repeat", "2");
  assert.equal(later.code, 1);
  assert.match(later.stderr, /the session was not set up as its arm requires: it had tools that its arm is not given: WebSearch/);
  // Such a session is ended at its first event. This stand-in would otherwise work for the twenty minutes a session has.
  const busy = await run("rename-function", "equipped-busy", "--repeat", "2");
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /the session was not set up as its arm requires: it had tools that its arm is not given: WebSearch/);
  // A plugin that is not built into Claude Code comes from the machine's setup, at the isolation check or later
  const plugged = await run("rename-function", "plugged", "--repeat", "2");
  assert.equal(plugged.code, 1);
  assert.match(plugged.stderr, /^Sessions are not isolated from this machine's Claude Code setup\. A test session loaded: plugins \(someones-plugin\)\./);
  const pluggedLater = await run("rename-function", "plugged-later", "--repeat", "2");
  assert.equal(pluggedLater.code, 1);
  assert.match(pluggedLater.stderr, /the session was not set up as its arm requires: it loaded plugins of this machine's setup: someones-plugin/);
  // The language server's tools are tools as well, for a session that was given none
  const served = await run("rename-function", "served", "--repeat", "2");
  assert.equal(served.code, 1);
  assert.match(served.stderr, /^Sessions are not isolated from this machine's Claude Code setup\. A test session loaded: tools, though it was given none \(mcp__elm-lsp__elm_symbols\), MCP servers/);
  // A server of the machine's setup that is still starting has no tools to show yet, in either arm
  for (const arm of ["baseline", "lsp"]) {
    const foreign = await run("rename-function", "foreign-later", "--repeat", "2", "--arms", arm);
    assert.equal(foreign.code, 1);
    assert.match(foreign.stderr, /the session was not set up as its arm requires: it had MCP servers that its arm is not given: someones-server/);
  }
  assert.deepEqual(readdirSync(join(out, "runs")).filter((file) => file.includes("--2.")), []);

  // A request that the API turns down as too long is the session's own doing, and a result of its arm
  const overlong = await run("rename-function", "overlong", "--repeat", "2", "--arms", "baseline");
  assert.equal(overlong.code, 0, overlong.stderr);
  const { outcome, failure, apiErrorStatus, apiRetries } = recordOf("Fixture--rename-function--baseline--2");
  assert.deepEqual({ outcome, failure, apiErrorStatus, apiRetries }, { outcome: "agent-failed", failure: "error", apiErrorStatus: 400, apiRetries: 1 });
  // The API answers with the same status once a spending limit is reached. That is a lost API, and so
  // is a connection that broke and left no word behind.
  const third = () => readdirSync(join(out, "runs")).filter((file) => file.includes("--3."));
  const capped = await run("rename-function", "capped", "--repeat", "3", "--arms", "baseline");
  assert.equal(capped.code, 1);
  assert.match(capped.stderr, /--baseline--3: the session lost the API in the middle of its work \(API Error: 400 · the stand-in has reached its specified usage limits\)\. Nothing was recorded for it\./);
  const dropped = await run("rename-function", "dropped", "--repeat", "3", "--arms", "baseline");
  assert.equal(dropped.code, 1);
  assert.match(dropped.stderr, /--baseline--3: the session lost the API in the middle of its work \(no answer from the API\)\. Nothing was recorded for it\./);
  assert.deepEqual(third(), []);
  // Claude Code has more than one way to say that a request holds too much
  t.after(() => delete process.env.FAKE_TOO_LONG);
  const wordings = ["input is too long for requested model", "input length and `max_tokens` exceed context limit: 199000 + 8192 > 200000"];
  for (const [at, wording] of wordings.entries()) {
    process.env.FAKE_TOO_LONG = wording;
    const round = String(3 + at);
    const again = await run("rename-function", "overlong", "--repeat", round, "--arms", "baseline");
    assert.equal(again.code, 0, again.stderr);
    assert.equal(recordOf(`Fixture--rename-function--baseline--${round}`).outcome, "agent-failed");
  }
  delete process.env.FAKE_TOO_LONG;
  // A 413 says that the request held too much, whatever words come with it. Its session is recorded, and the next one runs.
  const oversized = await run("rename-function", "oversized", "--repeat", "6", "--arms", "baseline");
  assert.equal(oversized.code, 0, oversized.stderr);
  for (const round of ["5", "6"]) {
    const { outcome, failure, apiErrorStatus } = recordOf(`Fixture--rename-function--baseline--${round}`);
    assert.deepEqual({ outcome, failure, apiErrorStatus }, { outcome: "agent-failed", failure: "error", apiErrorStatus: 413 });
  }

  // A language server that was still starting may or may not have given the session its tools
  const starting = await run("rename-function", "starting", "--repeat", "2", "--arms", "lsp");
  assert.equal(starting.code, 1);
  assert.match(starting.stderr, /the session was not set up as its arm requires: its language server was "pending" when it began/);
  // One that is connected and hands over no tool leaves the arm the baseline under another name
  const toolless = await run("rename-function", "toolless", "--repeat", "2", "--arms", "lsp");
  assert.equal(toolless.code, 1);
  assert.match(toolless.stderr, /the session was not set up as its arm requires: its language server was connected and handed it no tool/);

  assert.equal((await bench(["report"])).code, 0);
  assert.match(readFileSync(join(out, "report.html"), "utf-8"), /<td>Server did not start<\/td>/);

  // A record is written whole or not at all. One that something else cut short is named.
  assert.deepEqual(readdirSync(join(out, "runs")).filter((file) => file.endsWith(".part")), []);
  const record = join(out, "runs", "Fixture--rename-function--baseline--1.json");
  writeFileSync(record, readFileSync(record, "utf-8").slice(0, 200));
  const cut = await bench(["report"]);
  assert.equal(cut.code, 1);
  assert.ok(cut.stderr.startsWith(`${record} cannot be read: `), cut.stderr);
});

// An agent stand-in for one test. It answers the isolation check, and for a
// task it runs `edit`, the source of a function body, in the session's directory.
function standInAgent(t, edit) {
  const path = join(tempDir(t), "agent.js");
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
const prompt = args[args.indexOf("--print") + 1];
const emit = (event) => console.log(JSON.stringify(event));
emit({ type: "system", subtype: "init", tools: args[args.indexOf("--tools") + 1].split(",").filter(Boolean), mcp_servers: [] });
if (!prompt.includes("SENTINEL")) {
  ${edit}
}
emit({ type: "result", subtype: "success", is_error: false, result: "NONE", total_cost_usd: 0.1, num_turns: 2, usage: {} });
`
  );
  chmodSync(path, 0o755);
  return path;
}

const hasElm = () => {
  try {
    return execFileSync("elm", ["--version"]).toString().trim() === "0.19.1";
  } catch {
    return false;
  }
};

test("with the real compiler, added branches in a subdirectory keep strings unchanged", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  const repo = tempDir(t);
  const elmRoot = join(repo, "client");
  mkdirSync(join(elmRoot, "src"), { recursive: true });
  cpSync(join(REPO, "tests/fixture/elm.json"), join(elmRoot, "elm.json"));
  writeFileSync(join(elmRoot, "src/Main.elm"), SHAPE_EXAMPLE);
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Shapes", repo, elmRoot: "client", check: ["elm", "make", "src/Main.elm", "--output=/dev/null"] }] }));
  for (const [mode, { taken }] of Object.entries(SHAPE_EDITS)) {
    const out = join(tempDir(t), "out");
    const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
    assert.equal(planned.code, 0, planned.stderr);
    const agent = standInAgent(t, `fs.writeFileSync("src/Main.elm", ${JSON.stringify(addShapeBranch(SHAPE_EXAMPLE, mode))});`);
    const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "add-variant", "--arms", "baseline", "--agent", agent]);
    assert.equal(ran.code, 0, ran.stderr);
    const record = JSON.parse(readFileSync(join(out, "runs/Shapes--add-variant--baseline--1.json"), "utf8"));
    if (taken) {
      assert.equal(record.outcome, "passed", mode);
      assert.deepEqual(record.problems, []);
    } else {
      assert.equal(record.outcome, "wrong-result", mode);
      assert.match(record.problems.join("\n"), /changed more than the variant and its branches/, mode);
    }
  }
});

test("with the real compiler, a declaration whose name stands on a line below its first word compiles", (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  const repo = tempDir(t);
  mkdirSync(join(repo, "src"));
  cpSync(join(REPO, "tests/fixture/elm.json"), join(repo, "elm.json"));
  writeFileSync(join(repo, "src/Layout.elm"), SPREAD);
  // What the scan reads of this text is in the test of a declaration's layout
  execFileSync("elm", ["make", "src/Layout.elm", "--output=/dev/null"], { cwd: repo, stdio: "pipe" });
});

test("with the real compiler, a catch-all that only carries the variant's name is told from a branch for it", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  // One case expression that needs a branch for a new variant, and one that has a catch-all already
  const repo = tempDir(t);
  mkdirSync(join(repo, "src"));
  cpSync(join(REPO, "tests/fixture/elm.json"), join(repo, "elm.json"));
  writeFileSync(join(repo, "src/Shape.elm"), "module Shape exposing (Shape(..))\n\n\ntype Shape\n    = Circle\n    | Square\n    | Triangle\n");
  writeFileSync(
    join(repo, "src/Main.elm"),
    [
      "module Main exposing (name, round)",
      "",
      "import Shape exposing (Shape(..))",
      "",
      "",
      "name : Shape -> String",
      "name shape =",
      "    case shape of",
      "        Circle ->",
      '            "circle"',
      "",
      "        Square ->",
      '            "square"',
      "",
      "        Triangle ->",
      '            "triangle"',
      "",
      "",
      "round : Shape -> Bool",
      "round shape =",
      "    case shape of",
      "        Circle ->",
      "            True",
      "",
      "        _ ->",
      "            False",
      "",
    ].join("\n")
  );
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Shapes", repo, check: ["elm", "make", "src/Main.elm", "--output=/dev/null"] }] }));

  // Each agent adds the variant. They differ in the pattern of the branch they add to `name`, and in how its body is laid out.
  const agentAdding = (pattern, body = 'Debug.todo "AddedByBenchmark"') =>
    standInAgent(
      t,
      `fs.appendFileSync("src/Shape.elm", "    | AddedByBenchmark\\n");
  const main = fs.readFileSync("src/Main.elm", "utf8");
  const branch = '\\n        ${pattern} ->\\n            ${body}\\n';
  fs.writeFileSync("src/Main.elm", main.replace('            "triangle"\\n', '            "triangle"\\n' + branch));`
    );
  const outcomeWith = async (agent) => {
    const out = join(tempDir(t), "out");
    const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
    assert.equal(planned.code, 0, planned.stderr);
    const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "add-variant", "--arms", "baseline", "--agent", agent]);
    assert.equal(ran.code, 0, ran.stderr);
    const { outcome, problems } = JSON.parse(readFileSync(join(out, "runs", "Shapes--add-variant--baseline--1.json"), "utf-8"));
    return { outcome, problems };
  };

  assert.deepEqual(await outcomeWith(agentAdding("AddedByBenchmark")), { outcome: "passed", problems: [] });
  // The same branch with its pattern in brackets that close on the next line
  assert.deepEqual(await outcomeWith(agentAdding("( AddedByBenchmark\\n            )")), { outcome: "passed", problems: [] });
  // The message on a line of its own, which elm-format leaves there, in brackets, and in three quotes over two lines
  for (const body of ['Debug.todo\\n                "AddedByBenchmark"', 'Debug.todo ("AddedByBenchmark")', '(Debug.todo) """Added\\nByBenchmark"""']) {
    assert.deepEqual(await outcomeWith(agentAdding("AddedByBenchmark", body)), { outcome: "passed", problems: [] });
  }
  // The compiler takes this just as well, and it is no branch for the variant
  assert.deepEqual(await outcomeWith(agentAdding("_ {- AddedByBenchmark -}")), {
    outcome: "wrong-result",
    problems: ['changed more than the variant and its branches: +_ {- AddedByBenchmark -} -> / +Debug.todo "AddedByBenchmark"'],
  });
});

test("with the real compiler, the plan adds its variant to the declared type and not to an example above it", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  // The type stands in a string and in a comment above its declaration, at the start of a line as in the code
  const example = ["type Shape", "    = Circle", "    | Square", "    | Triangle"];
  const repo = tempDir(t);
  mkdirSync(join(repo, "src"));
  cpSync(join(REPO, "tests/fixture/elm.json"), join(repo, "elm.json"));
  writeFileSync(
    join(repo, "src/Main.elm"),
    [
      "module Main exposing (Shape(..), example, name)",
      "",
      "",
      "example : String",
      "example =",
      '    """',
      ...example,
      '"""',
      "",
      "",
      "{-",
      ...example,
      "-}",
      ...example,
      "",
      "",
      "name : Shape -> String",
      "name shape =",
      "    case shape of",
      "        Circle ->",
      '            "circle"',
      "",
      "        Square ->",
      '            "square"',
      "",
      "        Triangle ->",
      '            "triangle"',
      "",
    ].join("\n")
  );
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Shapes", repo, check: ["elm", "make", "src/Main.elm", "--output=/dev/null"] }] }));
  const out = join(tempDir(t), "out");
  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  const task = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).tasks.find((task) => task.type === "add-variant");
  assert.match(task?.prompt ?? planned.stdout, /as the last variant of the custom type `Shape` in `src\/Main\.elm`/);
});

test("with the real compiler, a variant whose argument stands below a blank line keeps it in the plan's trial build", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  // Every case ends in a catch-all, so the variant breaks nothing once it goes in below the argument
  const repo = tempDir(t);
  mkdirSync(join(repo, "src"));
  cpSync(join(REPO, "tests/fixture/elm.json"), join(repo, "elm.json"));
  writeFileSync(
    join(repo, "src/Main.elm"),
    [
      "module Main exposing (Shape(..), name)",
      "",
      "",
      "type Shape",
      "    = Circle",
      "    | Square",
      "    | Triangle",
      "",
      "        String",
      "",
      "",
      "name : Shape -> String",
      "name shape =",
      "    case shape of",
      "        Triangle label ->",
      "            label",
      "",
      "        _ ->",
      '            "other"',
      "",
    ].join("\n")
  );
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Shapes", repo, check: ["elm", "make", "src/Main.elm", "--output=/dev/null"] }] }));
  const out = join(tempDir(t), "out");
  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).tasks.filter((task) => task.type === "add-variant"), []);
  assert.match(planned.stdout, /Shapes: no suitable target for add-variant\. The project still compiled with the change made to the one target that was tried/);
});

// The outcome of the add-variant task in a project of one module, src/Main.elm, which the session
// turns from `before` into `after`
async function addVariantOutcome(t, before, after) {
  const repo = tempDir(t);
  mkdirSync(join(repo, "src"));
  cpSync(join(REPO, "tests/fixture/elm.json"), join(repo, "elm.json"));
  writeFileSync(join(repo, "src/Main.elm"), before);
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Shapes", repo, check: ["elm", "make", "src/Main.elm", "--output=/dev/null"] }] }));
  const out = join(tempDir(t), "out");
  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  const agent = standInAgent(t, `fs.writeFileSync("src/Main.elm", ${JSON.stringify(after)});`);
  const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "add-variant", "--arms", "baseline", "--agent", agent]);
  assert.equal(ran.code, 0, ran.stderr);
  const { outcome, problems } = JSON.parse(readFileSync(join(out, "runs", "Shapes--add-variant--baseline--1.json"), "utf-8"));
  return { outcome, problems };
}

// A module with the type Shape, written with `bar` in front of each variant after the first, and `name` below it
const shapeModule = (name, bar = "| ") =>
  ["module Main exposing (Shape(..), name)", "", "", "type Shape", "    = Circle", `    ${bar}Square`, `    ${bar}Triangle`, "", "", "name : Shape -> String", "name shape =", ...name].join("\n");

test("with the real compiler, a variant added in the style of its type without a space behind the bar passes", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  const name = ["    case shape of", "        Circle ->", '            "circle"', "", "        Square ->", '            "square"', "", "        Triangle ->", '            "triangle"', ""];
  const added = [...name, "        AddedByBenchmark ->", '            Debug.todo "AddedByBenchmark"', ""];
  const before = shapeModule(name, "|");
  const after = shapeModule(added, "|").replace("    |Triangle\n", "    |Triangle\n    |AddedByBenchmark\n");
  assert.deepEqual(await addVariantOutcome(t, before, after), { outcome: "passed", problems: [] });
});

test("with the real compiler, a branch that takes over the lines below it is told from one that ends where it should", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  const branch = ["        AddedByBenchmark ->", '            Debug.todo "later"'];
  const withVariant = (text) => text.replace("    | Triangle\n", "    | Triangle\n    | AddedByBenchmark\n");
  const outcome = (name, added) => addVariantOutcome(t, shapeModule(name), withVariant(shapeModule(added)));
  const passed = { outcome: "passed", problems: [] };

  // Put between "boxy" and the String.trim below it, the branch takes that line over, and Square loses it
  const trimmed = ["    case shape of", "        Circle ->", '            "circle"', "", "        Square ->", '            "boxy"', "                |> String.trim", "", "        Triangle ->", '            "triangle"', ""];
  assert.deepEqual(await outcome(trimmed, [...trimmed.slice(0, 6), "", ...branch, ...trimmed.slice(6)]), {
    outcome: "wrong-result",
    problems: ["a branch for AddedByBenchmark takes over the line below it, which is indented deeper than the branch's pattern"],
  });
  // How deep a pattern is indented is read where it begins, also where its arrow stands on a line further in
  const unaligned = trimmed.map((line) => line.replace(/^ +\|>/, "            |>"));
  const brackets = ["        ( AddedByBenchmark", "            ) ->", branch[1]];
  assert.deepEqual(await outcome(unaligned, [...unaligned.slice(0, 6), "", ...brackets, ...unaligned.slice(6)]), {
    outcome: "wrong-result",
    problems: ["a branch for AddedByBenchmark takes over the line below it, which is indented deeper than the branch's pattern"],
  });

  // A branch above another one, or above the end of its case, ends where it should
  const later = ["    case shape of", "        Circle ->", '            "circle"', "", "        Square ->", '            Debug.todo "later"', "", "        Triangle ->", '            Debug.todo "later"', ""];
  // Below its neighbour, with the same body, and above one with the same body
  assert.deepEqual(await outcome(later, [...later.slice(0, 7), ...branch, "", ...later.slice(7)]), passed);
  // Put first
  assert.deepEqual(await outcome(later, [later[0], ...branch, "", ...later.slice(1)]), passed);
  // Last in a file without a final line break
  const named = [...trimmed.slice(0, 6), ...trimmed.slice(7, -1)];
  assert.deepEqual(await outcome(named, [...named, "", ...branch]), passed);
  // In brackets that close below the case, and in a let that "in" follows
  const bracketed = ["    (case shape of", ...later.slice(1), "    )", "        |> String.trim", ""];
  assert.deepEqual(await outcome(bracketed, [...bracketed.slice(0, 10), ...branch, ...bracketed.slice(10)]), passed);
  const bound = ["    let", "        label =", ...later.slice(0, -1).map((line) => (line === "" ? "" : `        ${line}`)), "    in", "    label", ""];
  assert.deepEqual(await outcome(bound, [...bound.slice(0, 11), "", ...branch.map((line) => `        ${line}`), ...bound.slice(11)]), passed);
});

test("with the real compiler, a line below a branch is read where its literal begins, and a closing bracket or a comma ends the case", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  const branch = (indent) => [`${indent}AddedByBenchmark ->`, `${indent}    Debug.todo "later"`];
  const withVariant = (text) => text.replace("    | Triangle\n", "    | Triangle\n    | AddedByBenchmark\n");
  const outcome = (name, added) => addVariantOutcome(t, shapeModule(name), withVariant(shapeModule(added)));

  // Put between Debug.todo "round" and the string below it, the branch takes that string over as an argument
  const handedOn = ["    case shape of", "        Circle ->", '            "circle"', "", "        Square ->", '            Debug.todo "round"', '                "left behind"', "", "        Triangle ->", '            "triangle"', ""];
  assert.deepEqual(await outcome(handedOn, [...handedOn.slice(0, 6), "", ...branch("        "), ...handedOn.slice(6)]), {
    outcome: "wrong-result",
    problems: ["a branch for AddedByBenchmark takes over the line below it, which is indented deeper than the branch's pattern"],
  });

  // A bracket around the case that closes deeper than its patterns, and a comma of a tuple around it, end the case
  const closed = ["    (case shape of", "        Circle ->", '            "circle"', "", "        Square ->", '            "square"', "", "        Triangle ->", '            "triangle"', "            )", "        |> String.trim", ""];
  assert.deepEqual(await outcome(closed, [...closed.slice(0, 9), "", ...branch("        "), ...closed.slice(9)]), { outcome: "passed", problems: [] });
  const paired = ["    Tuple.first", "        ( case shape of", "            Circle ->", '                "circle"', "", "            Square ->", '                "square"', "", "            Triangle ->", '                "triangle"', "                , 1", "        )", ""];
  assert.deepEqual(await outcome(paired, [...paired.slice(0, 10), "", ...branch("            "), ...paired.slice(10)]), { outcome: "passed", problems: [] });
  // So do the brackets of a list and of a record
  const listed = ["    String.concat", ...paired.slice(1, 10).map((line) => line.replace("( case", "[ case")), "                ]", ""];
  assert.deepEqual(await outcome(listed, [...listed.slice(0, 10), "", ...branch("            "), ...listed.slice(10)]), { outcome: "passed", problems: [] });
  const recorded = ["    .label", "        { label =", ...paired.slice(1, 10).map((line) => (line === "" ? "" : `    ${line.replace("( case", "case")}`)), "                    }", ""];
  assert.deepEqual(await outcome(recorded, [...recorded.slice(0, 11), "", ...branch("                "), ...recorded.slice(11)]), { outcome: "passed", problems: [] });
});

test("with the real compiler, a rename that also rewrote a string is told from one that did not", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  // A function that returns its own name
  const repo = tempDir(t);
  mkdirSync(join(repo, "src"));
  cpSync(join(REPO, "tests/fixture/elm.json"), join(repo, "elm.json"));
  writeFileSync(join(repo, "src/Lib.elm"), 'module Lib exposing (convertValue)\n\n\nconvertValue : String\nconvertValue =\n    "convertValue"\n');
  writeFileSync(join(repo, "src/Main.elm"), "module Main exposing (shown)\n\nimport Lib\n\n\nshown : String\nshown =\n    Lib.convertValue\n");
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Lib", repo, check: ["elm", "make", "src/Main.elm", "--output=/dev/null"] }] }));

  // Both agents rename the function everywhere. One of them does it to every piece of text that reads like the name.
  const agentReplacing = (pattern) =>
    standInAgent(
      t,
      `for (const file of ["src/Lib.elm", "src/Main.elm"]) {
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(${pattern}, "convertValueRenamed"));
  }`
    );
  const outcomeWith = async (agent) => {
    const out = join(tempDir(t), "out");
    const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
    assert.equal(planned.code, 0, planned.stderr);
    const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "rename-function", "--arms", "baseline", "--agent", agent]);
    assert.equal(ran.code, 0, ran.stderr);
    const { outcome, problems } = JSON.parse(readFileSync(join(out, "runs", "Lib--rename-function--baseline--1.json"), "utf-8"));
    return { outcome, problems };
  };

  assert.deepEqual(await outcomeWith(agentReplacing('/(?<!")\\bconvertValue\\b/g')), { outcome: "passed", problems: [] });
  // The project compiles either way, and what it shows on the page is no longer the same
  assert.deepEqual(await outcomeWith(agentReplacing("/\\bconvertValue\\b/g")), {
    outcome: "wrong-result",
    problems: ['src/Lib.elm changed in more than the name: "convertValue" became "convertValueRenamed"'],
  });
});

test("with the real compiler, a module, a variant and a function named in letters outside ASCII are renamed whole", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  const repo = tempDir(t);
  mkdirSync(join(repo, "src"));
  cpSync(join(REPO, "tests/fixture/elm.json"), join(repo, "elm.json"));
  writeFileSync(
    join(repo, "src/Café.elm"),
    [
      "module Café exposing (État(..), libellé)",
      "",
      "",
      "type État",
      "    = Ouverte",
      "    | Fermée",
      "    | Complète",
      "",
      "",
      "libellé : État -> String",
      "libellé état =",
      "    case état of",
      "        Ouverte ->",
      '            "ouverte"',
      "",
      "        Fermée ->",
      '            "fermée"',
      "",
      "        Complète ->",
      '            "complète"',
      "",
    ].join("\n")
  );
  writeFileSync(join(repo, "src/Main.elm"), "module Main exposing (shown)\n\nimport Café exposing (État(..))\n\n\nshown : String\nshown =\n    Café.libellé Fermée\n");
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Bistro", repo, check: ["elm", "make", "src/Main.elm", "--output=/dev/null"] }] }));
  const out = join(tempDir(t), "out");
  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  const prompts = Object.fromEntries(JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).tasks.map((task) => [task.type, task.prompt.split(",")[0]]));
  assert.deepEqual(prompts, {
    "rename-function": "Rename the function `libellé` of the module `Café` (`src/Café.elm`) to `libelléRenamed`",
    "rename-variant": "Rename the variant `Fermée` of the custom type `État` in `src/Café.elm` to `FerméeRenamed`",
    "rename-module": "Rename the module `Café` to `CaféRenamed`. Move `src/Café.elm` to `src/CaféRenamed.elm`",
    "add-variant": "Add a variant `AddedByBenchmark`",
  });

  // The agent takes the two names from the request, and writes the new one wherever the old one stands whole
  const agent = standInAgent(
    t,
    `const [, from, to] = /^Rename the \\w+ \`([^\`]+)\`.*? to \`([^\`]+)\`/.exec(prompt);
  const whole = new RegExp("(?<![\\\\p{L}\\\\d_])" + from + "(?![\\\\p{L}\\\\d_])", "gu");
  if (fs.existsSync("src/" + from + ".elm")) fs.renameSync("src/" + from + ".elm", "src/" + to + ".elm");
  for (const name of fs.readdirSync("src")) {
    fs.writeFileSync("src/" + name, fs.readFileSync("src/" + name, "utf8").replace(whole, to));
  }`
  );
  for (const type of ["rename-function", "rename-variant", "rename-module"]) {
    const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", type, "--arms", "baseline", "--agent", agent]);
    assert.equal(ran.code, 0, ran.stderr);
    const { outcome, problems } = JSON.parse(readFileSync(join(out, "runs", `Bistro--${type}--baseline--1.json`), "utf-8"));
    assert.deepEqual({ type, outcome, problems }, { type, outcome: "passed", problems: [] });
  }
});

test("with the real compiler, a function whose new name an unannotated function has is passed over", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  const repo = tempDir(t);
  mkdirSync(join(repo, "src"));
  cpSync(join(REPO, "tests/fixture/elm.json"), join(repo, "elm.json"));
  writeFileSync(
    join(repo, "src/Lib.elm"),
    [
      "module Lib exposing (convertValue, scaleValue)",
      "",
      "",
      "convertValue : Int -> Int",
      "convertValue value =",
      "    convertValueRenamed value",
      "",
      "",
      "convertValueRenamed value =",
      "    value + 1",
      "",
      "",
      "scaleValue : Int -> Int",
      "scaleValue value =",
      "    value * 2",
      "",
    ].join("\n")
  );
  writeFileSync(join(repo, "src/Main.elm"), "module Main exposing (shown)\n\nimport Lib\n\n\nshown : Int\nshown =\n    Lib.convertValue (Lib.scaleValue 1)\n");
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Values", repo, check: ["elm", "make", "src/Main.elm", "--output=/dev/null"] }] }));
  const out = join(tempDir(t), "out");
  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  // convertValue comes first by its name. Renamed, it would clash with the function that has no annotation.
  const task = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).tasks.find((task) => task.type === "rename-function");
  assert.match(task?.prompt ?? planned.stdout, /^Rename the function `scaleValue` of the module `Lib`/);
});

test("with the real compiler, a module whose new path holds a file is no target, whatever the scan makes of that file", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  const repo = tempDir(t);
  mkdirSync(join(repo, "src"));
  cpSync(join(REPO, "tests/fixture/elm.json"), join(repo, "elm.json"));
  const modules = ["Alpha", "Beta", "Gamma"];
  for (const module of modules) {
    writeFileSync(join(repo, `src/${module}.elm`), `module ${module} exposing (shown)\n\n\nshown : Int\nshown =\n    1\n`);
  }
  writeFileSync(
    join(repo, "src/Main.elm"),
    `module Main exposing (total)\n\n${modules.map((module) => `import ${module}\n`).join("")}\n\ntotal : Int\ntotal =\n    ${modules.map((module) => `${module}.shown`).join(" + ")}\n`
  );
  // A placeholder without a module line, a link whose end is gone, and a name in another letter case
  writeFileSync(join(repo, "src/AlphaRenamed.elm"), "-- module AlphaRenamed exposing (shown)\n");
  symlinkSync("Gone.elm", join(repo, "src/BetaRenamed.elm"));
  writeFileSync(join(repo, "src/gammarenamed.elm"), "-- module GammaRenamed exposing (shown)\n");
  gitRepository(repo);
  const ignoresCase = sameDirectory(repo, join(dirname(repo), basename(repo).toUpperCase()));
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Names", repo, check: ["elm", "make", "src/Main.elm", "--output=/dev/null"] }] }));
  const out = join(tempDir(t), "out");
  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);
  const task = JSON.parse(readFileSync(join(out, "plan.json"), "utf-8")).tasks.find((task) => task.type === "rename-module");
  if (ignoresCase) {
    assert.equal(task, undefined);
    assert.match(planned.stdout, /Names: no suitable target for rename-module\. Its candidates were left out: 3 whose new path holds a file already\n/);
  } else {
    assert.match(task?.prompt ?? planned.stdout, /^Rename the module `Gamma` to `GammaRenamed`\./);
  }
});

test("with the real compiler, a module rename that moves the module over a file of the starting commit is a wrong result", async (t) => {
  if (!hasElm()) {
    t.skip("needs elm 0.19.1 on PATH");
    return;
  }
  const repo = tempDir(t);
  mkdirSync(join(repo, "src"));
  cpSync(join(REPO, "tests/fixture/elm.json"), join(repo, "elm.json"));
  writeFileSync(join(repo, "src/Lib.elm"), 'module Lib exposing (label)\n\n\nlabel : String\nlabel =\n    "label"\n');
  writeFileSync(join(repo, "src/Main.elm"), "module Main exposing (shown)\n\nimport Lib\n\n\nshown : String\nshown =\n    Lib.label\n");
  gitRepository(repo);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Lib", repo, check: ["elm", "make", "src/Main.elm", "--output=/dev/null"] }] }));
  const out = join(tempDir(t), "out");
  const planned = await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"]);
  assert.equal(planned.code, 0, planned.stderr);

  // The sessions start from a commit with a placeholder at the new path, which plan would have seen
  writeFileSync(join(repo, "src/LibRenamed.elm"), "-- module LibRenamed exposing (label)\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "--message", "placeholder");
  const planPath = join(out, "plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf-8"));
  writeFileSync(planPath, JSON.stringify({ ...plan, codebases: [{ ...plan.codebases[0], commit: git(repo, "rev-parse", "HEAD").trim() }] }));

  // The agent moves the module onto the placeholder and renames every use. The project compiles.
  const agent = standInAgent(
    t,
    `fs.renameSync("src/Lib.elm", "src/LibRenamed.elm");
  for (const file of ["src/LibRenamed.elm", "src/Main.elm"]) {
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\\bLib\\b/g, "LibRenamed"));
  }`
  );
  const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--only", "rename-module", "--arms", "baseline", "--agent", agent]);
  assert.equal(ran.code, 0, ran.stderr);
  const { outcome, problems } = JSON.parse(readFileSync(join(out, "runs", "Lib--rename-module--baseline--1.json"), "utf-8"));
  assert.deepEqual({ outcome, problems }, { outcome: "wrong-result", problems: ["the move of src/Lib.elm wrote over src/LibRenamed.elm, a file of the starting commit"] });
});

test("a run takes a plan only from the state of the benchmark that made it", async (t) => {
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo: gitRepository(copyFixture(t)), check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
  const out = join(tempDir(t), "out");
  assert.equal((await runNode(BENCH, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);

  // What a task expects is written into the plan, and another state of the code may check other things
  const path = join(out, "plan.json");
  const planned = JSON.parse(readFileSync(path, "utf-8"));
  writeFileSync(path, JSON.stringify({ ...planned, benchmark: "0000000" }));
  const ran = await runNode(BENCH, ["run", "--config", config, "--out", out, "--arms", "baseline", "--agent", FAKE_AGENT], { env: { ...process.env, FAKE_AGENT: "idle" } });
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /plan\.json was made by another state of the benchmark's code \(0000000, and this is .+\)\. What its tasks expect may not be what this code checks\. Plan again/);
  assert.deepEqual(readdirSync(join(out, "runs")), []);

  // The benchmark imports modules of the wrapper too. workspace.mjs decides which source directories count, for one.
  const copy = await plannedCopy(t);
  for (const file of ["doctor.mjs", "harnesses.mjs", "lsp-client.mjs", "workspace.mjs"]) {
    const module = join(copy.root, "mcp-wrapper", file);
    const text = readFileSync(module, "utf-8");
    writeFileSync(module, `${text}\n`);
    const edited = await runNode(copy.bench, ["run", "--config", copy.config, "--out", copy.out, "--arms", "baseline", "--agent", FAKE_AGENT], {
      env: { ...process.env, FAKE_AGENT: "idle" },
    });
    writeFileSync(module, text);
    assert.equal(edited.code, 1, file);
    assert.match(edited.stderr, /plan\.json was made by another state of the benchmark's code/, file);
  }
});

test("a refusal for the plan, the lock, the config or the records prints its reason without the command-line usage", async (t) => {
  const { config, out } = await plannedFixture(t);
  const args = ["run", "--config", config, "--out", out, "--arms", "baseline", "--agent", FAKE_AGENT, "--only", "rename-function"];
  const planPath = join(out, "plan.json");
  const planText = readFileSync(planPath, "utf-8");
  const plan = JSON.parse(planText);
  const refused = async (message) => {
    const result = await runNode(BENCH, args);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /Usage:/);
  };
  rmSync(planPath);
  await refused(/plan\.json does not exist/);
  writeFileSync(planPath, planText);
  writeFileSync(join(out, "lock"), String(process.pid));
  await refused(/Another benchmark, process/);
  rmSync(join(out, "lock"));
  writeFileSync(planPath, JSON.stringify({ ...plan, benchmark: "older" }));
  await refused(/plan\.json was made by another state/);
  writeFileSync(planPath, planText);
  const configText = readFileSync(config, "utf-8");
  const changed = JSON.parse(configText);
  changed.codebases[0].checkTimeoutMs = 1000;
  writeFileSync(config, JSON.stringify(changed));
  await refused(/config's "checkTimeoutMs"/);
  writeFileSync(config, configText);
  mkdirSync(join(out, "runs"), { recursive: true });
  writeFileSync(join(out, "runs/earlier.json"), JSON.stringify({ arm: "baseline" }));
  writeFileSync(join(out, "run.json"), JSON.stringify({ model: "earlier", maxBudgetUsd: 5, timeoutMin: 20, benchmark: plan.benchmark }));
  await refused(/records of sessions that ran differently/);
});

test("a run is held to the recorded language server only while sessions of the lsp arm are left to do", async (t) => {
  const { root, binary, bench, config, out } = await plannedCopy(t);
  const held = { model: "claude-opus-5-5", maxBudgetUsd: 5, timeoutMin: 20, benchmark: stateOfSources(root, BENCHMARK_SOURCES), languageServer: "the recorded server", agent: "an agent that names no version", arms: ["lsp"] };
  mkdirSync(join(out, "runs"));
  const lspRecord = join(out, "runs/Fixture--rename-function--lsp--1.json");
  writeFileSync(lspRecord, JSON.stringify({ arm: "lsp", languageServer: held.languageServer }));
  writeFileSync(join(out, "run.json"), JSON.stringify(held));
  const command = ["run", "--config", config, "--out", out, "--only", "rename-function", "--agent", join(out, "missing-agent")];
  const ago = new Date(Date.now() - 3600000);
  const binaryText = readFileSync(binary);
  for (const state of ["stale", "missing", "different"]) {
    writeFileSync(binary, binaryText, { mode: 0o755 });
    if (state === "stale") utimesSync(binary, ago, ago);
    if (state === "missing") rmSync(binary);
    if (state === "different") appendFileSync(join(root, "mcp-wrapper/index.mjs"), "\n");
    const baseline = await runNode(bench, command);
    assert.equal(baseline.code, 1);
    // It got as far as session setup, past every server check, without starting a paid agent.
    assert.match(baseline.stderr, /Could not start .*missing-agent/);
    assert.doesNotMatch(baseline.stderr, /Usage:|lsp arm needs|MCP server|sessions that ran differently/);
    assert.deepEqual(JSON.parse(readFileSync(join(out, "run.json"), "utf-8")), held);
  }
  // No work remains in either arm, so the server is not needed then either.
  writeFileSync(join(out, "runs/Fixture--rename-function--baseline--1.json"), JSON.stringify({ arm: "baseline" }));
  assert.equal((await runNode(bench, command)).code, 0);
  // A later lsp session is still held to the server of the recorded ones.
  const later = await runNode(bench, [...command, "--repeat", "2"]);
  assert.equal(later.code, 1);
  assert.match(later.stderr, /records of sessions that ran differently: the language server/);
});

test("the command line names what is missing", async (t) => {
  const out = tempDir(t);
  const cases = [
    [["frobnicate"], /Unknown command "frobnicate"/],
    [["plan"], /--out is required/],
    [["plan", "--out", out], /--config is required/],
    [["run", "--out", out, "--config"], /Expected --<option> <value>, got "--config"/],
    [["plan", "--out", out, "--confg", "x.json"], /Unknown option --confg\. This command takes: --out, --config, --min-files/],
    [["report", "--out", out, "--repeat", "2"], /Unknown option --repeat\. This command takes: --out/],
    [["plan", "--out", out, "--config", "x.json", "--min-files", "0"], /--min-files must be a whole number of 1 or more/],
  ];
  for (const [args, message] of cases) {
    const result = await runNode(BENCH, args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.stderr, message);
  }
  // Inside a hook, git tells every git command where its repository is, and none of them would look at the config's
  for (const command of ["plan", "run"]) {
    const hooked = await runNode(BENCH, [command, "--out", out, "--config", "x.json"], { env: { ...process.env, GIT_DIR: join(out, ".git") } });
    assert.equal(hooked.code, 1);
    assert.doesNotMatch(hooked.stderr, /Usage:/);
    assert.match(hooked.stderr, /^GIT_DIR is set, so git would work in the repository it names and not in the codebases of the config\. Unset it and run again\.$/m);
  }
  const emptyReport = await runNode(BENCH, ["report", "--out", out]);
  assert.equal(emptyReport.code, 1);
  assert.doesNotMatch(emptyReport.stderr, /Usage:/);
  assert.match(emptyReport.stderr, /No run records in /);
  assert.match((await runNode(BENCH, ["--help"])).stdout, /^Usage: node benchmarks\/bench\.mjs <command>/);
});

// A copy of the benchmark and the wrapper in a checkout of their own, where a test builds the language server as it likes
function benchmarkCopy(t) {
  const { binary } = wrapperCopy(t);
  const root = join(binary, "../../..");
  cpSync(join(REPO, "benchmarks"), join(root, "benchmarks"), { recursive: true });
  cpSync(join(REPO, ".claude-plugin"), join(root, ".claude-plugin"), { recursive: true });
  return { root, binary, bench: join(root, "benchmarks/bench.mjs") };
}

// Put a stand-in for the language server into a benchmarkCopy, with the dependency file that cargo writes beside
// the binary: one rule that names it and the whole path of each source, with a backslash in front of a space
function buildStandIn({ root, binary }, sources = ["src/main.rs"]) {
  // It answers the two commands that "cli.mjs doctor" sends, which run sends too before a session of the lsp arm
  installLanguageServerStandIn(binary, `(message) => ({ "elm.syncWithDisk": { synced: true }, "elm.unreadRanges": { ranges: [] } })[message.params?.command] ?? null`);
  const [target, ...paths] = [binary, ...sources.map((file) => join(root, file))].map((path) => path.replaceAll(" ", "\\ "));
  writeFileSync(`${binary}.d`, `${target}: ${paths.join(" ")}\n`);
}

test("run checks its numbers and the language server before it starts a session", async (t) => {
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "A", repo: gitRepository(copyFixture(t)), check: ["true"] }] }));
  let runOut = tempDir(t);
  let runConfig = config;
  const run = (bench, args) => runNode(bench, ["run", "--out", runOut, "--config", runConfig, "--agent", join(runOut, "missing-agent"), ...args]);

  for (const [args, message] of [
    [["--repeat", "2.5"], /--repeat must be a whole number of 1 or more/],
    [["--concurrency", "0"], /--concurrency must be a whole number of 1 or more/],
    [["--max-budget-usd", "free"], /--max-budget-usd must be a positive number/],
    [["--max-budget-usd", "Infinity"], /--max-budget-usd must be a positive number/],
    // A timer takes a longer time for 1 millisecond, and every session would end at once
    [["--timeout-min", "40000"], /--timeout-min must be at most 35791, the longest that a timer of Node\.js waits/],
    [["--arms", "baseline,fast"], /Unknown arm "fast"\. Known: baseline, lsp/],
    // The levels that Claude Code takes for --effort, as it spells them
    [["--effort", "huge"], /Unknown effort "huge"\. Known: low, medium, high, xhigh, max/],
    [["--effort", "High"], /Unknown effort "High"\. Known: low, medium, high, xhigh, max/],
  ]) {
    const result = await run(BENCH, args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.stderr, message);
  }

  // A checkout where the language server was never built
  const copy = await plannedCopy(t);
  const { root, binary, bench } = copy;
  runOut = copy.out;
  runConfig = copy.config;
  rmSync(binary);
  const unbuilt = await run(bench, []);
  assert.equal(unbuilt.code, 1);
  assert.match(unbuilt.stderr, /^The lsp arm needs the language server, and .*elm_lsp is missing\. Run scripts\/setup\.sh to build it\./);

  // Built, and then a source was edited. The report would name the sources beside a binary of older ones.
  const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000);
  const write = (file, hours) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "fn main() {}\n");
    utimesSync(join(root, file), ago(hours), ago(hours));
  };
  for (const file of ["src/main.rs", "src/a module.rs", "src/bin/benchmark.rs", "Cargo.toml", "Cargo.lock"]) write(file, 2);
  // The other binaries under src/bin are no part of what cargo lists
  buildStandIn(copy, ["src/main.rs", "src/a module.rs", "Cargo.toml", "Cargo.lock"]);
  utimesSync(binary, ago(1), ago(1));
  write("src/main.rs", 0);
  // The stand-in agent is missing, so a valid server cannot start a paid session.
  const pastServer = /Could not start .*missing-agent/;
  const stale = (file) => new RegExp(`^The lsp arm needs a language server built from its sources as they are, and .*elm_lsp is older than ${file}\\. Run scripts/setup\\.sh to build it again\\.`);
  const edited = await run(bench, []);
  assert.equal(edited.code, 1);
  assert.match(edited.stderr, stale("src/main\\.rs"));
  // The baseline arm has no language server
  assert.match((await run(bench, ["--arms", "baseline"])).stderr, pastServer);
  // Built again. An edit to another binary leaves this one as it was, and so does the build that follows it.
  utimesSync(binary, ago(0), ago(0));
  write("src/bin/benchmark.rs", -1);
  assert.match((await run(bench, [])).stderr, pastServer);
  // A file of this binary. git tracks none of them here, and cargo builds them all the same.
  write("src/a module.rs", -1);
  assert.match((await run(bench, [])).stderr, stale("src/a module\\.rs"));
  // Built again. A checkout writes the manifest and the lock file again, and cargo builds nothing new for that.
  utimesSync(binary, ago(-2), ago(-2));
  write("Cargo.toml", -3);
  write("Cargo.lock", -3);
  assert.match((await run(bench, [])).stderr, pastServer);

  // Nobody knows what a binary was built from where cargo's list is missing, or where none of the files it names is
  // there any more, as after the checkout was moved. The report would name sources all the same.
  const list = readFileSync(`${binary}.d`, "utf-8");
  rmSync(`${binary}.d`);
  const unlisted = await run(bench, []);
  assert.equal(unlisted.code, 1);
  assert.match(unlisted.stderr, /^The lsp arm needs a language server whose sources are known, and .*elm_lsp\.d, the list of the files it was built from, is missing\. Build it with scripts\/setup\.sh, which writes that list\./);
  writeFileSync(`${binary}.d`, list.replaceAll(root, join(root, "moved")));
  const gone = await run(bench, []);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /^The lsp arm needs a language server whose sources are known, and none of the files that .*elm_lsp\.d names as its sources is there any more, as after the checkout was moved\. Build it again with scripts\/setup\.sh/);
  assert.match((await run(bench, ["--arms", "baseline"])).stderr, pastServer);

  // A binary built after its sources that exits at once. The wrapper would start it at a session's first tool call.
  const planned = await plannedCopy(t);
  writeFileSync(planned.binary, "#!/bin/sh\nexit 3\n");
  // The stand-in notes each session it starts, the isolation check's among them
  const started = join(tempDir(t), "started");
  const agent = join(tempDir(t), "agent.mjs");
  writeFileSync(agent, `#!${process.execPath}\nimport { appendFileSync } from "fs";\nappendFileSync(${JSON.stringify(started)}, "started\\n");\nawait import(${JSON.stringify(FAKE_AGENT)});\n`);
  chmodSync(agent, 0o755);
  const runPlanned = (...arms) =>
    runNode(planned.bench, ["run", "--config", planned.config, "--out", planned.out, "--agent", agent, "--only", "rename-function", ...arms], {
      env: { ...process.env, FAKE_AGENT: "solve" },
    });
  const dead = await runPlanned();
  assert.equal(dead.code, 1, dead.stderr);
  assert.match(dead.stderr, /^The lsp arm needs a language server that starts and answers, and the checks of "cli\.mjs doctor" fail:\n(.*\n)*fail +language server +.*elm_lsp did not start: LSP process exited with code 3$/m);
  assert.equal(existsSync(started), false, "no session started, and no isolation check");
  assert.deepEqual(readdirSync(join(planned.out, "runs")), []);
  // The baseline arm starts no language server
  const baseline = await runPlanned("--arms", "baseline");
  assert.equal(baseline.code, 0, baseline.stderr);
});

test("run starts no session after its MCP pre-flight fails", async (t) => {
  const { root, bench, config, out } = await plannedCopy(t);
  writeFileSync(join(root, "mcp-wrapper/index.mjs"), "process.exit(3);\n");
  const started = join(tempDir(t), "started");
  const agent = join(tempDir(t), "agent.mjs");
  writeFileSync(agent, `#!${process.execPath}\nimport { writeFileSync } from "fs"; writeFileSync(${JSON.stringify(started)}, "started");\n`, { mode: 0o755 });
  const ran = await runNode(bench, ["run", "--config", config, "--out", out, "--agent", agent]);
  assert.equal(ran.code, 1, ran.stderr);
  assert.match(ran.stderr, /MCP server "elm-lsp" ended before it answered initialize and tools\/list/);
  assert.doesNotMatch(ran.stderr, /Usage:/);
  assert.equal(existsSync(started), false);
  assert.deepEqual(readdirSync(join(out, "runs")), []);
});

test("Ctrl-C during the MCP pre-flight keeps the sessions from starting", async (t) => {
  const { root, bench, config, out } = await plannedCopy(t);
  const asked = join(tempDir(t), "asked");
  writeFileSync(join(root, "mcp-wrapper/index.mjs"), `import { writeFileSync } from "fs";\nwriteFileSync(${JSON.stringify(asked)}, "asked");\nsetInterval(() => {}, 1000);\n`);
  const started = join(tempDir(t), "started");
  const agent = join(tempDir(t), "agent.mjs");
  writeFileSync(agent, `#!${process.execPath}\nimport { writeFileSync } from "fs"; writeFileSync(${JSON.stringify(started)}, "started");\n`, { mode: 0o755 });
  const running = spawn(process.execPath, [bench, "run", "--config", config, "--out", out, "--agent", agent], { stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  running.stderr.on("data", (chunk) => (said += chunk));
  // The server is started, and the pre-flight waits for its answer
  for (let waited = 0; !existsSync(asked) && waited < 10000; waited += 50) {
    await sleep(50);
  }
  assert.ok(existsSync(asked), "the pre-flight started the server");
  running.kill("SIGINT");
  assert.deepEqual(await once(running, "close"), [130, null]);
  assert.equal(said, "Interrupted. Whatever was running has been ended. Finished sessions keep their records, and the same command picks up from there.\n");
  assert.equal(existsSync(started), false, "no session started, and no isolation check");
  assert.deepEqual(readdirSync(join(out, "runs")), []);
});

// A benchmarkCopy whose language server is built from what git holds, with a plan of the fixture
async function plannedCopy(t) {
  const copy = benchmarkCopy(t);
  const { root, bench } = copy;
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/main.rs"), "fn main() {}\n");
  git(root, "init", "--quiet");
  git(root, "add", "src", "mcp-wrapper");
  git(root, "commit", "--quiet", "--message", "sources");
  buildStandIn(copy);
  const config = join(tempDir(t), "config.json");
  writeFileSync(config, JSON.stringify({ codebases: [{ label: "Fixture", repo: gitRepository(copyFixture(t)), check: [process.execPath, FAKE_COMPILER, "src/Main.elm"] }] }));
  const out = join(tempDir(t), "out");
  assert.equal((await runNode(bench, ["plan", "--config", config, "--out", out, "--min-files", "1"])).code, 0);
  return { ...copy, config, out };
}

test("a resumed run is held to the language server's version and sources, and not to when its binary was built", async (t) => {
  const { root, binary, bench, config, out } = await plannedCopy(t);
  const runIn = (dir, ...more) =>
    runNode(bench, ["run", "--config", config, "--out", dir, "--agent", FAKE_AGENT, "--only", "rename-function", "--arms", "lsp", ...more], {
      env: { ...process.env, FAKE_AGENT: "solve" },
    });
  const run = (...more) => runIn(out, ...more);
  const recorded = (repetition) => JSON.parse(readFileSync(join(out, "runs", `Fixture--rename-function--lsp--${repetition}.json`), "utf-8")).languageServer;

  const first = await run();
  assert.equal(first.code, 0, first.stderr);
  // The record names the build, and the run is held to the rest
  const held = JSON.parse(readFileSync(join(out, "run.json"), "utf-8")).languageServer;
  assert.match(held, /^\S+ \([0-9a-f]{40}\)$/);
  assert.match(recorded(1), new RegExp(`^${held.replace(/[()]/g, "\\$&")}, built \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC$`));
  // Built again from the same sources, an hour later
  const later = new Date(Date.now() + 3600 * 1000);
  utimesSync(binary, later, later);
  const rebuilt = await run("--repeat", "2");
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  assert.notEqual(recorded(2), recorded(1));
  // The other binaries under src/bin are programs of their own, edited or committed
  mkdirSync(join(root, "src/bin"));
  writeFileSync(join(root, "src/bin/benchmark.rs"), "fn main() {}\n");
  assert.equal((await run("--repeat", "3")).code, 0);
  git(root, "add", "src/bin");
  git(root, "commit", "--quiet", "--message", "another binary");
  assert.equal((await run("--repeat", "4")).code, 0);
  assert.equal(recorded(4), recorded(2));
  // Other sources are another server
  writeFileSync(join(root, "src/main.rs"), "fn main() { }\n");
  const edited = await run("--repeat", "5");
  assert.equal(edited.code, 1);
  assert.match(edited.stderr, /holds records of sessions that ran differently: the language server was \S+ \([0-9a-f]{40}\) and is now \S+ \([0-9a-f]{40}, with uncommitted changes [0-9a-f]{8}\)\. Run as before/);

  // A directory where the lsp arm never ran is held to no language server
  const alone = join(tempDir(t), "out");
  mkdirSync(alone);
  cpSync(join(out, "plan.json"), join(alone, "plan.json"));
  assert.equal((await runIn(alone, "--arms", "baseline")).code, 0);
  // Nor after a run of the lsp arm whose session lost the API at its first request. No record names its server.
  const lost = await runNode(bench, ["run", "--config", config, "--out", alone, "--agent", FAKE_AGENT, "--only", "rename-function", "--arms", "lsp"], {
    env: { ...process.env, FAKE_AGENT: "unreachable" },
  });
  assert.equal(lost.code, 1);
  assert.match(lost.stderr, /the session ended before the model answered once .*\. Nothing was recorded for it\./);
  appendFileSync(join(root, "mcp-wrapper/index.mjs"), "\n");
  const baseline = await runIn(alone, "--arms", "baseline", "--repeat", "2");
  assert.equal(baseline.code, 0, baseline.stderr);
  // From the first run of the lsp arm there, later lsp sessions are held to that server
  const joined = await runIn(alone, "--repeat", "2");
  assert.equal(joined.code, 0, joined.stderr);
  writeFileSync(join(root, "src/main.rs"), "fn main() {   }\n");
  const serverBeforeBaseline = JSON.parse(readFileSync(join(alone, "run.json"), "utf-8")).languageServer;
  const after = await runIn(alone, "--arms", "baseline", "--repeat", "3");
  assert.equal(after.code, 0, after.stderr);
  assert.equal(JSON.parse(readFileSync(join(alone, "run.json"), "utf-8")).languageServer, serverBeforeBaseline);
  const lspAfter = await runIn(alone, "--repeat", "3");
  assert.equal(lspAfter.code, 1);
  assert.match(lspAfter.stderr, /holds records of sessions that ran differently: the language server was \S+ \([0-9a-f]{40}, with uncommitted changes ([0-9a-f]{8})\) and is now \S+ \([0-9a-f]{40}, with uncommitted changes (?!\1)[0-9a-f]{8}\)\. Run as before/);
});

test("a run stops before a session of the lsp arm, and after one, once the language server of this checkout has changed", async (t) => {
  // Each session of the arm starts the server afresh from the checkout, at its first tool call and again after ten idle
  // minutes, and this stand-in changes the checkout in each session on a task. Here the first session may have run
  // another server than the run began with.
  const changes = [
    // An edit to the wrapper, which the session would load once it starts the server again
    [
      (root) => `fs.appendFileSync(${JSON.stringify(join(root, "mcp-wrapper/index.mjs"))}, "\\n")`,
      /^The language server was \S+ \([0-9a-f]{40}\) when this run began, and is now \S+ \([0-9a-f]{40}, with uncommitted changes [0-9a-f]{8}\)\. The session of the lsp arm that ran meanwhile may have run another one, and nothing was recorded for it\. .*leave the checkout as it is while a run goes on\.$/m,
    ],
    // A source written again with what it held, as a checkout of another branch and back writes it. The sources are as
    // they were, and the binary is older than one of them.
    [
      (root) => `const later = new Date(Date.now() + 3600 * 1000); fs.utimesSync(${JSON.stringify(join(root, "src/main.rs"))}, later, later)`,
      /^The lsp arm needs a language server built from its sources as they are, and .*elm_lsp is older than src\/main\.rs\. Run scripts\/setup\.sh to build it again\.$/m,
    ],
  ];
  // A copy of this checkout, planned, and a run of two sessions of each of `arms` on one task with a stand-in that makes
  // `change` in the sessions where `when` holds
  const runChanging = async (change, arms, when = "true") => {
    const { root, bench, config, out } = await plannedCopy(t);
    const agent = join(tempDir(t), "agent.mjs");
    writeFileSync(
      agent,
      `#!${process.execPath}
import * as fs from "fs";
const args = process.argv.slice(2);
if (!args[args.indexOf("--print") + 1].includes("SENTINEL") && ${when}) {
  ${change(root)};
}
await import(${JSON.stringify(FAKE_AGENT)});
`
    );
    chmodSync(agent, 0o755);
    const ran = await runNode(bench, ["run", "--config", config, "--out", out, "--agent", agent, "--only", "rename-function", "--arms", arms, "--repeat", "2"], {
      env: { ...process.env, FAKE_AGENT: "solve" },
    });
    return { ran, files: readdirSync(join(out, "runs")).sort() };
  };
  // The session during which the checkout changed leaves no record, no transcript and no patch
  for (const [change, message] of changes) {
    const { ran, files } = await runChanging(change, "lsp");
    assert.equal(ran.code, 1, ran.stderr);
    assert.match(ran.stderr, message);
    assert.deepEqual(files, []);
  }
  // A session of the baseline that goes first changes the checkout, and the session of the lsp arm after it does not start
  const inBaseline = `Object.keys(JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers).length === 0`;
  const before = await runChanging(changes[0][0], "lsp,baseline", inBaseline);
  assert.equal(before.ran.code, 1, before.ran.stderr);
  assert.match(before.ran.stderr, /^The language server was .* A session of the lsp arm would run another server than its record names\. /m);
  assert.deepEqual(before.files, ["jsonl", "json", "patch"].map((ending) => `Fixture--rename-function--baseline--1.${ending}`).sort());
  // A session of the baseline starts no server. A run of the baseline alone goes on while the checkout changes.
  const { ran, files } = await runChanging(changes[0][0], "baseline");
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(
    files.filter((file) => file.endsWith(".json")),
    ["Fixture--rename-function--baseline--1.json", "Fixture--rename-function--baseline--2.json"]
  );
});
