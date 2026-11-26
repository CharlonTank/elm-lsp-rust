#!/usr/bin/env node
/**
 * Stands in for the Elm compiler in the benchmark tests. Run from an Elm
 * project root, it "compiles" the project unless
 *   - a module contains the word BROKEN, or
 *   - a custom type has the variant AddedByBenchmark and no module has a
 *     branch for it, which mimics the compiler's missing-case error.
 *
 * FAKE_COMPILER_DELAY_MS makes it take that long, like a build that has work to do.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

function elmSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? elmSources(join(dir, entry.name))
      : entry.name.endsWith(".elm")
        ? [readFileSync(join(dir, entry.name), "utf-8")]
        : []
  );
}

await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_COMPILER_DELAY_MS ?? 0)));

const sources = elmSources("src");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (sources.some((text) => text.includes("BROKEN"))) {
  fail("SYNTAX PROBLEM: a module is broken");
}
const hasVariant = sources.some((text) => /^ +\| AddedByBenchmark$/m.test(text));
if (hasVariant && !sources.some((text) => /AddedByBenchmark[^\n]*->\s*Debug\.todo\s+"/.test(text))) {
  fail("MISSING PATTERNS: this `case` does not have a branch for AddedByBenchmark");
}
