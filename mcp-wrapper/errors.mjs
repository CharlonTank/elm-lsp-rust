/**
 * A failure the caller can act on, such as a wrong position or a file
 * outside any Elm project. The message is the full text shown to the agent.
 * Any other thrown error is a bug in the wrapper or the language server.
 */
export class ToolError extends Error {}
