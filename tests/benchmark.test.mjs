/**
 * The benchmark harness, exercised without a model and without the Elm
 * compiler. This file holds the tests that start a process. The tests that
 * need none are in the other tests/benchmark-*.test.mjs files.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { unmetExpectations } from "../benchmarks/lib/tasks.mjs";
import { tempDir } from "./support.mjs";
import { left } from "./benchmark-support.mjs";

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
