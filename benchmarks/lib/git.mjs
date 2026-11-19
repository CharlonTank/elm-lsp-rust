/**
 * How the benchmark runs git: in a codebase and in this checkout alike, with
 * settings and an environment of its own in place of the operator's where
 * those would change what git does or prints.
 */

// The repository's hooks are the operator's. A checkout made for a session must not set them off.
// A path is printed as it is, where git would put one with other than ASCII letters in quotes.
// And a file that was written again with the bytes it had is no change. Without a refresh of the
// index, git lists such a file as changed until something else, a "git status", refreshes it.
// A blank line of context in a patch starts with a space, as every other line of context does.
// "git diff" has no switch for that.
export const OWN_SETTINGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false", "-c", "diff.autoRefreshIndex=true", "-c", "diff.suppressBlankEmpty=false"];

// GIT_DIFF_OPTS sets how many lines of context a patch has, and git takes it over --unified. The
// GIT_*_PATHSPECS variables change how git reads a pathspec. With one of them, "*.elm" names no
// file in a directory, or also one that ends in ".ELM". The benchmark's own git goes without all
// of them. A session's shell keeps them, as it keeps the rest of the operator's environment.
export function ownEnvironment() {
  const { GIT_DIFF_OPTS, GIT_LITERAL_PATHSPECS, GIT_GLOB_PATHSPECS, GIT_NOGLOB_PATHSPECS, GIT_ICASE_PATHSPECS, ...environment } = process.env;
  return environment;
}
