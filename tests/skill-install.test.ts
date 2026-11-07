import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
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
    expect(leavings()).toEqual([]);
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

  it("refuses a file sitting where the skill directory belongs", () => {
    makeSource({ "SKILL.md": "v1\n" });
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.writeFileSync(target(), "my own notes\n");

    expect(() => installSkill(source, target())).toThrow(/not a directory/);
    expect(fs.readFileSync(target(), "utf8")).toBe("my own notes\n");
  });

  it("refuses a symlink sitting where the skill directory belongs", () => {
    makeSource({ "SKILL.md": "v1\n" });
    const elsewhere = path.join(tempDir, "elsewhere");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.symlinkSync(elsewhere, target(), "dir");

    expect(() => installSkill(source, target())).toThrow(/not a directory/);
    expect(fs.lstatSync(target()).isSymbolicLink()).toBe(true);
  });

  it("keeps the previous copy when it cannot be put back", () => {
    makeSource({ "SKILL.md": "v1\n" });
    installSkill(source, target());
    fs.writeFileSync(path.join(source, "SKILL.md"), "v2\n");

    expect(() =>
      installSkill(source, target(), {
        // Every rename of a hidden path fails: the retire and the restore both.
        rename: (from, to) => {
          if (from.includes(".mediagen-")) throw new Error("EROFS: read-only file system");
          fs.renameSync(from, to);
        },
      }),
    ).toThrow(/could not be put back/);

    const kept = leavings().map((name) => path.join(path.dirname(target()), name));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(kept[0]!, "SKILL.md"), "utf8")).toBe("v1\n");
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

  it("fails when the packaged skills are missing, and creates nothing", () => {
    const destination = path.join(tempDir, "dest");
    const missing = path.join(tempDir, "no-skills");

    expect(() =>
      installSkills(destination, { sourceRoot: missing }),
    ).toThrow(/were not found/);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("fails when the packaged skills directory is empty", () => {
    const destination = path.join(tempDir, "dest");
    const empty = path.join(tempDir, "empty-skills");
    fs.mkdirSync(empty, { recursive: true });

    expect(() =>
      installSkills(destination, { sourceRoot: empty }),
    ).toThrow(/no skills were found/);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("refuses an existing destination it cannot write to", () => {
    const sealed = path.join(tempDir, "sealed");
    fs.mkdirSync(sealed);
    fs.chmodSync(sealed, 0o555);

    try {
      expect(() => installSkills(sealed)).toThrow(/cannot write to the skills directory/);
    } finally {
      fs.chmodSync(sealed, 0o755);
    }
  });

  it("expands a bare ~ and leaves a ~user form alone", () => {
    const home = path.join(tempDir, "home2");
    fs.mkdirSync(home, { recursive: true });
    const previousHome = process.env.HOME;
    const previousCwd = process.cwd();
    process.env.HOME = home;
    process.chdir(tempDir);

    try {
      expect(installSkills("~")[0]?.path).toBe(path.join(home, "mediagen"));
      expect(installSkills("~nobody/skills")[0]?.path).toBe(
        path.join(tempDir, "~nobody", "skills", "mediagen"),
      );
    } finally {
      process.chdir(previousCwd);
      process.env.HOME = previousHome;
    }
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

let outChunks: string[] = [];
let errChunks: string[] = [];

/** Collects writes instead of letting them reach the terminal. */
function writer(sink: string[]): typeof process.stdout.write {
  return ((chunk: unknown): boolean => {
    sink.push(String(chunk));
    return true;
  }) as unknown as typeof process.stdout.write;
}

async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  outChunks = [];
  errChunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation(writer(outChunks));
  vi.spyOn(process.stderr, "write").mockImplementation(writer(errChunks));
  const code = await main(argv);
  vi.restoreAllMocks();
  return { code, stdout: outChunks.join(""), stderr: errChunks.join("") };
}

describe("skills install", () => {
  it("installs into --dir and prints the path on stdout only", async () => {
    const result = await runCli(["skills", "install", "--dir", tempDir]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${path.join(tempDir, "mediagen")}\n`);
    expect(result.stderr).toBe("");
    expect(fs.existsSync(path.join(tempDir, "mediagen", "SKILL.md"))).toBe(true);
  });

  it("prints one JSON object with --json", async () => {
    const result = await runCli(["skills", "install", "--dir", tempDir, "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      skills: [{ name: "mediagen", path: path.join(tempDir, "mediagen"), replaced: false }],
    });
  });

  it("notes a replacement on stderr and still prints the path on stdout", async () => {
    await runCli(["skills", "install", "--dir", tempDir]);
    const second = await runCli(["skills", "install", "--dir", tempDir]);

    expect(second.code).toBe(0);
    expect(second.stderr).toMatch(/replaced/);
    expect(second.stdout).toBe(`${path.join(tempDir, "mediagen")}\n`);
  });

  it("notes that --dir already holds a SKILL.md, instead of nesting quietly", async () => {
    const skillDir = path.join(tempDir, "a", "skills", "mediagen");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: mine\n---\n");

    const result = await runCli(["skills", "install", "--dir", skillDir]);

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/already holds a SKILL\.md/);
    expect(result.stdout).toBe(`${path.join(skillDir, "mediagen")}\n`);
  });

  it("reports a missing --dir as a usage error", async () => {
    const result = await runCli(["skills", "install"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--dir/);
  });

  it("reports a missing --dir as JSON when --json is given", async () => {
    const result = await runCli(["skills", "install", "--json"]);

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).error.message).toMatch(/--dir/);
  });

  it("lists the command in --help", async () => {
    const result = await runCli(["--help"]);

    expect(result.stdout).toMatch(/skills install/);
  });
});
