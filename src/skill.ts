import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The two filesystem calls a test replaces to make an install fail mid-flight. */
export interface SkillDeps {
  cp?: (from: string, to: string) => void;
  rename?: (from: string, to: string) => void;
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
    fs.rmSync(staging, { recursive: true, force: true });
    if (retiredPath !== undefined) {
      fs.rmSync(retiredPath, { recursive: true, force: true });
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
