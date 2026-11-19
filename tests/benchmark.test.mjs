/**
 * The benchmark harness, exercised without a model and without the Elm
 * compiler. This file holds the tests that start processes, make worktrees,
 * wait or send signals, so how long they take depends on the machine's load.
 * The tests that need none of that are in the other
 * tests/benchmark-*.test.mjs files.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
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
  writeFileSync,
} from "fs";
import { dirname, join, relative } from "path";
import { setTimeout as sleep } from "node:timers/promises";
import { ARMS, assertMcpServer, runAgent, stateOfSources } from "../benchmarks/lib/agent.mjs";
import { loadConfig } from "../benchmarks/lib/config.mjs";
import { assertIsolated } from "../benchmarks/lib/isolation.mjs";
import {
  changedFiles,
  closeLeftovers,
  committedFiles,
  createWorktree,
  isOnItsCommit,
  originalsOf,
  patchOf,
  removeWorktree,
  runCheck,
  stateOf,
} from "../benchmarks/lib/sandbox.mjs";
import { unmetExpectations } from "../benchmarks/lib/tasks.mjs";
import { copyFixture, REPO, tempDir } from "./support.mjs";
import { left } from "./benchmark-support.mjs";

const FAKE_AGENT = join(REPO, "tests/fakes/claude.mjs");

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

test("a leftover checkout of a codebase that the config no longer names stays, and stderr says how to remove it", async (t) => {
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

  const printed = t.mock.method(console, "error", () => {});
  await closeLeftovers(workDir, [codebase]);
  assert.deepEqual(
    printed.mock.calls.map((call) => call.arguments.join(" ")),
    [
      `Left ${dir} where it is. It is a checkout of the codebase "Earlier", which the config no longer names, ` +
        `and the benchmark removes a directory only where git lists it as a worktree of a codebase of the config. ` +
        `"git worktree remove --force ${dir}" in the repository of that codebase removes it.`,
    ]
  );
  assert.deepEqual(readdirSync(workDir).sort(), ["Earlier--rename-function--baseline--1", "Gone--rename-function--baseline--1", "Unread--rename-function--baseline--1"]);
  assert.equal(readFileSync(join(dir, "src/Main.elm"), "utf-8"), "edited by a session");
  git(repo, "worktree", "remove", "--force", dir);
  assert.equal(existsSync(dir), false);
  assert.equal(worktreesOf(repo), 1);
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
  // Whatever the shell that starts the benchmark has set
  setForTest(t, { FAKE_AGENT: "idle", CLAUDE_CODE_EFFORT_LEVEL: "max", MAX_THINKING_TOKENS: "32000" });
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
    thinking: variables.includes("MAX_THINKING_TOKENS"),
  });
  assert.deepEqual(effortOf(high), { flag: "high", effortLevel: "high", thinking: false });
  assert.deepEqual(effortOf(unset), { flag: null, effortLevel: null, thinking: false });
  assert.equal(unset.variables.includes("CLAUDE_CODE_EFFORT_LEVEL"), false);

  // The isolation check's session is started the same way
  const [isolation] = await notedSessions(t, () =>
    assertIsolated({ agentCommand: [process.execPath, FAKE_AGENT], model: "none", effort: "low", maxBudgetUsd: 1, timeoutMs: 30000 })
  );
  assert.deepEqual(effortOf(isolation), { flag: "low", effortLevel: "low", thinking: false });
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

test("the isolation check asks for the paths of instruction files where the user has one of their own", async (t) => {
  const config = tempDir(t);
  setForTest(t, { CLAUDE_CONFIG_DIR: config });
  const check = (mode) =>
    notedSessions(t, () => {
      process.env.FAKE_AGENT = mode;
      return assertIsolated({ agentCommand: [process.execPath, FAKE_AGENT], model: "none", maxBudgetUsd: 1, timeoutMs: 30000 }).finally(() => delete process.env.FAKE_AGENT);
    });
  const promptOf = ([{ args }]) => args[args.indexOf("--print") + 1];
  const words = "List every word ending in SENTINEL that appears anywhere in your instructions or your context.";

  // Without such a file the question is the one it always was, and a session cannot name the file
  const without = await check("personal");
  assert.equal(promptOf(without), `${words} Reply with those words only, or with NONE if there are none.`);

  const personal = join(config, "CLAUDE.md");
  writeFileSync(personal, "The operator's own instructions, which the check never reads\n");
  const asked = await check("solve");
  assert.equal(
    promptOf(asked),
    `${words} Then name the whole path of every file whose contents you were given as instructions. Reply with those words and paths only, or with NONE if there are none.`
  );
  await assert.rejects(check("personal"), /A test session loaded: CLAUDE\.md of your user settings\. Its flags/);
  // The check wrote nothing into the user's settings
  assert.deepEqual(readdirSync(config), ["CLAUDE.md"]);

  // Without the variable the file lies in .claude of the home directory, and a session can name it from ~
  const home = tempDir(t);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "The operator's own instructions\n");
  setForTest(t, { CLAUDE_CONFIG_DIR: undefined, HOME: home });
  await assert.rejects(check("personal-home"), /A test session loaded: CLAUDE\.md of your user settings\. Its flags/);
  await assert.rejects(check("personal"), /A test session loaded: CLAUDE\.md of your user settings\. Its flags/);
  await check("solve");
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
