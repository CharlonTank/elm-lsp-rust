#!/usr/bin/env node
/**
 * Master test runner for elm-lsp-rust
 * Runs all test suites and updates coverage documentation
 */

import { spawn } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function runTest(scriptPath, name) {
  return new Promise((resolve) => {
    const child = spawn("node", [scriptPath], {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: dirname(scriptPath),
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("close", (code) => {
      // Parse results from output
      const passMatch = stdout.match(/Passed:\s*(\d+)/);
      const failMatch = stdout.match(/Failed:\s*(\d+)/);

      resolve({
        name,
        exitCode: code,
        passed: passMatch ? parseInt(passMatch[1]) : 0,
        failed: failMatch ? parseInt(failMatch[1]) : 0,
        output: stdout,
      });
    });

    child.on("error", (err) => {
      resolve({
        name,
        exitCode: 1,
        passed: 0,
        failed: 1,
        output: err.message,
      });
    });
  });
}

function updateCoverageFile(fixtureResults, meetdownResults) {
  const coveragePath = join(__dirname, "COVERAGE.md");
  let content = readFileSync(coveragePath, "utf-8");

  // Update test counts in summary
  const now = new Date().toISOString().split("T")[0];
  const totalPassed = fixtureResults.passed + meetdownResults.passed;
  const totalFailed = fixtureResults.failed + meetdownResults.failed;
  const totalTests = totalPassed + totalFailed;

  // Update the "Last updated" line with test results
  const statusLine = totalFailed === 0
    ? `*Last updated: ${now} - All ${totalTests} tests passing ✅*`
    : `*Last updated: ${now} - ${totalPassed}/${totalTests} tests passing (${totalFailed} failed) ⚠️*`;

  content = content.replace(
    /\*Last updated:.*\*/,
    statusLine
  );

  writeFileSync(coveragePath, content);
}

async function main() {
  console.log(`\n${BOLD}${"=".repeat(70)}${RESET}`);
  console.log(`${BOLD}  elm-lsp-rust Master Test Suite${RESET}`);
  console.log(`${BOLD}${"=".repeat(70)}${RESET}\n`);

  const fixtureTestPath = join(__dirname, "run_tests.mjs");
  const meetdownTestPath = join(__dirname, "test_meetdown_comprehensive.mjs");

  // Run fixture tests
  console.log(`${CYAN}Running fixture tests...${RESET}\n`);
  const fixtureResults = await runTest(fixtureTestPath, "Fixture Tests");

  console.log(`\n${CYAN}Running meetdown comprehensive tests...${RESET}\n`);
  const meetdownResults = await runTest(meetdownTestPath, "Meetdown Tests");

  // Update coverage file
  updateCoverageFile(fixtureResults, meetdownResults);

  // Final summary
  const totalPassed = fixtureResults.passed + meetdownResults.passed;
  const totalFailed = fixtureResults.failed + meetdownResults.failed;

  console.log(`\n${BOLD}${"=".repeat(70)}${RESET}`);
  console.log(`${BOLD}  Master Test Summary${RESET}`);
  console.log(`${BOLD}${"=".repeat(70)}${RESET}`);
  console.log(`\n  ${BOLD}Fixture Tests:${RESET}`);
  console.log(`    ${GREEN}Passed: ${fixtureResults.passed}${RESET}`);
  console.log(`    ${fixtureResults.failed > 0 ? RED : GREEN}Failed: ${fixtureResults.failed}${RESET}`);

  console.log(`\n  ${BOLD}Meetdown Tests:${RESET}`);
  console.log(`    ${GREEN}Passed: ${meetdownResults.passed}${RESET}`);
  console.log(`    ${meetdownResults.failed > 0 ? RED : GREEN}Failed: ${meetdownResults.failed}${RESET}`);

  console.log(`\n  ${BOLD}Total:${RESET}`);
  console.log(`    ${GREEN}Passed: ${totalPassed}${RESET}`);
  console.log(`    ${totalFailed > 0 ? RED : GREEN}Failed: ${totalFailed}${RESET}`);
  console.log(`    Tests:  ${totalPassed + totalFailed}`);

  if (totalFailed > 0) {
    console.log(`\n${RED}${"=".repeat(70)}${RESET}`);
    console.log(`${RED}  TESTS FAILED${RESET}`);
    console.log(`${RED}${"=".repeat(70)}${RESET}\n`);
    process.exit(1);
  } else {
    console.log(`\n${GREEN}${"=".repeat(70)}${RESET}`);
    console.log(`${GREEN}  ALL TESTS PASSED${RESET}`);
    console.log(`${GREEN}${"=".repeat(70)}${RESET}\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal error: ${err.message}${RESET}`);
  process.exit(1);
});
