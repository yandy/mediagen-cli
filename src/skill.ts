import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "./errors.js";

/** What a test replaces to make an install fail mid-flight, or to point at a broken package. */
export interface SkillDeps {
  cp?: (from: string, to: string) => void;
  rename?: (from: string, to: string) => void;
  /** Where the shipped skills live; defaults to `bundledSkillsDir()`. */
  sourceRoot?: string;
}

/**
 * Copies one skill directory into `targetDir`, replacing whatever is there.
 * Returns true when a previous copy existed and was replaced.
 *
 * The copy lands in a hidden staging directory beside the target and is renamed
 * into place, so the target is never observable half-written: an agent reading it
 * sees either the whole previous version or the whole new one. `rename` cannot
 * replace a non-empty directory, so the old copy is first moved aside and deleted
 * once the new one is in place; if anything fails in between, it is moved back.
 */
export function installSkill(sourceDir: string, targetDir: string, deps: SkillDeps = {}): boolean {
  const root = path.dirname(targetDir);
  fs.mkdirSync(root, { recursive: true });
  const staging = stashPath(root, "install");
  const retired = stashPath(root, "retired");
  const cp = deps.cp ?? ((from: string, to: string) => fs.cpSync(from, to, { recursive: true }));
  const rename = deps.rename ?? ((from: string, to: string) => fs.renameSync(from, to));

  let retiredPath: string | undefined;
  let replaced = false;

  try {
    cp(sourceDir, staging);
    if (fs.existsSync(targetDir)) {
      rename(targetDir, retired);
      retiredPath = retired;
      replaced = true;
    }
    rename(staging, targetDir);
    if (retiredPath !== undefined) {
      fs.rmSync(retiredPath, { recursive: true, force: true });
      retiredPath = undefined;
    }
  } catch (error) {
    if (retiredPath !== undefined) {
      try {
        rename(retiredPath, targetDir);
        retiredPath = undefined;
      } catch {
        // Keep the retired copy: it is the only one left, and deleting it would
        // turn a failed upgrade into a lost skill.
        throw new Error(
          `${messageOf(error)}; the previous copy could not be put back and is at ${retiredPath}`,
        );
      }
    }
    throw error;
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // Cleaning up must never replace the error being reported, and must never
      // touch the retired copy: when the restore above failed, it is all that is left.
    }
  }

  return replaced;
}

/** A unique hidden path inside `root`, on the same filesystem as the target it sits beside. */
function stashPath(root: string, kind: "install" | "retired"): string {
  return path.join(root, `.mediagen-${kind}-${process.pid}-${randomUUID().slice(0, 8)}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface InstalledSkill {
  /** The skill's directory name, e.g. "mediagen". */
  name: string;
  /** Absolute path of the installed skill directory. */
  path: string;
  /** True when a previous copy was replaced. */
  replaced: boolean;
}

/**
 * The skills this package ships: `skills/` beside the built entry, which is also
 * `skills/` beside `src/` in a checkout. Same relative-to-the-entry trick
 * `packageVersion()` uses for `../package.json`.
 */
export function bundledSkillsDir(): string {
  return fileURLToPath(new URL("../skills/", import.meta.url));
}

export function bundledSkillNames(root: string = bundledSkillsDir()): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    throw new Error(
      `the skills this package ships were not found at ${root} (${messageOf(error)}); ` +
        "run mediagen from a normal npm install, where the skills/ directory ships beside dist/cli.js",
    );
  }
}

/** Installs every bundled skill under `targetDir`, replacing what is already there. */
export function installSkills(targetDir: string, deps: SkillDeps = {}): InstalledSkill[] {
  // The source is read before the destination is created: a broken package must
  // fail without leaving an empty skills directory behind, and an empty skills/
  // must never be reported as a successful install.
  const sourceRoot = deps.sourceRoot ?? bundledSkillsDir();
  const names = bundledSkillNames(sourceRoot);
  if (names.length === 0) {
    throw new Error(
      `no skills were found in ${sourceRoot}: the package is incomplete, reinstall mediagen`,
    );
  }

  const root = prepareTargetDir(targetDir);
  return names.map((name) => ({
    name,
    path: path.join(root, name),
    replaced: installSkill(path.join(sourceRoot, name), path.join(root, name), deps),
  }));
}

/**
 * Turns the `--dir` argument into an absolute, existing, writable directory. Every
 * failure here is the caller's argument, so all of them are UsageErrors (exit 2);
 * the message names `--dir`, matching `ensureOutDir` in generate.ts.
 */
function prepareTargetDir(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new UsageError(
      'a destination is required: pass --dir <path>, e.g. --dir "~/.claude/skills"',
    );
  }

  const expanded =
    trimmed === "~" || trimmed.startsWith("~/")
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
  const dir = path.resolve(expanded);

  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
    throw new UsageError(
      `--dir ${dir} is a file, not a directory: name the directory that holds skills`,
    );
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new UsageError(
      `cannot create the skills directory ${dir}: ${messageOf(error)}; check --dir`,
    );
  }

  // mkdir succeeds on a directory that already exists without checking that it is
  // writable, and the copy would then fail with a message naming an internal
  // staging directory instead of --dir.
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (error) {
    throw new UsageError(
      `cannot write to the skills directory ${dir}: ${messageOf(error)}; check --dir`,
    );
  }

  return dir;
}
