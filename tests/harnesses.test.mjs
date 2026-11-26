/**
 * The per-harness registration instructions.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "fs";
import { join } from "path";
import { findHarness, harnesses, installAt, renderText } from "../mcp-wrapper/harnesses.mjs";
import { REPO, runNode } from "./support.mjs";

const CLI = join(REPO, "mcp-wrapper/cli.mjs");
const SERVER = join(REPO, "mcp-wrapper/index.mjs");

// The config block of `cli.mjs config <harness>`: the lines between the two headings around it.
function configBlock(text) {
  return text.split("Merge this into the file:\n\n")[1].split(/\n\n(Or run|Verify)/)[0];
}

test("config without a harness lists every harness", async () => {
  const { code, stdout } = await runNode(CLI, ["config"]);
  assert.equal(code, 0);
  for (const { id, name } of harnesses) {
    assert.match(stdout, new RegExp(`^  ${id}\\s+${name.replace(/[()]/g, "\\$&")}$`, "m"));
  }
  assert.deepEqual(
    harnesses.map((harness) => harness.id),
    ["claude-code", "codex", "copilot", "cursor", "opencode", "gemini-cli", "antigravity", "cline", "goose", "pi", "oh-my-pi", "aider"]
  );
});

test("every JSON entry parses and starts this checkout's server", async () => {
  for (const harness of harnesses.filter((harness) => harness.format === "json")) {
    const { code, stdout } = await runNode(CLI, ["config", harness.id]);
    assert.equal(code, 0, harness.id);

    const config = JSON.parse(configBlock(stdout));
    const entry = (config.mcpServers ?? config.mcp.servers)["elm-lsp"];
    const launch = Array.isArray(entry.command) ? entry.command : [entry.command, ...entry.args];
    assert.deepEqual(launch, ["node", SERVER], harness.id);
  }
});

test("Codex gets a TOML table and Goose a YAML extension", async () => {
  const codex = configBlock((await runNode(CLI, ["config", "codex"])).stdout);
  assert.equal(codex, `[mcp_servers.elm-lsp]\ncommand = "node"\nargs = ["${SERVER}"]`);

  const goose = configBlock((await runNode(CLI, ["config", "goose"])).stdout);
  assert.equal(
    goose,
    [
      "extensions:",
      "  elm-lsp:",
      "    name: elm-lsp",
      "    type: stdio",
      "    enabled: true",
      '    cmd: "node"',
      `    args: ["${SERVER}"]`,
      "    timeout: 300",
    ].join("\n")
  );
});

test("Aider is pointed at the command-line interface", async () => {
  const { stdout } = await runNode(CLI, ["config", "aider"]);
  assert.ok(stdout.includes(`/run node ${CLI} elm_references --file_path src/Main.elm --line 10 --character 4`), stdout);
  assert.ok(stdout.includes(`aider --read ${join(REPO, "skills/elm-refactoring/SKILL.md")}`), stdout);
});

test("a clone path with a space is quoted in shell commands and kept whole in config", () => {
  const install = installAt("/opt/my tools/elm-lsp-rust");

  const codex = renderText(findHarness("codex"), install);
  assert.ok(codex.includes(`args = ["/opt/my tools/elm-lsp-rust/mcp-wrapper/index.mjs"]`), codex);
  assert.ok(codex.includes(`codex mcp add elm-lsp -- node '/opt/my tools/elm-lsp-rust/mcp-wrapper/index.mjs'`), codex);

  // Aider's commands are typed into a shell as well
  const aider = renderText(findHarness("aider"), install);
  assert.ok(aider.includes(`/run node '/opt/my tools/elm-lsp-rust/mcp-wrapper/cli.mjs' doctor`), aider);
  assert.ok(aider.includes(`aider --read '/opt/my tools/elm-lsp-rust/skills/elm-refactoring/SKILL.md'`), aider);
});

test("a clone path with a backtick or a dollar sign in it is kept whole in the plain-text instructions", () => {
  // The Markdown of a sentence goes before the paths come in, or it takes the path's own backtick along.
  // And a path is put in as it is: "$&" and "$$" in it are no patterns of a replacement.
  for (const clone of ["/opt/my`tools/elm-lsp-rust", "/opt/my$&tools$$/elm-lsp-rust"]) {
    const aider = renderText(findHarness("aider"), installAt(clone));
    assert.ok(aider.includes(`/run node '${clone}/mcp-wrapper/cli.mjs' doctor`), aider);
    assert.ok(aider.includes(`aider --read '${clone}/skills/elm-refactoring/SKILL.md'`), aider);
  }
});

test("an unknown harness is a usage error that names the known ones", async () => {
  const { code, stderr } = await runNode(CLI, ["config", "emacs"]);
  assert.equal(code, 2);
  assert.match(stderr, /Unknown harness "emacs"\. Known: claude-code, codex, /);
});

test("docs/harnesses.md matches what the table renders", async () => {
  const { stdout } = await runNode(CLI, ["config", "--markdown"]);
  assert.equal(
    readFileSync(join(REPO, "docs/harnesses.md"), "utf-8"),
    stdout,
    "Regenerate with: node mcp-wrapper/cli.mjs config --markdown > docs/harnesses.md"
  );
});
