/**
 * The master runner's verdict. It runs suites it only knows by their output,
 * so the suites here are stand-ins.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, writeFileSync } from "fs";
import { join } from "path";
import { REPO, runNode, tempDir } from "./support.mjs";

const PASSING_SCRIPT = `console.log("Passed: 3\\nFailed: 0");\n`;
const wrapperSuite = (assertion) => `import { test } from "node:test";\ntest("stand-in", () => { ${assertion} });\n`;

// Run a copy of the runner beside the given suites. The copy writes its coverage file there too.
function runAll(t, { fixture = PASSING_SCRIPT, meetdown = PASSING_SCRIPT, wrapper }) {
  const dir = tempDir(t);
  copyFileSync(join(REPO, "tests/run_all_tests.mjs"), join(dir, "run_all_tests.mjs"));
  writeFileSync(join(dir, "run_tests.mjs"), fixture);
  writeFileSync(join(dir, "test_meetdown_comprehensive.mjs"), meetdown);
  writeFileSync(join(dir, "stand_in.test.mjs"), wrapper);
  // Without this variable the inner test runner would take itself for a part of this run
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return runNode(join(dir, "run_all_tests.mjs"), [], { env });
}

test("the master runner passes when every suite does", async (t) => {
  const { code, stdout } = await runAll(t, { wrapper: wrapperSuite("") });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /Wrapper Tests:[^\n]*\n[^\n]*Passed: 1/);
  assert.match(stdout, /Tests:  7\n/);
  assert.match(stdout, /ALL TESTS PASSED/);
});

test("the master runner fails when a wrapper test fails", async (t) => {
  const { code, stdout } = await runAll(t, { wrapper: wrapperSuite('throw new Error("broken")') });
  assert.equal(code, 1);
  assert.match(stdout, /Wrapper Tests:[^\n]*\n[^\n]*\n[^\n]*Failed: 1/);
  assert.match(stdout, /TESTS FAILED/);
});

test("the master runner fails when a suite dies without counting a failure", async (t) => {
  const { code, stdout } = await runAll(t, { fixture: "process.exit(3);\n", wrapper: wrapperSuite("") });
  assert.equal(code, 1);
  assert.match(stdout, /Fixture Tests exited with 3/);
  assert.match(stdout, /TESTS FAILED/);
});
