# `mediagen skills install` — landing the packaged skill in a directory

Date: 2026-11-03
Status: approved — copy the shipped `skills/` directory at runtime, staging it beside the
destination and swapping it in with renames; amended 2026-11-07, the group is now `skills`
(see the addendum at the end)

## Why

`skills/mediagen/SKILL.md` already ships in the tarball (`files: ["dist", "skills"]`) and the
READMEs point at it, but there is no way to put it where an agent reads skills. Someone on a
global install has to dig into `node_modules/@yandy0725/mediagen-cli/skills/` and copy it by
hand, and there is nothing to re-run after an upgrade. The package can hand the file to an
agent but not install it.

`mediagen skills install --dir <path>` closes that: it copies the skill directories this
package ships into `<path>/<name>/`.

## What changes

One new module `src/skill.ts` plus one command group in `src/cli.ts`.

**The command.** A `skills` group with a single subcommand, `install`:

```
mediagen skills install --dir <path> [--json]
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

**The write.** The destination is **replaced**, unconditionally — re-running the command after
an upgrade is the intended way to upgrade an installed skill. Replacing an existing copy
prints one stderr note (`replaced the existing copy at <path>`) so the upgrade is visible
without being noisy; stdout stays the result only, matching every other command.

No `--force`, no confirmation prompt, no merge, no backup copy.

## Replacing a directory, not merging into it

`fs.cp` does not replace a directory. It merges: a file present in the source overwrites its
same-named counterpart, and everything else already in the destination stays. Verified
directly — a source holding `SKILL.md`, `ref/a.md` and `ref/b.md`, copied over a destination
holding `ref/x.md`, ends up with `ref/{a.md, b.md, x.md}`. A skill may carry references and
scripts, so the first version to *remove* one would leave it behind on every machine that
installed the previous version, and an agent reading that directory would load a mixture of
two versions. A plain `cp` therefore cannot satisfy "what gets installed is what the
repository holds".

So each install is staged and swapped:

1. `fs.mkdir(<dir>, {recursive: true})`.
2. Copy the source skill into a sibling staging directory inside `<dir>`, e.g.
   `<dir>/.mediagen-install-<pid>-<random>/`, so it sits on the same filesystem as the target
   and the `rename`s below cannot fail with `EXDEV`.
3. If `<dir>/<name>` exists, `fs.rename` it aside to `<dir>/.mediagen-retired-<pid>-<random>`.
4. `fs.rename(staging, <dir>/<name>)`.
5. `fs.rm(retired, {recursive: true, force: true})`.

Step 3 exists because `rename` cannot replace a non-empty directory — verified: renaming a
staged directory onto an existing skill directory fails with `ENOTEMPTY`, and only an empty
destination is accepted. On failure after step 3, the retired directory is renamed back into
place before the error is rethrown; on failure before it, only the staging directory is
removed. Either way the previous copy is intact.

The one gap this leaves: between step 3 and step 4 the destination path does not exist, for
the duration of a single `rename`. That is a missing directory rather than a half-written
one, and an agent reading at precisely that instant gets "no such skill" — not a truncated
`SKILL.md`. A full atomic swap over a directory is not available in portable POSIX filesystem
calls, and this is the shortest window that keeps the old copy recoverable.

The point is that the destination is never observable half-written: at every instant an agent
reading that path sees either the whole previous copy or the whole new one. Delete-then-copy
would be two lines shorter and loss-free in the normal case, but a copy that dies partway
(full disk, one unreadable file) leaves a truncated `SKILL.md` exactly where an agent is about
to look — a worse outcome than the error itself.

Known residue, accepted: a process killed between step 2 and step 3 leaves a dot-prefixed
staging directory behind. Nothing sweeps for it — the prefix only ever holds a copy of a
skill this package ships, and a sweep would mean deleting directories that this run did not
create. A later install into the same `<dir>` is unaffected.

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

- `mediagen skills install --dir <path>` installs the packaged skill into `<path>/mediagen/`,
  byte-identical to `skills/mediagen/SKILL.md` in the repository.
- Re-running it replaces the previous copy and says so on stderr; stdout stays one path per
  line in human mode and the single JSON object above in `--json`.
- `<path>` may not exist, may be nested, and may be given with a leading `~/`.
- After a re-install the destination holds exactly the files the package ships: a file the
  new version dropped is gone, not merged into the old set.
- The destination is never left half-written; a failed or interrupted install leaves the
  previous copy intact.
- `mediagen --help` and both READMEs mention the command.
- The command never touches config.toml's contents, never makes a network call, and never
  prints or reads an API key.

## Non-goals

- Harness presets (`--for pi`, `--for claude`), defaults, or any discovery of where an agent
  keeps its skills. The directory is the caller's to name.
- `skills list`, `skills remove`, `skills update`; version pins, checksums, or an index of
  installed versions.
- Installing any skill other than the ones this package ships; a `--source` flag for an
  arbitrary directory.
- Symlinks (pointing at the package directory would break on `npm rm`) and build-time
  inlining of the markdown into `dist/cli.js` (a second copy that can drift from the one the
  tests read, and a `npx`-only benefit nothing has asked for).
- Sweeping or reporting leftover staging directories from a killed process, and keeping the
  replaced copy as a backup the user can restore.
- Changing the pre-command bootstrap. `skills install` is a local, config-free command, yet
  `main()` still runs `prepareConfigFile()` before it — accepted, so that every command sees
  the same file and a broken config is reported the same way everywhere. The consequence is
  that a first run of `skills install` also creates `config.toml`.

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
- Merging into an existing skill directory, leaving behind a reference or script that the
  shipped version no longer has.
- Emptying the destination before the new copy is complete, so a failure leaves a partial
  skill where a working one used to be.

## Left to the builder

- The staging directory's name; it only has to be hidden, unique per install, and inside
  `<dir>`.
- Wording of the "replaced the existing copy" note needed to make an upgrade visible without
  making a first install noisy.
- How the note and the `--json` envelope report a replacement: `replaced` is per skill, and
  the note is one line per replaced skill.
- Whether a skill directory that lacks a `SKILL.md` is worth rejecting. The source is ours and
  reviewed, so no validation is planned; a test pins that what is copied matches the source.
- Where the README sentence sits inside the existing "Working from an agent?" paragraph, and
  its Chinese counterpart.

## Addendum — 2026-11-07: the group is `skills`, not `skill`

The command shipped in v0.3.x as `mediagen skill install`; it is now
`mediagen skills install`. The group carries subcommands over the skill *directories* this
package ships, and the container it writes into is spelled `skills` everywhere the user
already sees it — `files: ["dist", "skills"]`, `--dir ~/.claude/skills`,
`--dir ~/.pi/agent/skills` — so the singular read as a typo beside every path the command
prints.

Nothing inside the command moved: same `src/skill.ts` (still singular — it installs *the
skill*, and the module name was not the complaint), same required `--dir` with no default,
same staging-then-rename swap, same stdout, same `--json` envelope, same exit codes. Only the
group name changed, in `src/cli.ts`, the `--help` subcommand list and the `runSkillInstall`
comment.

The old form keeps no alias. `mediagen skill install` now exits 2 with
`unknown command 'skill' (Did you mean skills?)`, which is a breaking change for any script or
document that still spells it the old way, so the release that carries this is not a patch.
Updated in the same change: `tests/skill-install.test.ts`, `tests/cli.entry.test.ts`, both
READMEs, `docs/guides/release.md`, and the body of this document.
