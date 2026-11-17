# Install with your agent

This page is written for a coding agent. Clone the repository, then give your agent a prompt like this one:

```
Read docs/agent-install.md in /path/to/elm-lsp-rust and follow it to set up
the Elm tools for the harness you are running in.
```

## Steps for the agent

Run every command from the root of the clone.

1. Check the requirements. `cargo --version` must find a Rust toolchain and `node --version` must print 18 or newer. If either is missing, stop and tell the user what to install.

2. Build.

   ```sh
   scripts/setup.sh
   ```

   It builds the language server with `cargo build --release --locked` and does nothing when the build is current.

3. Check the installation.

   ```sh
   node mcp-wrapper/cli.mjs doctor
   ```

   A line that starts with `fail` must be fixed before you go on. A line that starts with `warn` names an optional tool. Navigation and refactoring work without it.

4. Find the name of your harness.

   ```sh
   node mcp-wrapper/cli.mjs config
   ```

5. Print the registration for that harness and apply it.

   ```sh
   node mcp-wrapper/cli.mjs config <harness>
   ```

   The output names the config file for each scope, the entry to merge into it, and for most harnesses a single command that does the same. Prefer the project file when the output lists one. Ask the user before you change a file in their home directory, and merge the entry into the existing file instead of replacing it.

   If your harness is not listed and has an MCP client, register a stdio server whose command is `node` and whose only argument is the absolute path of `mcp-wrapper/index.mjs`. If it has no MCP client, skip this step and call `mcp-wrapper/cli.mjs` from the shell.

6. Give the harness the skill. Copy `skills/elm-refactoring` into the Elm project's skills directory: `.claude/skills/` for Claude Code, `.agents/skills/` for most other harnesses. The Claude Code plugin already includes it.

7. Reload the harness's MCP servers, or ask the user to restart the session. Then run the check that step 5 printed under `Verify`, and call `elm_symbols` with the absolute path of any `.elm` file.

## Options

Append these to the server's arguments in the config entry.

- `--read-only` offers only the nine tools that never change a file. Use it when the harness approves every tool call without asking.
- `--elm-projects-only` makes the server exit at once unless its working directory, or a direct child of it, holds an `elm.json`. Use it for a user-level registration when the Elm tools should stay out of other projects. In those projects the harness lists the server as not connected.
