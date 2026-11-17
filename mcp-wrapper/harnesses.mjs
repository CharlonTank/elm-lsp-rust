/**
 * How each coding-agent harness registers this server.
 *
 * `cli.mjs config <harness>` and docs/harnesses.md are both rendered from the
 * table below, so the two cannot drift apart. Every harness except Aider runs
 * the same stdio MCP server. Only the config file and its syntax differ.
 */

// Name under which the server is registered. Harnesses prefix tool names with
// it, for example mcp__elm-lsp__elm_references.
const SERVER_NAME = "elm-lsp";

// Where one clone of this repository keeps the files a harness needs.
export function installAt(root) {
  return {
    command: "node",
    server: `${root}/mcp-wrapper/index.mjs`,
    cli: `${root}/mcp-wrapper/cli.mjs`,
    skill: `${root}/skills/elm-refactoring/SKILL.md`,
  };
}

const mcpServers = (entry) => ({ mcpServers: { [SERVER_NAME]: entry } });

function shellQuote(word) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

const shell = (...words) => words.map(shellQuote).join(" ");

/**
 * @typedef {object} Harness
 * @property {string} id       Argument of `cli.mjs config`
 * @property {string} name
 * @property {string} docs     The harness's own MCP documentation
 * @property {{ project?: string, user?: string }} [files]  Config file per scope
 * @property {"json" | "toml" | "yaml"} [format]
 * @property {(install: ReturnType<typeof installAt>) => object | string} [config]
 *   What to put in the config file. An object is printed as JSON.
 * @property {(install: ReturnType<typeof installAt>) => string} [add]
 *   Shell command that registers the server without editing a file
 * @property {(install: ReturnType<typeof installAt>) => string} [run]
 *   For a harness without MCP: how to call a tool through the CLI
 * @property {string} verify   How to see that the server is connected
 * @property {string[]} [notes]
 *
 * `verify` and `notes` may contain {cli} and {skill}, which stand for the
 * paths of this install.
 */

