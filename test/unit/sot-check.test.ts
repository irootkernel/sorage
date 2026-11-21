import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const checker = fileURLToPath(new URL("../../scripts/sot-check.ts", import.meta.url));
const exchangeLoop = "# Exchange collaboration loop\n";
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
      "| GEN-001 | M1 | Scope holds. |",
      "| GEN-002 | M1 | Another rule holds. |",
      "| INIT-001 | M1 | Home directory is fixed. |",
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
      "| `EPIC-001` | Foundation | M1 | Planned | `TASK-001` to `TASK-002` |",
      "",
      "## EPIC-001: Foundation",
      "",
      "| Task ID | Status | Milestone | Deliverable | Acceptance gate | Dependencies | Requirements | Design Gate impact |",
      "|---|---|---|---|---|---|---|---|",
      "| `TASK-001` | Planned | M1 | First deliverable is one long unbroken line of prose. | Gate one. | None | GEN-001, GEN-002 to GEN-002, INIT-001 | Not required |",
      "| `TASK-002` | Planned | M1 | Second deliverable is also one long unbroken line of prose. | Gate two. | `TASK-001` | GEN-001 | Not required |",
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
      "| `GEN-001` | M1 | `TASK-001`, `TASK-002` |",
      "| `GEN-002` | M1 | `TASK-001` |",
      "| `INIT-001` | M1 | `TASK-001` |",
      "",
    ].join("\n"),
  );
  for (const skill of ["start-exchange", "join-exchange"]) {
    const references = join(root, "skills", skill, "references");
    mkdirSync(references, { recursive: true });
    writeFileSync(join(references, "exchange-loop.md"), exchangeLoop);
  }
  writeFileSync(join(root, "skills", "exchange-loop.md"), exchangeLoop);
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

  it.each(["start-exchange", "join-exchange"])("fails on byte drift in the %s bundle", (skill) => {
    const relative = join("skills", skill, "references", "exchange-loop.md");
    const root = docFixture((path) => writeFileSync(join(path, relative), `${exchangeLoop}\n`));
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${relative}: Exchange loop reference differs`);
    expect(readTheFile(join(root, relative))).toBe(`${exchangeLoop}\n`);
  });

  it("requires an actual local copy even when a symlink resolves to the canonical reference", () => {
    const relative = join("skills", "join-exchange", "references", "exchange-loop.md");
    const root = docFixture((path) => {
      rmSync(join(path, relative));
      symlinkSync(join(path, "skills", "exchange-loop.md"), join(path, relative));
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${relative}: Exchange loop reference must be a regular file`);
  });

  it("accepts M7 requirements, Tasks, and their matching reverse index", () => {
    const result = runCheck(
      docFixture((root) => {
        for (const relative of ["specs/required-specification.md", "roadmap/README.md", "specs/traceability.md"]) {
          const path = join(root, "docs", relative);
          writeFileSync(path, readTheFile(path).replaceAll("| M1 |", "| M7 |"));
        }
      }),
    );
    expect(result.status).toBe(0);
  });

  it("rejects an M6 requirement covered only by M7 Tasks", () => {
    const result = runCheck(
      docFixture((root) => {
        for (const relative of ["specs/required-specification.md", "specs/traceability.md"]) {
          const path = join(root, "docs", relative);
          writeFileSync(path, readTheFile(path).replaceAll("| M1 |", "| M6 |"));
        }
        const roadmap = join(root, "docs", "roadmap", "README.md");
        writeFileSync(roadmap, readTheFile(roadmap).replaceAll("| M1 |", "| M7 |"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requirement GEN-001 (milestone M6) is cited only by later-milestone Tasks");
  });

  it("rejects an M7 requirement covered only by M8 Tasks", () => {
    const result = runCheck(
      docFixture((root) => {
        for (const relative of ["specs/required-specification.md", "specs/traceability.md"]) {
          const path = join(root, "docs", relative);
          writeFileSync(path, readTheFile(path).replaceAll("| M1 |", "| M7 |"));
        }
        const roadmap = join(root, "docs", "roadmap", "README.md");
        writeFileSync(roadmap, readTheFile(roadmap).replaceAll("| M1 |", "| M8 |"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requirement GEN-001 (milestone M7) is cited only by later-milestone Tasks");
  });

  it("accepts M8 requirements, Tasks, and their matching reverse index", () => {
    const result = runCheck(
      docFixture((root) => {
        for (const relative of ["specs/required-specification.md", "roadmap/README.md", "specs/traceability.md"]) {
          const path = join(root, "docs", relative);
          writeFileSync(path, readTheFile(path).replaceAll("| M1 |", "| M8 |"));
        }
      }),
    );
    expect(result.status).toBe(0);
  });

  it("rejects an M8 requirement covered only by M9 Tasks", () => {
    const result = runCheck(
      docFixture((root) => {
        for (const relative of ["specs/required-specification.md", "specs/traceability.md"]) {
          const path = join(root, "docs", relative);
          writeFileSync(path, readTheFile(path).replaceAll("| M1 |", "| M8 |"));
        }
        const roadmap = join(root, "docs", "roadmap", "README.md");
        writeFileSync(roadmap, readTheFile(roadmap).replaceAll("| M1 |", "| M9 |"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requirement GEN-001 (milestone M8) is cited only by later-milestone Tasks");
  });

  it("accepts M9 requirements, Tasks, and their matching reverse index", () => {
    const result = runCheck(
      docFixture((root) => {
        for (const relative of ["specs/required-specification.md", "roadmap/README.md", "specs/traceability.md"]) {
          const path = join(root, "docs", relative);
          writeFileSync(path, readTheFile(path).replaceAll("| M1 |", "| M9 |"));
        }
      }),
    );
    expect(result.status).toBe(0);
  });

  it("rejects an M9 requirement covered only by M10 Tasks", () => {
    const result = runCheck(
      docFixture((root) => {
        for (const relative of ["specs/required-specification.md", "specs/traceability.md"]) {
          const path = join(root, "docs", relative);
          writeFileSync(path, readTheFile(path).replaceAll("| M1 |", "| M9 |"));
        }
        const roadmap = join(root, "docs", "roadmap", "README.md");
        writeFileSync(roadmap, readTheFile(roadmap).replaceAll("| M1 |", "| M10 |"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requirement GEN-001 (milestone M9) is cited only by later-milestone Tasks");
    expect(result.stderr).not.toContain("invalid milestone");
  });

  it("accepts M10 requirements, Tasks, and their matching reverse index", () => {
    const result = runCheck(
      docFixture((root) => {
        for (const relative of ["specs/required-specification.md", "roadmap/README.md", "specs/traceability.md"]) {
          const path = join(root, "docs", relative);
          writeFileSync(path, readTheFile(path).replaceAll("| M1 |", "| M10 |"));
        }
      }),
    );
    expect(result.status).toBe(0);
  });

  it("fails when an M10 requirement has no citing Task", () => {
    const result = runCheck(
      docFixture((root) => {
        const spec = join(root, "docs", "specs", "required-specification.md");
        writeFileSync(
          spec,
          readTheFile(spec).replace(
            "| INIT-001 | M1 | Home directory is fixed. |\n",
            "| INIT-001 | M1 | Home directory is fixed. |\n| EXC-001 | M10 | Exchange membership is explicit. |\n",
          ),
        );
        const traceability = join(root, "docs", "specs", "traceability.md");
        writeFileSync(
          traceability,
          readTheFile(traceability).replace(
            "| `INIT-001` | M1 | `TASK-001` |\n",
            "| `INIT-001` | M1 | `TASK-001` |\n| `EXC-001` | M10 | None |\n",
          ),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requirement EXC-001 (milestone M10) has no citing Task");
  });

  it("rejects an unadopted milestone beyond M10", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        writeFileSync(
          path,
          readTheFile(path).replace("| `TASK-002` | Planned | M1 |", "| `TASK-002` | Planned | M11 |"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid milestone "M11"');
  });

  it.each([
    ["an unadopted milestone", "M11"],
    ["a misspelled milestone", "m10"],
    ["an empty milestone", ""],
  ])("reports a requirement row with %s instead of skipping it", (_label, milestone) => {
    const result = runCheck(
      docFixture((root) => {
        const spec = join(root, "docs", "specs", "required-specification.md");
        writeFileSync(
          spec,
          readTheFile(spec).replace(
            "| GEN-002 | M1 | Another rule holds. |",
            `| GEN-002 | ${milestone} | Another rule holds. |`,
          ),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/specs/required-specification.md:6");
    expect(result.stderr).toContain(
      `requirement GEN-002 has unsupported milestone ${JSON.stringify(milestone)}; expected M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, or Deferred`,
    );
    expect(result.stderr.split("requirement GEN-002 has unsupported milestone")).toHaveLength(2);
    // TASK-001 cites GEN-002 and the reverse index lists it, so a discarded row would surface here.
    expect(result.stderr).not.toContain("unknown requirement");
    expect(result.stderr).not.toContain("missing its row");
    expect(result.stderr).not.toContain("absent from the specification");
  });

  it("reports a requirement row that lacks its text and keeps the requirement known", () => {
    const result = runCheck(
      docFixture((root) => {
        const spec = join(root, "docs", "specs", "required-specification.md");
        writeFileSync(spec, readTheFile(spec).replace("| GEN-002 | M1 | Another rule holds. |", "| GEN-002 | M1 |"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/specs/required-specification.md:6");
    expect(result.stderr.split("malformed requirement row for GEN-002")).toHaveLength(2);
    expect(result.stderr).not.toContain("unknown requirement");
    expect(result.stderr).not.toContain("absent from the specification");
  });

  it("reports a requirement row whose identifier is code-formatted", () => {
    const result = runCheck(
      docFixture((root) => {
        const spec = join(root, "docs", "specs", "required-specification.md");
        writeFileSync(spec, readTheFile(spec).replace("| GEN-002 | M1 |", "| `GEN-002` | M1 |"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("malformed requirement row for GEN-002");
  });

  it("reports a second definition of a requirement", () => {
    const result = runCheck(
      docFixture((root) => {
        const spec = join(root, "docs", "specs", "required-specification.md");
        writeFileSync(
          spec,
          readTheFile(spec).replace(
            "| INIT-001 | M1 | Home directory is fixed. |\n",
            "| INIT-001 | M1 | Home directory is fixed. |\n| GEN-002 | M1 | A conflicting rule holds. |\n",
          ),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/specs/required-specification.md:8");
    expect(result.stderr).toContain("duplicate requirement identifier GEN-002");
  });

  it("accepts an escaped pipe inside requirement text and Task prose", () => {
    const result = runCheck(
      docFixture((root) => {
        const spec = join(root, "docs", "specs", "required-specification.md");
        writeFileSync(spec, readTheFile(spec).replace("Another rule holds.", "The role is worker\\|judge."));
        const roadmap = join(root, "docs", "roadmap", "README.md");
        writeFileSync(roadmap, readTheFile(roadmap).replace("| Gate two. |", "| Gate two accepts a\\|b. |"));
      }),
    );
    expect(result.status).toBe(0);
  });

  it("ends a cell at a pipe that follows an even run of backslashes", () => {
    const result = runCheck(
      docFixture((root) => {
        const roadmap = join(root, "docs", "roadmap", "README.md");
        writeFileSync(
          roadmap,
          readTheFile(roadmap).replace("line of prose. | Gate two. |", "line of prose.\\\\| Gate two. |"),
        );
      }),
    );
    // Two literal backslashes do not escape the delimiter, so TASK-002 keeps its eight cells.
    expect(result.status).toBe(0);
  });

  it("reports a requirement row whose text continues in a fourth cell", () => {
    const result = runCheck(
      docFixture((root) => {
        const spec = join(root, "docs", "specs", "required-specification.md");
        writeFileSync(
          spec,
          readTheFile(spec).replace(
            "| GEN-002 | M1 | Another rule holds. |",
            "| GEN-002 | M1 | Keep A | MUST also keep B. |",
          ),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/specs/required-specification.md:6");
    expect(result.stderr).toContain("malformed requirement row for GEN-002");
  });

  it("reports a requirement row whose rendered text cell is empty", () => {
    const result = runCheck(
      docFixture((root) => {
        const spec = join(root, "docs", "specs", "required-specification.md");
        writeFileSync(
          spec,
          readTheFile(spec).replace(
            "| GEN-002 | M1 | Another rule holds. |",
            "| GEN-002 | M1 | | Another rule holds. |",
          ),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/specs/required-specification.md:6");
    expect(result.stderr).toContain("malformed requirement row for GEN-002");
  });

  it("reports a reverse-index row whose identifier is padded inside its code span", () => {
    const result = runCheck(
      docFixture((root) => {
        const traceability = join(root, "docs", "specs", "traceability.md");
        writeFileSync(
          traceability,
          readTheFile(traceability).replace("| `GEN-002` | M1 | `TASK-001` |", "| ` GEN-002 ` | M11 | `TASK-001` |"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/specs/traceability.md:8");
    expect(result.stderr).toContain("malformed reverse-index row for GEN-002");
  });

  it("reports a Task row with a status outside the canonical set", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        writeFileSync(path, readTheFile(path).replace("| `TASK-002` | Planned |", "| `TASK-002` | Planed |"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/roadmap/README.md:12");
    expect(result.stderr).toContain(
      'Task TASK-002 has invalid status "Planed"; expected Planned, In Progress, In Review, Completed, Blocked, or Deferred',
    );
  });

  it("reports a requirement range that spans two namespaces", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        writeFileSync(
          path,
          readTheFile(path).replace("GEN-001, GEN-002 to GEN-002, INIT-001", "GEN-002, GEN-001 to INIT-001"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/roadmap/README.md:11");
    expect(result.stderr).toContain('Task TASK-001 cites the invalid requirement range "GEN-001 to INIT-001"');
  });

  it("expands a range to the requirements between its endpoints", () => {
    const withRange = (citation: string) =>
      runCheck(
        docFixture((root) => {
          const spec = join(root, "docs", "specs", "required-specification.md");
          writeFileSync(
            spec,
            readTheFile(spec).replace(
              "| GEN-002 | M1 | Another rule holds. |\n",
              "| GEN-002 | M1 | Another rule holds. |\n| GEN-003 | M1 | A third rule holds. |\n",
            ),
          );
          const roadmap = join(root, "docs", "roadmap", "README.md");
          writeFileSync(roadmap, readTheFile(roadmap).replace("GEN-001, GEN-002 to GEN-002, INIT-001", citation));
          const traceability = join(root, "docs", "specs", "traceability.md");
          writeFileSync(
            traceability,
            readTheFile(traceability).replace(
              "| `GEN-002` | M1 | `TASK-001` |\n",
              "| `GEN-002` | M1 | `TASK-001` |\n| `GEN-003` | M1 | `TASK-001` |\n",
            ),
          );
        }),
      );
    // GEN-002 is cited only through the range, and the reverse index lists TASK-001 for it.
    expect(withRange("GEN-001 to GEN-003, INIT-001").status).toBe(0);
    const endpointsOnly = withRange("GEN-001, GEN-003, INIT-001");
    expect(endpointsOnly.status).toBe(1);
    expect(endpointsOnly.stderr).toContain("reverse-index citing tasks for GEN-002 disagree");
  });

  it("reports a reverse-index row with an unsupported milestone instead of skipping it", () => {
    const result = runCheck(
      docFixture((root) => {
        const traceability = join(root, "docs", "specs", "traceability.md");
        writeFileSync(
          traceability,
          readTheFile(traceability).replace("| `GEN-002` | M1 | `TASK-001` |", "| `GEN-002` | M11 | `TASK-001` |"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/specs/traceability.md:8");
    expect(result.stderr).toContain(
      'reverse-index row GEN-002 has unsupported milestone "M11"; expected M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, or Deferred',
    );
    expect(result.stderr).not.toContain("missing its row for GEN-002");
  });

  it("reports a reverse-index row that lacks its citing-task cell", () => {
    const result = runCheck(
      docFixture((root) => {
        const traceability = join(root, "docs", "specs", "traceability.md");
        writeFileSync(
          traceability,
          readTheFile(traceability).replace("| `GEN-002` | M1 | `TASK-001` |", "| `GEN-002` | M1 |"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/specs/traceability.md:8");
    expect(result.stderr).toContain("malformed reverse-index row for GEN-002");
  });

  it("reports a padded second reverse-index row instead of skipping it", () => {
    const result = runCheck(
      docFixture((root) => {
        const traceability = join(root, "docs", "specs", "traceability.md");
        writeFileSync(
          traceability,
          readTheFile(traceability).replace(
            "| `GEN-002` | M1 | `TASK-001` |\n",
            "| `GEN-002` | M1 | `TASK-001` |\n|  `GEN-002`  | M11 | `TASK-001` |\n",
          ),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/specs/traceability.md:9");
    expect(result.stderr).toContain('reverse-index row GEN-002 has unsupported milestone "M11"');
    expect(result.stderr).toContain("duplicate reverse-index row GEN-002");
  });

  it.each([
    ["an unformatted Task identifier", "TASK-001"],
    ["text that names no Task", "nonsense"],
    ["text around a Task identifier", "see `TASK-001`"],
  ])("reports a reverse-index citing cell with %s", (_label, citing) => {
    const result = runCheck(
      docFixture((root) => {
        const traceability = join(root, "docs", "specs", "traceability.md");
        writeFileSync(
          traceability,
          readTheFile(traceability).replace("| `GEN-002` | M1 | `TASK-001` |", `| \`GEN-002\` | M1 | ${citing} |`),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/specs/traceability.md:8");
    expect(result.stderr).toContain("malformed reverse-index row for GEN-002");
  });

  it("accepts a Deferred requirement only with an exact None citing cell", () => {
    const withDeferred = (citing: string) =>
      runCheck(
        docFixture((root) => {
          const spec = join(root, "docs", "specs", "required-specification.md");
          writeFileSync(
            spec,
            readTheFile(spec).replace(
              "| INIT-001 | M1 | Home directory is fixed. |\n",
              "| INIT-001 | M1 | Home directory is fixed. |\n| FUT-001 | Deferred | A later rule holds. |\n",
            ),
          );
          const traceability = join(root, "docs", "specs", "traceability.md");
          writeFileSync(
            traceability,
            readTheFile(traceability).replace(
              "| `INIT-001` | M1 | `TASK-001` |\n",
              `| \`INIT-001\` | M1 | \`TASK-001\` |\n| \`FUT-001\` | Deferred | ${citing} |\n`,
            ),
          );
        }),
      );
    expect(withDeferred("None").status).toBe(0);
    const result = withDeferred("nonsense");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/specs/traceability.md:10");
    expect(result.stderr).toContain("malformed reverse-index row for FUT-001");
  });

  it("reports a Task row that lost a cell instead of skipping it", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        writeFileSync(
          path,
          readTheFile(path).replace("| `TASK-002` | Planned | M1 | Second", "| `TASK-002` | Planned M1 | Second"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/roadmap/README.md:12");
    expect(result.stderr.split("malformed Task row for TASK-002")).toHaveLength(2);
  });

  it("keeps a last Task row whose cell delimiters lost their spacing", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        writeFileSync(path, readTheFile(path).replace("| `TASK-002` | Planned | M1 |", "| `TASK-002` | Planned |M11|"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Task TASK-002 has invalid milestone "M11"');
  });

  it.each([
    ["Dependencies", "| Gate two. | `TASK-001` | GEN-001 |", "| Gate two. | nonsense | GEN-001 |"],
    ["Requirements", "| Gate two. | `TASK-001` | GEN-001 |", "| Gate two. | `TASK-001` | nonsense |"],
  ])("reports a Task row with a malformed %s cell instead of reading it as None", (column, from, to) => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        writeFileSync(path, readTheFile(path).replace(from, to));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/roadmap/README.md:12");
    expect(result.stderr).toContain(`Task TASK-002 has a malformed ${column} cell`);
  });

  it("fails when an M8 requirement has no citing Task", () => {
    const result = runCheck(
      docFixture((root) => {
        const spec = join(root, "docs", "specs", "required-specification.md");
        writeFileSync(
          spec,
          readTheFile(spec).replace(
            "| INIT-001 | M1 | Home directory is fixed. |\n",
            "| INIT-001 | M1 | Home directory is fixed. |\n| PFL-001 | M8 | Inspection stays non-mutating. |\n",
          ),
        );
        const traceability = join(root, "docs", "specs", "traceability.md");
        writeFileSync(
          traceability,
          readTheFile(traceability).replace(
            "| `INIT-001` | M1 | `TASK-001` |\n",
            "| `INIT-001` | M1 | `TASK-001` |\n| `PFL-001` | M8 | None |\n",
          ),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requirement PFL-001 (milestone M8) has no citing Task");
  });

  it("fails when an M8 Task depends on a later Task", () => {
    const result = runCheck(
      docFixture((root) => {
        for (const relative of ["specs/required-specification.md", "roadmap/README.md", "specs/traceability.md"]) {
          const path = join(root, "docs", relative);
          writeFileSync(path, readTheFile(path).replaceAll("| M1 |", "| M8 |"));
        }
        const roadmap = join(root, "docs", "roadmap", "README.md");
        writeFileSync(roadmap, readTheFile(roadmap).replace("| None | GEN-001", "| `TASK-002` | GEN-001"));
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("depends on later or equal Task TASK-002");
  });

  it("fails when an M8 reverse-index row disagrees", () => {
    const result = runCheck(
      docFixture((root) => {
        for (const relative of ["specs/required-specification.md", "roadmap/README.md", "specs/traceability.md"]) {
          const path = join(root, "docs", relative);
          writeFileSync(path, readTheFile(path).replaceAll("| M1 |", "| M8 |"));
        }
        const traceability = join(root, "docs", "specs", "traceability.md");
        writeFileSync(
          traceability,
          readTheFile(traceability).replace(
            "| `GEN-001` | M8 | `TASK-001`, `TASK-002` |",
            "| `GEN-001` | M7 | `TASK-001`, `TASK-002` |",
          ),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reverse-index milestone M7 for GEN-001 disagrees with the specification's M8");
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
          text.replace("| `TASK-002` | Planned | M1 | Second", "| `TASK-001` | Planned | M1 | Second"),
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

  it("fails on a M1 requirement cited only by later-milestone Tasks and expands range citations", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        const text = readTheFile(path);
        // Remove the TASK-001 citation cell content for GEN-002 so only a M3 task cites it.
        writeFileSync(
          path,
          text
            .replace("GEN-001, GEN-002 to GEN-002, INIT-001", "GEN-001, INIT-001")
            .replace("| `TASK-002` | Planned | M1 |", "| `TASK-002` | Planned | M3 |")
            .replace("| Gate two. | `TASK-001` | GEN-001 |", "| Gate two. | `TASK-001` | GEN-002 |"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cited only by later-milestone Tasks");
  });

  it("fails when a Task uses a numeric release version as its milestone", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "roadmap", "README.md");
        writeFileSync(
          path,
          readTheFile(path).replace("| `TASK-002` | Planned | M1 |", "| `TASK-002` | Planned | 0.1 |"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid milestone "0.1"; expected M1, M2, M3, M4, M5, M6, M7, M8, M9, or M10');
  });

  it("fails when the reverse index disagrees with the roadmap's Requirements column", () => {
    const result = runCheck(
      docFixture((root) => {
        const path = join(root, "docs", "specs", "traceability.md");
        writeFileSync(
          path,
          readTheFile(path).replace("| `GEN-001` | M1 | `TASK-001`, `TASK-002` |", "| `GEN-001` | M1 | `TASK-001` |"),
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
        writeFileSync(path, readTheFile(path).replace("| `INIT-001` | M1 | `TASK-001` |\n", ""));
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
          readTheFile(traceability).replace("| `INIT-001` | M1 | `TASK-001` |", "| `INIT-001` | M1 | None |"),
        );
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requirement INIT-001 (milestone M1) has no citing Task");
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
