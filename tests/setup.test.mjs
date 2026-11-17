/**
 * scripts/setup.sh, run against a scratch installation with stand-ins for
 * cargo and npm that only record how they were called.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { installTool, REPO, tempDir } from "./support.mjs";

const BINARY = "target/release/elm_lsp";
const BUILT_AT = 1_000_000;

// An installation whose binary is newer than everything it is built from.
function installation(t) {
  const root = tempDir(t);
  const write = (file, seconds) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
    utimesSync(join(root, file), seconds, seconds);
  };
  write("src/main.rs", BUILT_AT - 10);
  write("Cargo.toml", BUILT_AT - 10);
  write("Cargo.lock", BUILT_AT - 10);
  write(BINARY, BUILT_AT);
  mkdirSync(join(root, "mcp-wrapper/node_modules"), { recursive: true });
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });

  // Stand-ins that note their working directory and arguments
  const bin = join(root, "fake-bin");
  const calls = join(root, "calls.log");
  installTool(bin, "cargo", `echo "cargo $* in $PWD" >> "${calls}"\nexit \${CARGO_EXIT:-0}`);
  installTool(bin, "npm", `echo "npm $* in $PWD" >> "${calls}"`);

  const setup = (env = {}) =>
    new Promise((resolve) => {
      execFile(join(root, "scripts/setup.sh"), { env: { PATH: `${bin}:/usr/bin:/bin`, ...env } }, (error) => {
        const log = existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n") : [];
        rmSync(calls, { force: true });
        resolve({ code: error ? error.code : 0, calls: log });
      });
    });
  const touch = (file) => utimesSync(join(root, file), BUILT_AT + 10, BUILT_AT + 10);
  return { root, setup, touch };
}

test("an up-to-date installation is left alone", async (t) => {
  const { setup } = installation(t);
  assert.deepEqual(await setup(), { code: 0, calls: [] });
});

test("the server is rebuilt when a source, the manifest or the lockfile is newer than the binary", async (t) => {
  for (const changed of ["src/main.rs", "Cargo.toml", "Cargo.lock"]) {
    const { root, setup, touch } = installation(t);
    touch(changed);
    assert.deepEqual(await setup(), { code: 0, calls: [`cargo build --release --locked in ${root}`] }, changed);
  }
});

test("a missing binary is built, and missing dependencies are installed from the lockfile", async (t) => {
  const { root, setup } = installation(t);
  rmSync(join(root, BINARY));
  rmSync(join(root, "mcp-wrapper/node_modules"), { recursive: true });

  assert.deepEqual(await setup(), {
    code: 0,
    calls: [`cargo build --release --locked in ${root}`, `npm ci --ignore-scripts in ${join(root, "mcp-wrapper")}`],
  });
});

test("the Claude Code plugin's root wins over the script's own location", async (t) => {
  const plugin = installation(t);
  const elsewhere = installation(t);
  rmSync(join(plugin.root, BINARY));

  // The script of one installation, told to set up the other
  const { calls } = await elsewhere.setup({ CLAUDE_PLUGIN_ROOT: plugin.root });
  assert.deepEqual(calls, [`cargo build --release --locked in ${plugin.root}`]);
});

test("a failed build fails the setup", async (t) => {
  const { root, setup } = installation(t);
  rmSync(join(root, BINARY));
  rmSync(join(root, "mcp-wrapper/node_modules"), { recursive: true });

  const result = await setup({ CARGO_EXIT: "101" });
  assert.equal(result.code, 101);
  // npm is not reached once the build has failed
  assert.deepEqual(result.calls, [`cargo build --release --locked in ${root}`]);
});