/** @type {Harness[]} */
export const harnesses = [
  {
    id: "claude-code",
    name: "Claude Code",
    docs: "https://code.claude.com/docs/en/mcp",
    files: { project: ".mcp.json", user: "~/.claude.json" },
    format: "json",
    config: ({ command, server }) => mcpServers({ command, args: [server] }),
    add: ({ command, server }) => `claude mcp add --scope user ${SERVER_NAME} -- ${shell(command, server)}`,
    verify: "Run `claude mcp list`, or `/mcp` inside a session.",
    notes: [
      "The Claude Code plugin is an alternative. It registers the server and the skill in one step: " +
        "`/plugin marketplace add CharlonTank/elm-lsp-plugin`, then `/plugin install elm-lsp-rust@CharlonTank/elm-lsp-plugin`.",
    ],
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    docs: "https://learn.chatgpt.com/docs/extend/mcp",
    files: { project: ".codex/config.toml", user: "~/.codex/config.toml" },
    format: "toml",
    config: ({ command, server }) =>
      [`[mcp_servers.${SERVER_NAME}]`, `command = ${JSON.stringify(command)}`, `args = ${JSON.stringify([server])}`].join("\n"),
    add: ({ command, server }) => `codex mcp add ${SERVER_NAME} -- ${shell(command, server)}`,
    verify: "Run `codex mcp list`, or `/mcp` inside a session.",
    notes: [
      "Codex reads the project file only in trusted projects.",
      "Codex starts MCP servers with a reduced environment. `PATH` is passed on. List anything else the Elm compiler needs under `env_vars`.",
    ],
  },
  {
    id: "copilot",
    name: "GitHub Copilot (CLI and VS Code)",
    docs: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
    files: { project: ".mcp.json", user: "~/.copilot/mcp-config.json" },
    format: "json",
    config: ({ command, server }) => mcpServers({ type: "local", command, args: [server], tools: ["*"] }),
    add: ({ command, server }) => `copilot mcp add ${SERVER_NAME} -- ${shell(command, server)}`,
    verify: "Run `copilot mcp list`. In VS Code, run **MCP: List Servers** from the Command Palette.",
    notes: [
      "VS Code's older Local harness reads `.vscode/mcp.json` instead. There the top-level key is `servers` and the entry has no `tools` field.",
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    docs: "https://cursor.com/docs/context/mcp",
    files: { project: ".cursor/mcp.json", user: "~/.cursor/mcp.json" },
    format: "json",
    config: ({ command, server }) => mcpServers({ type: "stdio", command, args: [server] }),
    verify: "Run `agent mcp list`, or open **Customize** in the editor sidebar.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    docs: "https://opencode.ai/docs/mcp-servers/",
    files: { project: "opencode.json", user: "~/.config/opencode/opencode.json" },
    format: "json",
    config: ({ command, server }) => ({
      $schema: "https://opencode.ai/config.json",
      mcp: { servers: { [SERVER_NAME]: { type: "local", command: [command, server] } } },
    }),
    add: ({ command, server }) => `opencode mcp add ${SERVER_NAME} -- ${shell(command, server)}`,
    verify: "Run `opencode mcp list`.",
    notes: [
      `OpenCode 1.x has no \`servers\` level. Put the \`${SERVER_NAME}\` entry directly under \`mcp\`, and use the file instead of \`opencode mcp add\`, which is interactive there.`,
    ],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    docs: "https://geminicli.com/docs/tools/mcp-server/",
    files: { project: ".gemini/settings.json", user: "~/.gemini/settings.json" },
    format: "json",
    config: ({ command, server }) => mcpServers({ command, args: [server] }),
    add: ({ command, server }) => `gemini mcp add --scope user ${SERVER_NAME} ${shell(command, server)}`,
    verify: "Run `gemini mcp list`, or `/mcp` inside a session.",
  },
  {
    id: "antigravity",
    name: "Google Antigravity",
    docs: "https://antigravity.google/docs/mcp",
    files: { project: ".agents/mcp_config.json", user: "~/.gemini/config/mcp_config.json" },
    format: "json",
    config: ({ command, server }) => mcpServers({ command, args: [server] }),
    verify: "Run `/mcp` in the CLI, or open **MCP Servers** from the **…** menu of the IDE's agent panel.",
  },
  {
    id: "cline",
    name: "Cline",
    docs: "https://docs.cline.bot/mcp/configuring-mcp-servers",
    files: { user: "~/.cline/data/settings/cline_mcp_settings.json" },
    format: "json",
    config: ({ command, server }) => mcpServers({ command, args: [server], disabled: false, autoApprove: [] }),
    add: ({ command, server }) => `cline mcp add ${SERVER_NAME} --yes -- ${shell(command, server)}`,
    verify: "Run `cline config mcp`, or open the **MCP Servers** panel of the extension.",
    notes: ["In the extension, **MCP Servers** > **Configure** > **Configure MCP Servers** opens the file."],
  },
  {
    id: "goose",
    name: "Goose",
    docs: "https://goose-docs.ai/docs/getting-started/using-extensions",
    files: { user: "~/.config/goose/config.yaml" },
    format: "yaml",
    config: ({ command, server }) =>
      [
        "extensions:",
        `  ${SERVER_NAME}:`,
        `    name: ${SERVER_NAME}`,
        "    type: stdio",
        "    enabled: true",
        `    cmd: ${JSON.stringify(command)}`,
        `    args: ${JSON.stringify([server])}`,
        "    timeout: 300",
      ].join("\n"),
    add: ({ command, server }) => `goose session --with-extension ${shellQuote(shell(command, server))}`,
    verify: "Run `goose info -v`.",
    notes: [
      "The command above adds the server to one session only. Edit the file, or run `goose configure` and pick **Add Extension** > **Command-Line Extension**, to keep it.",
    ],
  },
  {
    id: "pi",
    name: "Pi",
    docs: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md",
    files: { project: ".pi/mcp.json", user: "~/.pi/agent/mcp.json" },
    format: "json",
    config: ({ command, server }) => mcpServers({ command, args: [server] }),
    add: ({ command, server }) => `pi mcp add ${SERVER_NAME} -- ${shell(command, server)}`,
    verify: "Run `pi mcp list`, or `/mcp` inside a session.",
    notes: [
      'Pi calls MCP tools from codemode scripts by default. Add `"exposure": "direct"` to the entry to declare them to the model like built-in tools.',
    ],
  },
  {
    id: "oh-my-pi",
    name: "Oh My Pi",
    docs: "https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md",
    files: { project: ".omp/mcp.json", user: "~/.omp/agent/mcp.json" },
    format: "json",
    config: ({ command, server }) => mcpServers({ type: "stdio", command, args: [server] }),
    verify: "Run `/mcp list` inside a session.",
    notes: ["Oh My Pi also picks up servers that Claude Code, Codex, Gemini CLI, OpenCode or Cursor already have configured."],
  },
  {
    id: "aider",
    name: "Aider",
    docs: "https://aider.chat/docs/usage/commands.html",
    run: ({ command, cli }) =>
      `/run ${shell(command, cli)} elm_references --file_path src/Main.elm --line 10 --character 4`,
    verify: "Run `/run node {cli} doctor` inside a session.",
    notes: [
      "Aider has no MCP client, so it uses the command-line interface. `/run` executes a command and offers to add its output to the chat.",
      "Load the tool reference as read-only context with `aider --read {skill}`.",
    ],
  },
];

export function findHarness(id) {
  return harnesses.find((harness) => harness.id === id);
}

// The parts of one harness's instructions, with this install's paths filled in.
function instructions(harness, install) {
  const fill = (text) => text.replaceAll("{cli}", install.cli).replaceAll("{skill}", install.skill);
  const config = harness.config?.(install);
  return {
    files: Object.entries(harness.files || {}),
    config: typeof config === "object" ? JSON.stringify(config, null, 2) : config,
    add: harness.add?.(install),
    run: harness.run?.(install),
    verify: fill(harness.verify),
    notes: (harness.notes || []).map(fill),
  };
}

// Instructions for one harness as plain text, for a terminal or an agent.
export function renderText(harness, install) {
  const { files, config, add, run, verify, notes } = instructions(harness, install);
  const plain = (markdown) => markdown.replaceAll("**", "").replaceAll("`", "");
  const lines = [harness.name, ""];

  if (config) {
    lines.push("Config file", ...files.map(([scope, path]) => `  ${scope}: ${path}`), "");
    lines.push("Merge this into the file:", "", config, "");
  }
  if (add) {
    lines.push("Or run:", "", `  ${add}`, "");
  }
  if (run) {
    lines.push("Call a tool from the chat:", "", `  ${run}`, "");
  }

  lines.push(`Verify: ${plain(verify)}`, ...notes.map((note) => `Note: ${plain(note)}`), `Docs: ${harness.docs}`);
  return lines.join("\n");
}

function markdownSection(harness, install) {
  const { files, config, add, run, verify, notes } = instructions(harness, install);
  const lines = [`## ${harness.name}`, "", `With your paths filled in: \`node mcp-wrapper/cli.mjs config ${harness.id}\``, ""];

  if (config) {
    lines.push(...files.map(([scope, path]) => `- ${scope}: \`${path}\``), "");
    lines.push("```" + harness.format, config, "```", "");
  }
  if (add) {
    lines.push("Or run:", "", "```sh", add, "```", "");
  }
  if (run) {
    lines.push("```", run, "```", "");
  }

  lines.push(verify, "", ...notes.flatMap((note) => [note, ""]), `Source: <${harness.docs}>`);
  return lines.join("\n");
}

// GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens.
function anchor(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-");
}

// The content of docs/harnesses.md, with a placeholder where the clone lives.
export function renderMarkdown() {
  const install = installAt("/ABS/PATH/elm-lsp-rust");
  const intro = [
    "# Harness configuration",
    "",
    "<!-- Generated by `node mcp-wrapper/cli.mjs config --markdown`. Edit mcp-wrapper/harnesses.mjs, then regenerate. -->",
    "",
    `Every harness below runs the same server, \`${install.command} ${install.server}\`.`,
    "Replace `/ABS/PATH` with the directory that holds your clone, or run `node mcp-wrapper/cli.mjs config <harness>`",
    "to print the entry with the path filled in.",
    "",
    "If a harness reports that it cannot find `node`, replace `node` with the output of `command -v node`.",
    "Editors started from a desktop launcher often do not see the `PATH` of your shell.",
    "",
    ...harnesses.map((harness) => `- [${harness.name}](#${anchor(harness.name)})`),
  ];

  return [intro.join("\n"), ...harnesses.map((harness) => markdownSection(harness, install))].join("\n\n") + "\n";
}
