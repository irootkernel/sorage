import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const checker = fileURLToPath(new URL("../../scripts/sot-check.ts", import.meta.url));
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function docFixture(mutate: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "sorage-sot-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "specs"), { recursive: true });
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true });
  writeFileSync(
    join(root, "docs", "specs", "required-specification.md"),
    [
      "# Required specification",
      "",
      "| ID | Milestone | Requirement |",
      "|---|---|---|",
      "| GEN-001 | 0.1 | Scope holds. |",
      "| GEN-002 | 0.1 | Another rule holds. |",
      "| INIT-001 | 0.1 | Home directory is fixed. |",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "docs", "roadmap", "README.md"),
    [
      "# Roadmap",
      "",
      "| Epic ID | Title | Milestone | Status | Task range |",
      "|---|---|---|---|---|",
      "| `EPIC-001` | Foundation | 0.1 | Planned | `TASK-001` to `TASK-002` |",
      "",
      "## EPIC-001: Foundation",
      "",
      "| Task ID | Status | Milestone | Deliverable | Acceptance gate | Dependencies | Requirements | Design Gate impact |",
      "|---|---|---|---|---|---|---|---|",
      "| `TASK-001` | Planned | 0.1 | First deliverable is one long unbroken line of prose. | Gate one. | None | GEN-001, GEN-002 to GEN-002, INIT-001 | Not required |",
      "| `TASK-002` | Planned | 0.1 | Second deliverable is also one long unbroken line of prose. | Gate two. | `TASK-001` | GEN-001 | Not required |",
      "",
      "See [required-specification.md](../specs/required-specification.md) for the requirements.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "docs", "specs", "traceability.md"),
    [
      "# Requirement Traceability",
      "",
      "## 3. Reverse index",
      "",
      "| Requirement | Milestone | Citing tasks |",
      "|---|---|---|",
      "| `GEN-001` | 0.1 | `TASK-001`, `TASK-002` |",
      "| `GEN-002` | 0.1 | `TASK-001` |",
      "| `INIT-001` | 0.1 | `TASK-001` |",
      "",
    ].join("\n"),
  );
  mutate(root);
  return root;
}

function runCheck(root: string): { status: number | null; stderr: string } {
  const result = spawnSync("bun", [checker, root], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr ?? "" };
}

describe("sot-check", () => {
  it("passes against a consistent document set", () => {
    const result = runCheck(docFixture(() => undefined));
    expect(result.status).toBe(0);
  });

  it("fails on hard-wrapped prose with the offending line", () => {
    const result = runCheck(
      docFixture((root) => {
        writeFileSync(join(root, "docs", "notes.md"), "This paragraph is wrapped across\ntwo source lines.\n");
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/notes.md:2");
    expect(result.stderr).toContain("hard-wrapped prose");
  });

  it("fails on an unresolvable relative link", () => {
    const result = runCheck(
      docFixture((root) => {
        writeFileSync(join(root, "docs", "notes.md"), "See [missing](no-such-file.md) for details.\n");
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unresolvable relative link 'no-such-file.md'");
  });

  it("fails on a duplicate Task identifier", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        const text = readTheFile(path);
        writeFileSync(
          path,
          text.replace("| `TASK-002` | Planned | 0.1 | Second", "| `TASK-001` | Planned | 0.1 | Second"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("duplicate Task identifier TASK-001");
  });

  it("fails on a dependency on a later Task", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        const text = readTheFile(path);
        writeFileSync(path, text.replace("| None | GEN-001", "| `TASK-002` | GEN-001"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("depends on later or equal Task TASK-002");
  });

  it("fails on a self dependency", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        const text = readTheFile(path);
        writeFileSync(
          path,
          text.replace("| Gate two. | `TASK-001` | GEN-001 |", "| Gate two. | `TASK-002` | GEN-001 |"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/depends on itself/);
  });

  it("fails on a citation of an unknown requirement identifier", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        const text = readTheFile(path);
        writeFileSync(path, text.replace("INIT-001", "INIT-999"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cites unknown requirement INIT-999");
  });

  it("fails on a 0.1 requirement cited only by later-milestone Tasks and expands range citations", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        const text = readTheFile(path);
        // Remove the TASK-001 citation cell content for GEN-002 so only a 0.3 task cites it.
        writeFileSync(
          path,
          text
            .replace("GEN-001, GEN-002 to GEN-002, INIT-001", "GEN-001, INIT-001")
            .replace("| `TASK-002` | Planned | 0.1 |", "| `TASK-002` | Planned | 0.3 |")
            .replace("| Gate two. | `TASK-001` | GEN-001 |", "| Gate two. | `TASK-001` | GEN-002 |"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cited only by later-milestone Tasks");
  });

  it("fails when the reverse index disagrees with the roadmap's Requirements column", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "specs", "traceability.md");
        writeFileSync(
          path,
          readTheFile(path).replace("| `GEN-001` | 0.1 | `TASK-001`, `TASK-002` |", "| `GEN-001` | 0.1 | `TASK-001` |"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reverse-index citing tasks for GEN-001 disagree");
  });

  it("fails when the reverse index is missing its row for a requirement", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "specs", "traceability.md");
        writeFileSync(path, readTheFile(path).replace("| `INIT-001` | 0.1 | `TASK-001` |\n", ""));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing its row for INIT-001");
  });

  it("fails when a non-Deferred requirement has no citing Task", () => {
    const result = runCheck(
      docFixture((root) => {
        const roadmap = join(root, "docs", "roadmap", "README.md");
        writeFileSync(
          roadmap,
          readTheFile(roadmap).replace("GEN-001, GEN-002 to GEN-002, INIT-001", "GEN-001, GEN-002 to GEN-002"),
        );
        const traceability = join(root, "docs", "specs", "traceability.md");
        writeFileSync(
          traceability,
          readTheFile(traceability).replace("| `INIT-001` | 0.1 | `TASK-001` |", "| `INIT-001` | 0.1 | None |"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requirement INIT-001 (milestone 0.1) has no citing Task");
  });

  it("fails when the traceability reverse index is absent", () => {
    const result = runCheck(
      docFixture((root) => {
        rmSync(join(root, "docs", "specs", "traceability.md"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the traceability reverse index is absent");
  });
});

import { readFileSync } from "node:fs";
function readTheFile(path: string): string {
  return readFileSync(path, "utf8");
}
