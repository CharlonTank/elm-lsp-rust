/**
 * The command-line interface, for agents and scripts without an MCP client.
 * Run with: node --test tests/*.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { copyFixture, installLocalTool, installTool, REPO, runNode, tempDir } from "./support.mjs";

const CLI = join(REPO, "mcp-wrapper/cli.mjs");
const cli = (args, options) => runNode(CLI, args, options);

// A copy of the wrapper in a directory where the language server was never built.
function unbuiltCopy(t) {
  const root = tempDir(t);
  cpSync(join(REPO, "mcp-wrapper"), join(root, "mcp-wrapper"), {
    recursive: true,
    filter: (source) => !source.endsWith("node_modules"),
  });
  symlinkSync(join(REPO, "mcp-wrapper/node_modules"), join(root, "mcp-wrapper/node_modules"));
  return { cli: join(root, "mcp-wrapper/cli.mjs"), binary: join(root, "target/release/elm_lsp") };
}

test("tools lists every tool, and --json describes their arguments", async () => {
  const listing = await cli(["tools"]);
  assert.equal(listing.code, 0);
  assert.equal(listing.stdout.trim().split("\n").length, 22);
  assert.match(listing.stdout, /^elm_references\s+Find all references to a symbol across the project$/m);

  const described = JSON.parse((await cli(["tools", "--json"])).stdout);
  assert.equal(described.length, 22);
  assert.deepEqual(
    described.find((tool) => tool.name === "elm_symbols"),
    {
      name: "elm_symbols",
      description: "Get all symbols in an Elm file with optional pagination",
      readOnly: true,
      parameters: [
        { name: "file_path", type: "string", required: true, description: "Path to the Elm file" },
        { name: "offset", type: "number", required: false, description: "Number of symbols to skip (default: 0)" },
        {
          name: "limit",
          type: "number",
          required: false,
          description: "Maximum number of symbols to return (default: 50)",
        },
      ],
    }
  );
  const branches = described.find((tool) => tool.name === "elm_add_variant").parameters.find((p) => p.name === "branches");
  assert.equal(branches.type, "json");
});

test("a tool runs with flags, prints its result and exits", async (t) => {
  const project = copyFixture(t);

  // The elm_ prefix is optional, and a relative path resolves against the working directory
  const references = await cli(["references", "--file_path", "src/Utils.elm", "--line", "6", "--character", "0"], {
    cwd: project,
  });
  assert.deepEqual(references, {
    code: 0,
    stdout:
      [
        "Found 5 references:",
        `${project}/src/Main.elm:6:23`,
        `${project}/src/Main.elm:51:36`,
        `${project}/src/Utils.elm:1:23`,
        `${project}/src/Utils.elm:6:0`,
        `${project}/src/Utils.elm:18:4`,
      ].join("\n") + "\n",
    stderr: "",
  });
});

test("a refactoring tool writes its edits", async (t) => {
  const project = copyFixture(t);
  const utils = join(project, "src/Utils.elm");

  // --file-path and --file_path are the same argument
  const rename = await cli(
    ["elm_rename_function", "--file-path", utils, "--line", "16", "--character", "0", "--old_name", "helper", "--newName", "assist"],
    { cwd: tempDir(t) }
  );
  assert.equal(rename.code, 0, rename.stderr);
  assert.match(rename.stdout, /Renamed function "helper" to "assist"/);
  assert.match(readFileSync(utils, "utf-8"), /^assist name =$/m);
});

test("--args passes arguments that flags cannot express", async (t) => {
  const project = copyFixture(t);
  const main = join(project, "src/Main.elm");

  const args = { file_path: main, type_name: "Msg", new_variant_name: "Reset", branches: [{ AddCode: "{ model | count = 0 }" }] };
  const added = await cli(["elm_add_variant", "--args", JSON.stringify(args)]);
  assert.equal(added.code, 0, added.stderr);
  assert.match(readFileSync(main, "utf-8"), /Reset ->\n\s+\{ model \| count = 0 \}/);

  // The same nested value as one flag
  const again = await cli([
    "elm_add_variant",
    "--file_path", main,
    "--type_name", "Msg",
    "--new_variant_name", "Clear",
    "--branches", '["AddDebug"]',
  ]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(readFileSync(main, "utf-8"), /Clear ->\n\s+Debug\.todo/);
});

test("a tool that fails exits 1 with one line on stderr", async (t) => {
  const dir = tempDir(t);
  const stray = join(dir, "Stray.elm");
  writeFileSync(stray, "module Stray exposing (x)\n");

  const outsideAnyProject = await cli(["definition", "--file_path", stray, "--line", "0", "--character", "0"]);
  assert.deepEqual(outsideAnyProject, {
    code: 1,
    stdout: "",
    stderr: `No elm.json found in the parent directories of ${stray}\n`,
  });

  // The most likely mistake from a shell is a mistyped path
  const mistyped = await cli(["symbols", "--file_path", join(dir, "Starry.elm")]);
  assert.deepEqual(mistyped, { code: 1, stdout: "", stderr: `Cannot read ${join(dir, "Starry.elm")}: it does not exist\n` });
  const directory = await cli(["symbols", "--file_path", dir]);
  assert.deepEqual(directory, { code: 1, stdout: "", stderr: `Cannot read ${dir}: it is not a file\n` });
});

test("--project-tools lets the CLI use the tools in the project's node_modules", async (t) => {
  const project = copyFixture(t);
  installLocalTool(project, "elm-format", 'echo formatted > "$(dirname "$0")/ran"');
  const globalBin = tempDir(t);
  installTool(globalBin, "elm-format", "exit 0");
  const env = { ...process.env, PATH: `${globalBin}:/usr/bin:/bin` };
  const ran = join(project, "node_modules/.bin/ran");
  const format = ["elm_format", "--file_path", join(project, "src/Main.elm")];

  assert.equal((await cli(format, { env })).code, 0);
  assert.equal(existsSync(ran), false, "the global elm-format ran");
  // The flag may stand before or after the command
  assert.equal((await cli([...format, "--project-tools"], { env })).code, 0);
  assert.equal(existsSync(ran), true, "the project's elm-format ran");
});

test("a wrong command line exits 2 and says what is wrong", async () => {
  const cases = [
    [["nope"], /Unknown command "nope"/],
    [["symbols", "--wat", "1"], /elm_symbols has no argument --wat\. It takes: file_path, offset, limit/],
    [["symbols", "src/Main.elm"], /Expected --<argument>, got "src\/Main\.elm"/],
    [["symbols", "--file_path"], /--file_path needs a value/],
    [["definition", "--file_path", "a.elm", "--line", "x", "--character", "0"], /--line takes a whole number, got "x"/],
    // Number() would read these three as 16, 100 and 2.5
    [["definition", "--file_path", "a.elm", "--line", "0x10", "--character", "0"], /--line takes a whole number, got "0x10"/],
    [["definition", "--file_path", "a.elm", "--line", "1e2", "--character", "0"], /--line takes a whole number, got "1e2"/],
    [["definition", "--file_path", "a.elm", "--line", "1", "--character", "2.5"], /--character takes a whole number, got "2\.5"/],
    [["definition", "--args", '{"file_path":"a.elm","line":-1,"character":2.5}'], /Invalid arguments for elm_definition:\n  line: .*\n  character: Expected integer, received float/],
    [["definition", "--file_path", "a.elm"], /Invalid arguments for elm_definition:\n  line: Required\n  character: Required/],
    [["symbols", "--args", "[1]"], /--args takes a JSON object/],
    [["add_variant", "--branches", "{oops"], /--branches takes JSON/],
  ];
  for (const [args, message] of cases) {
    const result = await cli(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  }
});

test("help describes the commands and each tool's arguments", async () => {
  for (const args of [[], ["--help"]]) {
    const usage = await cli(args);
    assert.equal(usage.code, 0);
    assert.ok(usage.stdout.startsWith(`Usage: node ${CLI} <command>`), usage.stdout);
  }

  const toolHelp = await cli(["rename_function", "--help"]);
  assert.equal(toolHelp.code, 0);
  assert.match(toolHelp.stdout, /^elm_rename_function: Rename a function across the entire project\./);
  assert.match(toolHelp.stdout, /--newName <string>\n\s+The new name for the function/);
});

test("doctor passes on a built checkout", async (t) => {
  const { code, stdout } = await cli(["doctor"], { cwd: tempDir(t) });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /^ok\s+node\s+v\d+/m);
  assert.match(stdout, /^ok\s+language server\s+.*elm_lsp$/m);
  assert.match(stdout, /^(ok|warn)\s+elm compiler\s/m);
  assert.match(stdout, /^(ok|warn)\s+elm-format\s/m);
});

test("doctor fails when the language server is not built", async (t) => {
  const { cli } = unbuiltCopy(t);

  const { code, stdout } = await runNode(cli, ["doctor"]);
  assert.equal(code, 1);
  assert.match(stdout, /^fail\s+language server\s+.*elm_lsp is missing\. Run scripts\/setup\.sh to build it\.$/m);
});

test("a tool says in one line why the language server did not start", async (t) => {
  const { cli, binary } = unbuiltCopy(t);
  const file = join(copyFixture(t), "src/Types.elm");

  const missing = await runNode(cli, ["symbols", "--file_path", file]);
  assert.deepEqual(missing, {
    code: 1,
    stdout: "",
    stderr: `Rust LSP binary not found at ${binary}. Run scripts/setup.sh to build it.\n`,
  });

  // A file that is there but cannot be executed
  mkdirSync(join(binary, ".."), { recursive: true });
  writeFileSync(binary, "not a program\n");
  const notExecutable = await runNode(cli, ["symbols", "--file_path", file]);
  assert.equal(notExecutable.code, 1);
  assert.match(notExecutable.stderr, new RegExp(`^Could not start ${binary}: spawn .*EACCES\\n$`));

  // A program that exits before it answers
  writeFileSync(binary, "#!/bin/sh\nexit 3\n");
  chmodSync(binary, 0o755);
  const exitsEarly = await runNode(cli, ["symbols", "--file_path", file]);
  assert.deepEqual(exitsEarly, { code: 1, stdout: "", stderr: "LSP process exited with code 3\n" });
});
