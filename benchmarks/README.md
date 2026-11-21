# Benchmark: Elm refactoring with and without the language server

Does a coding agent get Elm refactorings right more often, faster or cheaper when it can call this language server? This benchmark runs the same tasks twice, once with the server's MCP tools and once without, and compares.

It runs on any Elm codebase you point it at. Nothing about a codebase is written into this repository. The plan, the transcripts and the run records stay in the output directory, and the report shows counts and measurements only.

## Before your first run

- `run` needs the Claude Code CLI on `PATH`, signed in, a `ps` that lists the machine's processes and, for the `lsp` arm, the language server built with `scripts/setup.sh`. [What a run looks like](#what-a-run-looks-like) has the details.
- Every session that `run` starts costs what the API charges for it, about `--max-budget-usd` each at most, since a session can go past its limit by the turn that crosses it. Try one task in one arm first, with `--only` and `--arms`, as [What a run looks like](#what-a-run-looks-like) shows.
- Each session works in a `git worktree` of its own and not in your checkout, though the paths under `link` are your own directories. The benchmark's own git commands add nothing to your repository but those worktrees, which they remove again. They skip its hooks and stage nothing, and the benchmark never prunes your repository's list of worktrees. A session runs shell commands without asking, so run the benchmark on code you trust. [What a session can touch](#what-a-session-can-touch) says what a session shares with your repository.
- The plan, the transcripts, the records, `run.json` and the report go into the output directory. The checkouts lie among the system's temporary files, and Claude Code can keep the output of a session's tools under `~/.claude/projects/`, as [What a session can touch](#what-a-session-can-touch) says.
- What a codebase and its check command have to be is in [The config](#the-config) and the [check command rules](#check-command-rules). What a run cannot measure is in [What it does not tell you](#what-it-does-not-tell-you).

## What a run looks like

```bash
mkdir -p benchmarks/out
cp benchmarks/config.example.json benchmarks/out/config.json    # then edit it
node benchmarks/bench.mjs plan   --config benchmarks/out/config.json --out benchmarks/out
node benchmarks/bench.mjs run    --config benchmarks/out/config.json --out benchmarks/out --repeat 3
node benchmarks/bench.mjs report --out benchmarks/out
open benchmarks/out/report.html
```

git ignores `benchmarks/out/`, so a config kept there, which names your codebases and where they are, stays out of this repository like everything else about them.

`run` needs the [Claude Code](https://claude.com/claude-code) CLI on `PATH`, signed in, and a `ps` that lists the machine's processes. While sessions of the `lsp` arm are left to do, it also needs the language server built with `scripts/setup.sh`. It uses `claude-opus-5-5` unless `--model` names another model, at the effort that Claude Code picks for that model unless `--effort` names `low`, `medium`, `high`, `xhigh` or `max`. With `--effort`, every session gets that level as `--effort` and as `CLAUDE_CODE_EFFORT_LEVEL`, which takes precedence in a session. Without it, a session gets neither, whatever your shell sets, and no session gets the `MAX_THINKING_TOKENS` of your shell. `node benchmarks/bench.mjs --help` lists every option.

Each session is a Claude Code session that the API charges for. It stops once it has spent `--max-budget-usd`, 5 dollars unless set, or run for `--timeout-min`, 20 minutes unless set. `run` starts one session per task, arm and repetition, and before them the one short session of the isolation check in [Keeping your own setup out](#keeping-your-own-setup-out). `plan` and `report` start no session. To try a run small first, `--only rename-function` runs the tasks of that type alone, and `--arms baseline` runs one arm.

What `run` holds a run to, and how it resumes:

- `run` takes a plan only from the state of the benchmark's code that made it, and asks for a new plan after a change to that code.
- `run` can be stopped and started again. It keeps the record of every finished session and runs only the ones that are missing.
- Every session starts from the commit the plan was made on, even when `ref` has moved since.
- The first `run` writes its model, its effort, its two limits, the version of Claude Code that its first session reported and the state of the benchmark's own code to `<out>/run.json`, and a later one that differs is refused, because its sessions would be compared with the ones on record. A run without `--effort` is held to Claude Code's default, so a later one with `--effort` is refused as well. A run with sessions of the `lsp` arm left to do writes the language server's version with the state of its sources there as well. A later run is held to that server from the first recorded session of the `lsp` arm on. A run before that is held to none, and so is a run after a run of the `lsp` arm that recorded nothing, as when its first session lost the API. A run with no session of the `lsp` arm left to do needs no server. It is not checked against one, and it leaves the server in `run.json` as it is, so the lsp sessions of a later run are still held to it.
- Claude Code can update itself between two runs and while one is under way. A session that reports another version than the run began with stops the run, so keep one version installed until a run is done. Every session starts with `DISABLE_AUTOUPDATER=1` in its environment. Claude Code's documentation says that the variable turns off its automatic updates in the background while `claude update` still works. It also says that a Homebrew installation does not update itself. The documentation puts the variable in the `env` of `settings.json`, which a session does not read, so the benchmark sets it for each session.
- The state of the code is the last commit that changed `benchmarks/bench.mjs`, `benchmarks/lib/` or one of the modules of `mcp-wrapper/` that the benchmark imports, `doctor.mjs`, `errors.mjs`, `harnesses.mjs`, `lsp-client.mjs` and `workspace.mjs`, with a digest of what is not committed there. The state of the language server's sources is read the same way.
- A run is not held to the time the server's binary was built, because `run` does not start the `lsp` arm with a binary that is older than the files that cargo lists beside it as its sources, so a build of the same sources is the same server. That check reads the Rust sources alone. A change to `Cargo.toml` or `Cargo.lock` that was not built is not seen, so run `scripts/setup.sh` after one. `run` also refuses the `lsp` arm where cargo's list is missing, or names no file that is still there, as after the checkout was moved, because then nobody knows what the binary was built from. `scripts/setup.sh` writes that list.
- Before the isolation check and the first session, a run with lsp sessions left starts the binary once and asks it what every tool call asks, as `node mcp-wrapper/cli.mjs doctor` does. It stops with the doctor's report when a check there fails. It then starts the MCP server the way a session of the arm gets it, the same command with the same environment, and asks it for its tools. A server that does not start, does not answer within ten seconds or lists no tool stops the run before the isolation check, since a `node` on `PATH` that is too old for the wrapper would otherwise cost every session of the arm. The wrapper starts the binary only at a session's first tool call, so a binary that cannot start would make each session of the arm a baseline whose tool calls fail. An `elm` or `elm-format` that is missing from `PATH` is a warning there and does not stop the run, since a codebase can pin its own.
- Each session of the `lsp` arm starts the server afresh from this checkout, so leave the checkout as it is while a run goes on. Build nothing there, and edit neither the server's sources nor `mcp-wrapper/`. `run` checks the server again before each of those sessions and once each has ended, since the wrapper starts the binary at a session's first tool call and again after ten idle minutes. A difference from the server it began with stops the run without a record for the session that was about to start or had just ended, and leaves no transcript or patch of it.
- A config whose `elmRoot`, `check`, `checkTimeoutMs` or `link` is no longer what the plan was made with is refused as well, since the prompts name the check command and its time limit decides whether a slow build passes.
- To plan again, use a new output directory: `plan` refuses one that holds records, because they are matched to tasks by name.

## The config

```json
{
  "codebases": [
    {
      "label": "My app",
      "repo": "/absolute/path/to/repository",
      "elmRoot": ".",
      "ref": "HEAD",
      "check": ["./node_modules/.bin/elm", "make", "src/Main.elm", "--output=/dev/null"],
      "link": ["node_modules"]
    }
  ]
}
```

| Key | Meaning |
|-----|---------|
| `label` | The name the plan and the report use for this codebase. It names files in the output directory too, so two labels have to differ in more than upper and lower case |
| `repo` | A git repository. A relative path is relative to the config file |
| `elmRoot` | The directory with `elm.json`, relative to `repo`. Default `.`, the repository's root. On a file system that ignores letter case, `Client` for a directory `client` is read as the disk spells it, and so is each source directory of `elm.json` |
| `ref` | The commit to benchmark. Default `HEAD`. Uncommitted changes are never part of a run |
| `check` | A command, run in `elmRoot`, that succeeds when the project compiles. The [check command rules](#check-command-rules) say what it has to name and what it must not name or write |
| `link` | Untracked paths under `elmRoot` that a fresh checkout needs, usually `node_modules`. Each one is linked, not copied, so a session that installs packages changes your directory. A path that holds Elm sources of the project is refused, because a session would edit your files through it. So is a path outside `elmRoot` or behind a link that leads out of it, because its place in a checkout would not be in the checkout. So is `elm-stuff`, or a path in it, because every session's builds would write your own compiler cache through the link and sessions that run at the same time would share one. Each checkout builds its own. On a file system that ignores letter case, each path is read as the disk spells it, so `Elm-Stuff` is refused like `elm-stuff` |
| `checkTimeoutMs` | How long one run of `check` may take, in milliseconds. Default 600000, which is ten minutes. A run that takes longer counts as a check that fails |

Every source directory of `elm.json` has to lie inside `elmRoot`. The benchmark reads a session's changes from git in the whole checkout, and a change to a tracked file beside `elmRoot`, a README or a script of the repository, counts against the session like any change it was not asked for.

## Check command rules

- It has to name the Elm files it compiles, as `src/Main.elm` above, because the benchmark works out from them which modules the compiler reads. Each of them has to be a word of its own. One that is named inside a longer word, as in the script of `["sh", "-c", "elm make src/Main.elm"]`, does not count.
- It must not pass `--optimize`, which rejects the `Debug.todo` one task asks for.
- It must name no path inside the repository by its whole path, also behind an option such as `--output=`, in the script of `sh -c` and through a link that leads into the repository, to a file that does not exist yet as well, because a session works in a checkout of its own and the command would run or write your copy. The benchmark tells a directory by what it is, so a path in another letter case on a file system that ignores case, one with an accented name in the other Unicode form, or one under `/System/Volumes/Data` on macOS is refused like the plain one. Name the compiler as `./node_modules/.bin/elm` and list `node_modules` under `link`.
- It must write no file that the repository holds, a committed bundle for instance. A changed file of that kind counts against a session, so a session that ran the command would be judged differently from one that did not, and `plan` stops when the command writes such a file, also when it writes the bytes that are there. A build that writes its output only once the sources have changed, as `make` does, is not caught that way, so make sure of it yourself.
- It must write no Elm source either, whatever the text, because such a file counts against a session in the same way. A generated module can hold a digest of another module or what `git describe --dirty` prints, and then a session's edits change it and an unchanged checkout does not. `plan` stops when the first build of a fresh checkout writes an Elm file, and when a second build of the unchanged checkout writes one that the first did not. So a project whose check command generates Elm sources cannot be benchmarked. Commit what the generator writes, and leave the generator out of `check`. `--output=/dev/null` writes none.
- The benchmark reads the words of the command and cannot see a path that a script builds as it runs, from `$HOME` or `~` for one, or a path in a script file that the command names, so make sure that none of those leads into the repository.
- It reads a path with a space in it, as under a directory called `My Projects`, also behind an option and in the script of `sh -c`, where the shell needs such a path in quotes. It does not see a space written as `\ `, a path whose quotes end in the middle of it, as in `--output="/x/My Stuff"/app/x.js`, or a path behind `@`, as in `@/x/app/args.txt`, so make sure of such a path yourself.

## The tasks

`plan` picks one target per task type in each codebase. It prefers a target that involves about ten files, or five for the add-variant task, and `--min-files` sets the fewest it accepts. Which files a target involves depends on the task. For a rename they are other files than the one that declares the target. A module involves the files that import it. A function or a variant involves the importers that name it: through the module's name or alias, or bare where the import exposes it, which for a variant is where the import takes the variants of its type along. No other file can name a function or a variant that its module does not expose, so such a one involves no file and is no target. A field involves the importers of the record's module that name both the record and the field. The add-variant task involves the files with a branch on one of the type's variants, the one that declares the type among them, and that one alone where its module keeps the variants to itself. A variant called like its own type, as in `type Email = Email String`, is no target, because the tokens of a use do not tell the type from the variant. Functions are found by their type annotations, so a function without one is no target and no namesake.

A function, a variant or a field is a target only when its name has four letters or more. A shorter one is too often the name of something else in the same files, which the comparison of tokens cannot tell from it. A target whose new name, the old one with `Renamed` behind it, stands anywhere in the project's code already is no target either, since the renamed target could clash with it. That holds for a function without a type annotation, a record alias and a local variable alike, and for a module where the last part of its new name stands there. A module is no target where anything lies at the path of its new file already, because the move would write over it. That holds for a file without a module line, which the benchmark does not read as a module, and for a link whose end is gone. On a file system that ignores letter case, it holds for a name that differs in case alone.

A target is only taken when the check command compiles its file and every file the change can break. The compiler says nothing about a module it never reads, so a reference left behind in one would pass. In practice that leaves out whatever your test modules import, unless `check` builds the tests too. `plan` prints how many of the project's modules the check command compiles. When a task type ends up without a target, it names the uncompiled file that held back the most candidates and says how many more such files there are. A Lamdera app has many: the snapshots and migrations under `src/Evergreen/` name the app's types and fields, and a check that builds `Frontend.elm` and `Backend.elm` compiles none of them. Most of its fields and many of its functions are no targets for that reason.

The benchmark reads the modules in the source directories of `elm.json` and in `tests/`. An Elm file anywhere else under `elmRoot`, such as an example with an `elm.json` of its own, can import the same modules, and no check compiles it. A target that such a file can use is left out, and `plan` prints how many those were.

A source file can be a link to another file of the project, `src/Lib.elm` to `shared/Lib.elm`. git reports a change to it under the name of the file the link leads to. A target that involves such a file is left out as well, and `plan` prints how many those were.

One more kind of target is left out, a field that an extensible record type names anywhere in the project, `{ a | name : String }`. A function with such a type takes every record that has the field, so the field cannot be renamed on one of them alone.

| Task | The agent is asked to | Solved when the project compiles and |
|------|----------------------|--------------------------------------|
| Rename function | rename a function whose name no other module declares | the module declares the new name and not the old one, and only files that import the module changed |
| Rename function, shared name | rename a function whose name at least three other modules also declare | as above, and the other modules still declare theirs |
| Rename variant | rename a variant of a custom type | the type has the new variant and not the old one, other types with a variant of that name still have theirs, and only files that import the module changed |
| Rename field, shared name | rename a record field whose name at least two other records also have | the alias has the new field and not the old one, and the other records still have theirs |
| Rename module | rename a module and move its file | the old file is gone, the new file declares the new module, nothing imports the old name, and only its importers changed. A type of the module's own name keeps that name |
| Add variant | add a variant as the last one of a custom type with three variants or more, and a `Debug.todo` branch for it wherever the compiler asks | the variant is the last of its type, no other type got the variant, every changed line is the variant, a branch that names it or the branch's body, which is `Debug.todo` with a string literal, and only files that import the module changed. A catch-all branch or a rewritten one fails. `plan` only accepts a type where adding the variant breaks the build |

Every request ends with "Change nothing else", so the verdict holds a session to nothing that the request leaves unsaid.

For each of the five renames, every changed Elm file is also compared with what it was, token by token. Apart from layout and comments, only the name may differ. A text replace that reaches into a string literal changes what the program says, and it fails here while the compiler lets it through. The module line and each import are compared on their own, in any order, so an alias that moved from one import to another fails too.

Where the name may differ depends on what is renamed:

- A function's name changes in the code and in what a module line or an import exposes.
- A variant's name and a field's change in the code only. An import alias of the variant's name, as in `import Page.Settings as Settings`, keeps its own. In a field rename, a variable that a record pattern binds takes the new name, which the request says.
- A module's name changes in front of a dot, and in a module line or an import outside of what that exposes. A type of the same name, as in `module User exposing (User)`, keeps its own.

A rename creates no Elm file and deletes none. The one exception is the file of the module that a module rename moves. Its new path must not be one that the starting commit holds. A move over such a file loses what the file held, and it is a wrong result even where the project compiles.

A declaration of another kind that shares the target's name has to keep it as well: a record alias with a field called like the function, a type called like the variant, a function called like the field. A text replace renames those along, and the project still compiles when it does so everywhere.

The comparison reads tokens and no types, so some things get past it. Each shares the target's name, was renamed along with it in a file the task may change, and left the project compiling: a local variable, a type variable, a field of a record that has no alias or of an extensible alias, a port, and a function without a type annotation. In a module rename, an import alias that equals the last part of the module's name gets past it the same way, be it the module's own alias or another import's.

The add-variant verdict reads an added variant and its branches by these rules:

- The message of the added `Debug.todo` is the session's choice. The language server's `elm_add_variant` writes a message of its own, and the task is about the branch and not about the wording of a placeholder.
- Brackets around the call are the session's choice, and so are the lines that a body is laid out on.
- The variant can stand behind its bar with a space or without one, as in `| Square` and `|Square`.
- A pattern can go on over several lines while one of its brackets is open, and its arrow stands on the line where the pattern ends, as elm-format puts it. The compiler also takes an arrow on a line of its own. The verdict does not read that as the end of a pattern, and such a branch fails the task.
- A branch ends with its body. The first line of code below the body must not be indented deeper than the branch's pattern, because by Elm's layout rule such a line goes on with the body. A branch put between a body and its last lines compiles, takes those lines over from the branch above, and fails the task.
- A comment in an added branch or beside it is one more thing that changed, and fails the task. That holds on a line of its own, behind the arrow, in the body and behind the new variant. The five renames leave comments out of the comparison altogether.
- The one exception is a comment in front of the arrow that begins and ends on one line of the pattern. It is passed over, because a pattern is read line by line without its comments. A block comment that goes on over two lines of a pattern fails like the rest.
- The variant goes onto the one type that the request names. A type of the same name in another module would take it as well, and the project would compile.
- A branch that a session adds to a case which already had a catch-all passes as well, though the compiler did not ask for it.
- In a file that does not end with a line break, a branch added at its very end fails when its body repeats the body above it, because git then shows the line above as the added one. elm-format ends every file with a line break.

A task changes Elm files of the project and nothing else, by these rules:

- Of the files that the starting commit holds, a data file, a script or the build's configuration that changed along makes the result wrong, whatever the compiler says.
- So does any file beside `elmRoot`, where the repository is more than the Elm project.
- The one exception is `elm.json` in a module rename, where a package lists the modules it exposes. Where that list holds the module, its name has to change there too, and the task says so. A check command that builds one file does not read the list, so the compiler would pass the old name. Nothing else in the file may change.
- A file that the commit does not hold counts only when it is an Elm source.
- Under a directory called `elm-stuff` or `node_modules` such a file does not count either. The compiler's cache and the packages that a session installs are no sources of the project, though a package can bring Elm files of its own.
- What the commit holds there counts like any other file, and so does a module in a source directory of the project that lies there, as where `elm.json` lists a package that came through npm.
- The page that `elm make` writes without `--output`, the output of your own check command or a note that a session left changes nothing about the project.

Both the choice of targets and the verdict come from `lib/elm-source.mjs` and from the project's own compiler. That module reads declarations from the source text, whatever their layout, and leaves comments and string literals out. The language server takes no part in either, so it cannot grade its own work.

## The two arms

| Arm | The session has |
|-----|-----------------|
| `baseline` | Claude Code's `Bash`, `Read`, `Edit`, `Write`, `Grep` and `Glob` tools |
| `lsp` | the same, plus the MCP tools of this checkout's `mcp-wrapper/index.mjs`, started with `--project-tools` so it uses the compiler each codebase pins |

Everything else is identical: the prompt, which never mentions the language server, the model, and the starting commit. The sessions of a task are next to each other in the queue, so they run at about the same time, and the arms take turns at going first.

### Keeping your own setup out

A session must not see your Claude Code setup. An instruction file that recommends the language server, or a note in memory from an earlier session, would reach both arms and blur the difference between them.

- `--setting-sources ""` leaves out user and project settings, and with them your plugins, skills, hooks and the `CLAUDE.md` and `AGENTS.md` files in the project and above it.
- `--strict-mcp-config` leaves out every MCP server but the one the `lsp` arm is given.
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns off auto memory. All worktrees of a repository share one memory directory, which is your own.

These are Claude Code's switches, and they may change between versions. I checked them with Claude Code 2.1.311. `run` checks them again each time:

- Before the first task it runs one short session without tools in a directory seeded with instruction files and with a hook in each of the project's two settings files, and asks it what it was told. The check plants its files in the project and above it. The hooks are `SessionStart` hooks, whose output Claude Code 2.1.311 hands to a session that loads the project's settings.
- It stops if that session saw any of them, reports a memory directory or comes up with a tool or an MCP server of any kind, the language server's included.
- Where your user settings hold a `CLAUDE.md`, in `$CLAUDE_CONFIG_DIR` where that is set and in `~/.claude` where it is not, the question also asks the session to name the path of every file whose contents it was given as instructions. Claude Code 2.1.311 names the path of each instruction file in a session's context. The check stops the run when the answer names that file, and it plants nothing in your settings and reads nothing of the file.
- Every later session is stopped the same way if it reports a memory directory, or a tool or an MCP server that its arm is not given. A server counts whatever its state, since one that is still starting lists no tools yet and can hand some over later.
- A session's first event also lists its plugins, and one that is not built into Claude Code stops the run like a stray tool.
- A session of the `lsp` arm stops the run too when its language server is absent, still starting when the session reports its setup, or connected without handing over a tool, since whether such a session has the tools cannot be told. Claude Code's documentation names `MCP_TIMEOUT` as the time a server has to start, 30 seconds unless it is set.

That the hooks of your user settings stay out rests on `--setting-sources ""` alone, which no session can be asked about.

Three things these switches do not cover:

- Settings that an organization manages for every user of the machine still apply, and so does a managed `CLAUDE.md`.
- With your user settings go their `env` entries and their `apiKeyHelper`. If your sign-in depends on one of those, the sessions cannot reach the API.
- A session's memory directory is read from a field of its first event that Claude Code does not document. If a later version drops the field, the check finds nothing, and the environment variable alone keeps memory off.

### What a session can touch

A session runs shell commands and edits files without asking, so run the benchmark on code you trust. Every session gets its own `git worktree` of the codebase and does not edit your checkout. The compiler runs once before the agent starts, so neither arm pays for a cold build.

The worktree is a directory named after the repository, alone in a new directory among the system's temporary files. Claude Code tells the model where it works, and that path says nothing about the arm. The plan, with what each task expects, and the patches of other sessions are in the output directory, nowhere near.

- A worktree shares its repository with your checkout: its branches, tags, stash, configuration and remotes are yours. The agent is told not to commit, and the git subcommands that write to those, from `commit` and `branch` to `tag`, `config` and `push`, are denied in their plain form. That guards against accidents. It is not a sandbox, because the agent has a shell. `checkout`, `reset` and `stash` are among the denied ones, so a session takes an edit back with `git restore` or by hand, and one that tries `git checkout -- <file>` first has spent a turn on it. What a session stages, with `git add` or `git mv`, stays in the index of its own worktree. It leaves objects in your repository that nothing refers to, which git removes when it next collects garbage.
- The benchmark's own git commands add nothing to your repository but the worktree, which they remove again. They skip its hooks and stage nothing. The links of `link` are made, and removed again, inside the worktree and nowhere else.
- The paths under `link` are your real directories. `plan` and `run` stop when a source file is reached through a link that leads out of the Elm project root. Outside the checkout a session would edit your own file there, and elsewhere in the checkout its edit would be one beside the project, which counts against it. A checkout whose Elm root itself lies behind a link that leads out of it is refused. So is a commit that holds a link out of the checkout at any path, because a session that edits such a path changes what the link points to. A committed link that leads out through a path under `link` is refused as well, so a repository that commits a link into `node_modules` cannot list `node_modules` there. Each link is followed the way the system follows it, also to a file that is not there yet, and one whose end cannot be made out is refused with the others. And so is one whose `elm.json` is a link, wherever it leads, because the benchmark reads from that file what a session did to it.
- A session is a process group of its own, and so is every run of the check command. Claude Code starts each shell command of a session as one more group, which a signal to the session's group does not reach, so the benchmark also looks up once a second which processes a session has started. When a session or a build ends, what it left running is killed, and only then is the result judged and the worktree removed. A process that a session detached and that was gone from under it in less than that second can escape. One that goes on writing can also bring the directory of its checkout back after the benchmark removed it, with whatever it wrote there.
- A session over its time limit gets the signal that Ctrl-C sends. Claude Code then ends its shell commands and reports what the session cost. Whatever is still there five seconds later is killed.
- Ctrl-C, `kill` and a closed terminal end the builds and the sessions under way in that same way and remove their worktrees. The benchmark's own git commands run outside the terminal's process group, so an interrupt lets each of them finish. No further session starts. An interrupted session leaves no record, transcript or patch, so the next `run` starts it again. A second Ctrl-C does not wait the five seconds.
- A benchmark that is killed outright, as with `kill -9`, ends nothing. Its sessions run on until they finish, and its worktrees stay behind among the temporary files. `<out>/work` remembers where each one is, and the next `plan` or `run` on that output directory removes each one of a codebase that the config still names, also the one of a session that has its record. A checkout of a codebase that the config no longer names stays where it is, since the benchmark does not know its repository any more. The next `plan` or `run` says on stderr where it is and that `git worktree remove --force` in that repository removes it. The benchmark only ever deletes a directory that git lists as a worktree of the codebase, and it never prunes your repository's worktree list. A file that a session wrote beside its checkout, in the directory that was made for the checkout alone, stays there with that directory.
- One benchmark at a time works in an output directory. `plan` and `run` keep a lock file there, `<out>/lock`, and a second one is refused while the first is running. The lock of a benchmark that was killed is taken over by the next one, also when it names the next one's own process id, as in a container that gives the benchmark the same id each time. The lock tells its holders apart by their process ids, so it holds on one machine, and two containers that share an output directory can both get in. The lock is made as a hard link, so `plan` and `run` refuse an output directory on a file system without hard links. Use another `--out` there.
- Claude Code can keep the output of a session's tools under `~/.claude/projects/`, in a directory named after the checkout's path, although the sessions are started with `--no-session-persistence`. I found one such file after a session with a long shell output, with Claude Code 2.1.311. It holds names from the codebase and stays on your machine until you delete it. `~/.claude.json`, where Claude Code keeps an entry for each project directory, got no entry for a checkout in more than a hundred sessions with Claude Code 2.1.311.

## Reading the report

A solved task means that the project compiles and that the change passed the comparison of [The tasks](#the-tasks), which reads tokens and no types. Some changes get past that comparison, and that section lists them. A session can also solve a task and still break a build that the benchmark never runs, as [What it does not tell you](#what-it-does-not-tell-you) lists. One target per task type and codebase is a small sample, so raise `--repeat` and add codebases before you read much into a difference between the arms.

A session ends in one of seven ways, and the page counts them per arm.

| Outcome | Meaning |
|---------|---------|
| Solved | The project compiles and the change is the one that was asked for |
| Wrong result | It compiles, but something else was changed or the change is incomplete |
| Does not compile | The check command fails. A checkout that a session left unreadable, without its `.git` for one, is counted here when the check could not run |
| Out of time | The session hit `--timeout-min` |
| Out of budget | The session hit `--max-budget-usd` |
| Session error | The session ended on an error of its own, such as a request that grew too long for the model |
| Server did not start | The `lsp` arm's language server failed to start. It counts against that arm, whatever the agent then did without it. The session is not cut short, and its cost and time are among the arm's |

A session that loses the API is no result of either arm: on a rate limit, an expired login, an outage or a connection that broke. That holds at the first request and in the middle of the work. It holds as well for a session whose time ran out while Claude Code was asking the API again for an answer, the first one or a later one. Claude Code reports each time it asks again and nothing while an answer comes in, so a session whose time ran out in the middle of a long answer to such a request is run again too. `run` stops there and records nothing for it, so the same command runs that session again once the cause is gone. The one API error that stays with the session is a request that holds more than the model takes: a 413, or a 400 that says the prompt is too long. That is recorded as a session error. Any other 400 is a lost API, such as the one the API sends once a spending limit is reached, and the error's own text is what tells the two apart.

A record also counts how often Claude Code had to ask the API again, as `apiRetries`, which tells a session that waited from one that worked slowly. The table of every session on the page shows the count. To have any recorded session run again, delete its `.json` in `<out>/runs`.

What a session changed is read against the commit it started from, file by file. That also shows a change the session committed, and one in an Elm file that git ignores. A session is told not to commit. One that does is judged by all of its changes, and the commit itself makes it a wrong result.

Cost is what Claude Code reports for the session. Time is wall-clock time, so run with `--concurrency 1` on a quiet machine if the timing matters to you. Each record holds the `--concurrency` it ran with as `concurrency`, since the two arms of a round can come from two runs with different numbers, and a resumed run is free to take another. `summary.json` has the same figures as the page. Both name the model and the effort it ran at, which is Claude Code's default where `run` named none, and each effort where the records differ. They also name the Claude Code version and the language server's version with the last commit that changed its sources, a digest of what is not committed in them, and the time its binary was built. The sources are `src/` without the other binaries in `src/bin/`, `mcp-wrapper/`, `Cargo.toml` and `Cargo.lock` of this repository, so a change to a document here or to one of those binaries leaves a run that was started free to go on.

The arms are compared on the same work. A round of a task enters the report once every arm that `run` started sessions for has one for it, and the page says how many sessions are waiting for their counterpart. A report of one arm alone says that it compares nothing. A session that had to be killed has a time and no cost. The cost medians leave it out, and the page says how many those are in each arm.

## What it does not tell you

- The tasks are refactorings the server has a dedicated tool for. Work that mostly needs reading and understanding code is not covered.
- One target per task type and codebase is a small sample. Raise `--repeat` to see how much sessions vary, and add codebases to see how much targets vary.
- It measures one harness, Claude Code, with one model at a time.
- `lsp` means the MCP tools and the instructions that the server sends when a session connects, which Claude Code shows to the model. They are notes on paths, lines and columns, and they give no advice to prefer the tools. The skill in `skills/elm-refactoring` is not loaded.
- The sessions of both arms are started with six of Claude Code's tools named, the ones it reads, searches and edits files with: Bash, Read, Edit, Write, Grep and Glob. Neither arm has the rest of Claude Code's tools, subagents and web access among them.
- The cost of a session depends on what it finds in the API's prompt cache. The two arms have different tools, so each has a cached prompt of its own. Whether a session starts with that cache warm depends on how long ago a session of the same arm ran, and that depends on how long the other arm's sessions take. The cost of the faster arm can come out a few cents higher for that. A record holds the two counts beside `inputTokens`, which includes them: `cacheCreationInputTokens` for the tokens written to the cache and `cacheReadInputTokens` for the ones read from it.
- A session that runs `elm-format` over a file which was not formatted before can change more tokens than the rename asked for, and is then judged wrong. In the add-variant task every changed line counts, so there a change of layout alone is enough. The `lsp` arm has `elm_format` among its tools.
- Another Elm project in the same repository that shares the source directories, outside `elmRoot`, is not looked at.
- A project whose check command generates Elm sources cannot be benchmarked. A session that ran the command would be judged by what the generator wrote, and one that did not would not, so `plan` stops on such a project.
- Most environment variables of the shell that starts the benchmark reach the sessions. Some of Claude Code's act on MCP tools alone, and so on the `lsp` arm alone. Among those that Claude Code 2.1.311 reads are `MCP_TIMEOUT`, the time a server has to start, `MCP_TOOL_TIMEOUT`, the time a tool call may take, `MAX_MCP_OUTPUT_TOKENS`, the most of a tool's output that a session is shown, and `ENABLE_TOOL_SEARCH`. Its binary names more of the kind, such as `MCP_CONNECT_TIMEOUT_MS`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, `MCP_CONNECTION_NONBLOCKING` and `MCP_SERVER_CONNECTION_BATCH_SIZE`. Leave such variables unset, or set them as you mean the `lsp` arm to run. The variables that a Claude Code session sets for the commands it runs, such as `CLAUDECODE` and `CLAUDE_CODE_SESSION_ID`, reach no session and not the pre-flight of the MCP server, so a benchmark that an agent started runs its sessions as one started from a plain shell does. The ones that say how Claude Code signs in or which provider it uses stay, such as `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_USE_BEDROCK`.
- A `CLAUDE.md` or an `AGENTS.md` that a codebase has committed is not loaded into a session, and it still lies in the checkout, where a session of either arm can open it like any file. One that recommends the language server, or names its command line, then reaches both arms.
- A rename of a field of a record alias that a port carries, or that the program's flags are decoded into, changes the key that JavaScript sees. The compiler and the verdict take it for solved, in both arms alike, and the JavaScript side breaks when the program runs.
- A field rename can be impossible to solve as judged: where a value of the record is also passed for another record type with the same fields, renaming the field on one of the two needs more than a rename. Both arms then fail that task.
- With `--concurrency` above 1, the sessions that run side by side are worktrees of one repository. `git worktree list` in one of them shows where the others are, the other arm's checkout of the same task among them.
- A session that runs `ps` can see the benchmark's command line and its `--out`. With `--concurrency` above 1, it can also see another session's `--mcp-config`. From the output directory, it can read the plan and the patch of an earlier session.
- In a package, the documentation of a module names what it documents in `@docs` lines. A renamed function or variant can keep its old name there and pass. Comments are no part of what the verdict compares, and only `elm make --docs` reads those lines, which a check command that builds single files does not run.
- A module that other tooling finds by its name or its path is renamed like any other: a route of elm-pages or elm-land, or the entry of a build script that `check` does not run. Only the four modules that Lamdera looks for keep their names. A session can do such a rename right and still break a build that the benchmark never runs.
- A file outside the Elm sources can name the renamed module or its path: a page of documentation, the configuration of a linter. It is not the task's to change. A session that corrects the name there is judged wrong, and one that leaves it stale passes. A session that looks for uses by searching text meets such a mention more often than one that calls the language server.
- Test modules are mostly out of the picture. The language server does not index `tests/`, and a target that test modules use is left out unless `check` compiles the tests. How either arm copes with a rename that reaches into tests is not measured.
