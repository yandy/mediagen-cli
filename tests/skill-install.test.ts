import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSkill, bundledSkillNames, bundledSkillsDir, installSkills } from "../src/skill.js";

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

describe("bundledSkillNames", () => {
  it("lists the skill directories this package ships, in a stable order", () => {
    // fileURLToPath keeps the trailing separator of "../skills/", so resolve first.
    expect(path.resolve(bundledSkillsDir())).toBe(path.join(process.cwd(), "skills"));
    expect(bundledSkillNames()).toEqual(["mediagen"]);
  });
});

describe("installSkills", () => {
  it("installs the packaged skill byte-identically and reports an absolute path", () => {
    const lambda = path.join(tempDir, "lambda");

    const installed = installSkills(lambda);

    const shipped = path.join(process.cwd(), "skills", "mediagen", "SKILL.md");
    expect(installed).toEqual([
      { name: "mediagen", path: path.join(lambda, "mediagen"), replaced: false },
    ]);
    expect(fs.readFileSync(path.join(lambda, "mediagen", "SKILL.md"), "utf8")).toBe(
      fs.readFileSync(shipped, "utf8"),
    );
  });

  it("expands a leading ~/ against the home directory", () => {
    const home = path.join(tempDir, "home");
    fs.mkdirSync(home, { recursive: true });
    const previous = process.env.HOME;
    process.env.HOME = home;

    try {
      const installed = installSkills("~/.claude/skills");
      expect(installed[0]?.path).toBe(path.join(home, ".claude", "skills", "mediagen"));
      expect(fs.existsSync(path.join(home, ".claude", "skills", "mediagen", "SKILL.md"))).toBe(true);
    } finally {
      process.env.HOME = previous;
    }
  });

  it("creates a deeply nested destination from a relative argument", () => {
    // Relative to the repository root, but inside the temp dir: a test that wrote into the
    // checkout would trip the sandbox guard in vitest.sandbox.ts.
    const relative = path.relative(process.cwd(), path.join(tempDir, "deep", "a", "b"));
    const installed = installSkills(relative);

    expect(path.isAbsolute(installed[0]!.path)).toBe(true);
    expect(installed[0]!.path).toBe(path.join(tempDir, "deep", "a", "b", "mediagen"));
    expect(installed[0]!.path).not.toContain("//");
  });

  it("replaces a previously installed copy", () => {
    installSkills(tempDir);
    expect(installSkills(tempDir)[0]?.replaced).toBe(true);
  });

  it("refuses an empty destination", () => {
    expect(() => installSkills("  ")).toThrow(/--dir/);
  });

  it("refuses a destination that is a file", () => {
    const blocker = path.join(tempDir, "file");
    fs.writeFileSync(blocker, "x");

    expect(() => installSkills(blocker)).toThrow(/not a directory/);
  });

  it("refuses a destination it cannot create", () => {
    const blocker = path.join(tempDir, "file");
    fs.writeFileSync(blocker, "x");

    expect(() => installSkills(path.join(blocker, "skills"))).toThrow(/cannot create/);
  });
});
