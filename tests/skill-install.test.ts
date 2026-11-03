import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkill } from "../src/skill.js";

let tempDir: string;
let source: string;

/** A skill directory carrying the reference file the tests watch. */
function makeSource(files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.writeFileSync(path.join(source, name), content);
  }
  return source;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediagen-skill-"));
  source = path.join(tempDir, "src", "mediagen");
  fs.mkdirSync(source, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function target(): string {
  return path.join(tempDir, "skills", "mediagen");
}

describe("installSkill", () => {
  it("copies a skill directory, creating the parents it needs", () => {
    makeSource({ "SKILL.md": "v1\n", "ref/a.md": "a\n" });

    expect(installSkill(source, target())).toBe(false);

    expect(fs.readFileSync(path.join(target(), "SKILL.md"), "utf8")).toBe("v1\n");
    expect(fs.readFileSync(path.join(target(), "ref", "a.md"), "utf8")).toBe("a\n");
  });

  it("drops a file the new version no longer ships", () => {
    makeSource({ "SKILL.md": "v1\n", "ref/old.md": "old\n" });
    installSkill(source, target());

    fs.rmSync(path.join(source, "ref"), { recursive: true, force: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "v2\n");

    expect(installSkill(source, target())).toBe(true);

    expect(fs.readFileSync(path.join(target(), "SKILL.md"), "utf8")).toBe("v2\n");
    expect(fs.existsSync(path.join(target(), "ref"))).toBe(false);
  });

  it("leaves the previous copy in place when the copy fails partway", () => {
    makeSource({ "SKILL.md": "v1\n" });
    installSkill(source, target());
    fs.writeFileSync(path.join(source, "SKILL.md"), "v2\n");

    expect(() =>
      installSkill(source, target(), {
        cp: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      }),
    ).toThrow(/ENOSPC/);

    expect(fs.readFileSync(path.join(target(), "SKILL.md"), "utf8")).toBe("v1\n");
    expect(leavings()).toEqual([]);
  });

  it("puts the previous copy back when the swap fails after it was retired", () => {
    makeSource({ "SKILL.md": "v1\n" });
    installSkill(source, target());
    fs.writeFileSync(path.join(source, "SKILL.md"), "v2\n");

    expect(() =>
      installSkill(source, target(), {
        rename: (from, to) => {
          if (from.includes(".mediagen-install-")) throw new Error("EXDEV: cross-device link");
          fs.renameSync(from, to);
        },
      }),
    ).toThrow(/EXDEV/);

    expect(fs.readFileSync(path.join(target(), "SKILL.md"), "utf8")).toBe("v1\n");
  });
});

/** Every staging or retired directory left inside the destination root. */
function leavings(): string[] {
  const root = path.dirname(target());
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((entry) => entry.startsWith(".mediagen-"));
}
