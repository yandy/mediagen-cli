# `pi install npm:@yandy0725/mediagen-cli` — declaring the skills bundle

Date: 2026-11-03
Status: obsolete (2026-11-07) — the package no longer declares a pi manifest (`pi.skills` /
`pi-package`). `skills/` stays in `files` only because `mediagen skill install` copies the
skill out of the installed package. Kept as the record of the decision made at the time.

## Why

Someone working inside [pi](https://pi.dev) should not have to find the skill directory by
hand. `mediagen skill install --dir ~/.pi/agent/skills` works, but pi has a native route:
a pi package delivers skills straight from an npm spec, and this repository already ships
`skills/mediagen/SKILL.md` in its tarball (`files: ["dist", "skills"]`).

Measured on the published `@yandy0725/mediagen-cli@0.3.0`, with pi's own resolver
(`DefaultPackageManager.resolve()`, installed into a scratch agent dir):

- The skill is **already discovered today**, with no `pi` manifest: pi falls back to
  conventional directories, so `skills/` at the package root yields
  `…/skills/mediagen/SKILL.md`, `enabled: true`; `loadSkillsFromDir` parses it with no
  diagnostics, and it appears in the system prompt as `<skill><name>mediagen</name>…`.
- pi installs packages with `npm install <spec> --prefix <agentDir>/npm` and never links
  `bin`. `…/npm/node_modules/.bin/mediagen` does get created by npm but is **not on PATH**:
  pi prepends only `<agentDir>/bin` (its own `fd`/`rg` directory) to the bash tool's PATH.
  No extensions are discovered either, so nothing in the package ever executes.
- The cost of a pi install is 592 kB on disk (`dist` 136 kB, `commander` 220 kB,
  `smol-toml` 172 kB) plus the READMEs.

So the deliverable is not a new mechanism. It is: say it on purpose, keep it true, and tell
people. Relying on an undocumented fallback would silently break the route if pi's default
discovery ever changed, and nothing in this repo currently states the intent.

## Goals

- The skill arrives with `pi install npm:@yandy0725/mediagen-cli`, as a declared resource
  rather than an accident of directory layout.
- A future move or rename of `skills/` fails the test suite instead of shipping a package
  that installs nothing.
- Both READMEs document the route and the one thing it does **not** do: put the `mediagen`
  command on `PATH`.

## Non-goals

- A separate skills-only npm package.
- Gallery previews (`pi.image` / `pi.video`).
- Any change to `skills/mediagen/SKILL.md`'s content.
- Any change to `mediagen skill install`.
- Publishing a release (a separate, explicitly approved step).

## Anti-goals

- A published tarball where `skills/` is missing, so pi installs a package that delivers
  nothing while reporting success.
- Documentation that implies `pi install` provides the CLI command.
- Two copies of the same skill offered to pi on one machine (see Constraints).

## Constraints

- `files: ["dist", "skills"]` stays as is: it is what makes the skill publishable at all.
- pi dedupes resolved resource *paths*, but loads skills by *name*: two copies of `mediagen`
  yield one skill, not two, plus a `name "mediagen" collision` diagnostic. The user directory
  (precedence rank 3) outranks a package resource (rank 4), so a copy installed by
  `mediagen skill install --dir ~/.pi/agent/skills` silently shadows the upgraded package copy.
  The docs must say to pick one route; the code cannot detect it.
- The package has no extensions, so pi's package changelog never applies (`pi.changelogPath`
  is pointless here).

## Approaches

**A. Declare the existing package (chosen).** Add `pi.skills` and the `pi-package` keyword
to `package.json`, document the route, and assert it in the suite. One package, one version,
the skill can never drift from the CLI it describes. Trade-off: the tarball still carries
`dist/cli.js` and pi installs the CLI's two runtime dependencies for a resource that never
runs them — 592 kB for a markdown file.

**B. Publish a separate skills-only package.** Truly CLI-free. Costs a second release train,
two versions to keep aligned, and a skill that can describe a CLI version the user does not
have. Rejected: the marginal benefit is disk space, and the drift risk is real.

## What changes

1. **`package.json`** — `"pi": { "skills": ["./skills"] }` and `"pi-package"` added to
   `keywords`. Explicit beats convention: it is the documented contract, it makes the intent
   reviewable in a diff, and `pi config` filters narrow a manifest that exists.

2. **`tests/cli.entry.test.ts`** — a new `describe("pi package manifest")` beside the
   existing `packaged entry point` block: read `package.json`, assert every `pi.skills` entry
   resolves inside the repository, and assert each resolved directory contains at least one
   `SKILL.md`. This is the check that turns "moved `skills/`" into a red test. CI's
   `npm pack --dry-run` grep already covers the tarball side.

3. **`README.md` / `README.zh-CN.md`** — the "Working from an agent?" paragraph leads with
   the pi route (`pi install npm:@yandy0725/mediagen-cli`), then keeps
   `mediagen skill install --dir <skills dir>` for other agents and for pinning the skill to
   an explicit directory. Both say the pi package delivers the skill only; the `mediagen`
   command still comes from `npm install -g @yandy0725/mediagen-cli`. Both say to use one
   route, not both.

4. **`docs/guides/release.md`** — one note: pi discovery depends on `skills/` staying in the
   tarball, so a Release keeps that assertion green before `gh release create`.

## Decisions made here (mine, not agreed with the maintainer)

- **Version 0.3.1.** Packaging and documentation only; no CLI behaviour changes.
- **Explicit manifest over convention.** Costs one `package.json` key and makes the route
  survive a future pi discovery default.
- **The manifest check lives in `tests/cli.entry.test.ts`**, not a new file: that file is
  already the one that reads `package.json` to assert what the package publishes.

## Left to the builder

- Wording and placement of the README paragraphs; the section around line 257 (EN) and
  line 232 (zh) is where the agent instructions already live.
- Whether the `pi-package` keyword earns its place today (it only affects pi's package
  gallery). Included so the package is discoverable when it is listed, not later.
