# `mediagen skill install` — landing the packaged skill in a directory

Date: 2026-11-03
Status: awaiting approval — approach A, copy the shipped `skills/` directory at runtime

## Why

`skills/mediagen/SKILL.md` already ships in the tarball (`files: ["dist", "skills"]`) and the
READMEs point at it, but there is no way to put it where an agent reads skills. Someone on a
global install has to dig into `node_modules/@yandy0725/mediagen-cli/skills/` and copy it by
hand, and there is nothing to re-run after an upgrade. The package can hand the file to an
agent but not install it.

`mediagen skill install --dir <path>` closes that: it copies the skill directories this
package ships into `<path>/<name>/`.

## What changes

One new module `src/skill.ts` plus one command group in `src/cli.ts`.

**The command.** A `skill` group with a single subcommand, `install`:

```
mediagen skill install --dir <path> [--json]
```

`--dir` is required and has no default. It names the *skills container* — the directory an
agent reads skills from, so `--dir ~/.pi/agent/skills` yields
`~/.pi/agent/skills/mediagen/SKILL.md`, not `<dir>/SKILL.md`. Missing `--dir` is a
`UsageError` (exit 2) whose message names the flag and gives one example path.

**The source.** `new URL("../skills/", import.meta.url)` — the same relative-to-the-entry
trick `packageVersion()` already uses for `../package.json`. From `dist/cli.js` it resolves to
`<pkg>/skills/`; from `src/cli.ts` in tests and `npm run dev` it resolves to the repository's
`skills/`. Both land on the same reviewed directory, so the command installs exactly what git
holds — no second copy of the markdown to drift.

Everything under that directory is installed, one `<dir>/<name>/` per skill directory found,
so a future second skill needs no code change. Today that is one directory: `mediagen`.

**The write.** `fs.cp` recursive into `<dir>/<name>/`, creating `<dir>` recursively first.
When the destination already exists it is **replaced**, unconditionally — re-running the
command after an upgrade is the intended way to upgrade an installed skill. Replacing an
existing copy prints one stderr note (`replaced the existing copy at <path>`) so the upgrade
is visible without being noisy; stdout stays the result only, matching every other command.

No `--force`, no confirmation prompt, no merge, no backup copy.

**Output.** Human mode prints each installed skill directory path, one per line, on stdout.
`--json` prints one flat object, in the style of `config path` and `auth status` rather than
the generation envelope (nothing was paid for and nothing can partially fail):

```json
{"skills":[{"name":"mediagen","path":"/home/u/.pi/agent/skills/mediagen","replaced":false}]}
```

**Failures.** Missing or empty `--dir` is a usage error (exit 2). A `--dir` that exists but is
a file, not a directory, is a usage error too, and so is a `--dir` whose parent is unwritable —
both are the caller's argument, not a runtime accident. The one runtime failure: the shipped
`skills/` directory cannot be found (the CLI inlined into some other bundle), which exits 1
saying which path was expected and that only a normally packaged install carries it. That is
the same situation `packageVersion()` degrades for, except here degrading silently would mean
"succeeded" while installing nothing.

**`~/` expansion.** A leading `~/` in `--dir` expands to the home directory. `--dir
"~/.claude/skills"` in quotes is the natural thing to type at an agent, and without expansion
it would create a literal `./~` directory that nobody finds again. Only the leading `~/` is
expanded; a `~user` form is left alone.

**Docs.** `ROOT_HELP`'s subcommand list gains one line, and each README's "Working from an
agent?" paragraph gains the command so the answer to "where does the skill go" is a command
instead of a path inside `node_modules`.

## Goals

- `mediagen skill install --dir <path>` installs the packaged skill into `<path>/mediagen/`,
  byte-identical to `skills/mediagen/SKILL.md` in the repository.
- Re-running it replaces the previous copy and says so on stderr; stdout stays one path per
  line in human mode and the single JSON object above in `--json`.
- `<path>` may not exist, may be nested, and may be given with a leading `~/`.
- `mediagen --help` and both READMEs mention the command.
- The command never touches config.toml's contents, never makes a network call, and never
  prints or reads an API key.

## Non-goals

- Harness presets (`--for pi`, `--for claude`), defaults, or any discovery of where an agent
  keeps its skills. The directory is the caller's to name.
- `skill list`, `skill remove`, `skill update`; version pins, checksums, or an index of
  installed versions.
- Installing any skill other than the ones this package ships; a `--source` flag for an
  arbitrary directory.
- Symlinks (pointing at the package directory would break on `npm rm`) and build-time
  inlining of the markdown into `dist/cli.js` (a second copy that can drift from the one the
  tests read, and a `npx`-only benefit nothing has asked for).
- Changing the pre-command bootstrap. `skill install` is a local, config-free command, yet
  `main()` still runs `prepareConfigFile()` before it — accepted, so that every command sees
  the same file and a broken config is reported the same way everywhere. The consequence is
  that a first run of `skill install` also creates `config.toml`.

## Approaches considered

- **A. Copy the shipped `skills/` directory at runtime.** Chosen. The source is the reviewed
  artifact, tests assert against the real file, no build change, and the tarball keeps its
  current shape.
- **B. Inline the markdown into the bundle at build time** (tsup `--loader:.md=text`). One
  self-contained file, and `npx` could install without the tarball's `skills/`; costs build
  magic and splits the source of truth from the file `tests/skill.test.ts` guards.
- **C. Symlink the destination at the packaged directory.** Never goes stale, but breaks on
  `npm rm`, needs privileges on Windows, and sends an agent reading the skill into
  `node_modules`.

## Anti-goals (would make this a failure even if it ships)

- Writing into a literal `./~` directory, or otherwise treating the argument as anything but
  a path the user can see afterwards.
- Installing content that is not the file in the repository — a hardcoded copy of the
  markdown, a `dist/`-baked string, or a stale embedded version.
- Reaching the network, reading or writing credentials, or charging anything: this command
  must work signed out, offline, and with a broken `config.toml` apart from the bootstrap
  check every command shares.
- Quietly skipping an install and exiting 0 because the source directory was missing.

## Left to the builder

- Wording of the "replaced the existing copy" note needed to make an upgrade visible without
  making a first install noisy.
- How the note and the `--json` envelope report a replacement: `replaced` is per skill, and
  the note is one line per replaced skill.
- Whether a skill directory that lacks a `SKILL.md` is worth rejecting. The source is ours and
  reviewed, so no validation is planned; a test pins that what is copied matches the source.
- Where the README sentence sits inside the existing "Working from an agent?" paragraph, and
  its Chinese counterpart.
