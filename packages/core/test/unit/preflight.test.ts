import { describe, expect, it } from "vitest";
import {
  PREFLIGHT_CHECK_IDS,
  assessPreflight,
  parsePreflightReport,
  preflightEnvelope,
  preflightExitCode,
  type PreflightCheckId,
  type PreflightFacts,
  type PreflightReport,
  type PreflightResidueEntry,
  type PreflightStatus,
} from "../../src/preflight";

const permittedResidue: PreflightResidueEntry[] = [
  { kind: "directory", name: "logs" },
  { kind: "directory", name: "state" },
  { kind: "directory", name: "run" },
  { kind: "logs-file", name: "sorage.log" },
  { kind: "logs-file", name: "sorage.log.1" },
  { kind: "logs-file", name: "sorage.log.12" },
];

function currentFacts(patch: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    home: { kind: "installed" },
    snapshot: { kind: "coherent", staleFence: false },
    config: { kind: "supported" },
    database: { kind: "current-ordered" },
    integrity: { kind: "passed" },
    vault: { kind: "supported" },
    identity: { kind: "consistent", row: "present" },
    ...patch,
  };
}

function check(report: PreflightReport, id: PreflightCheckId) {
  const found = report.checks.find((item) => item.id === id);
  if (found === undefined) throw new Error(id);
  return found;
}

function issue(value: unknown): string {
  const parsed = parsePreflightReport(value);
  if (parsed.ok) throw new Error("expected rejection");
  return parsed.issue;
}

function expectCatalog(report: PreflightReport): void {
  expect(report.contractVersion).toBe(1);
  expect(report.checks.map((item) => item.id)).toEqual([...PREFLIGHT_CHECK_IDS]);
}

describe("preflight assessment", () => {
  it("accepts an absent home as fresh and leaves the other checks inapplicable", () => {
    const report = assessPreflight(currentFacts({ home: { kind: "absent" }, config: { kind: "newer" } }));
    expectCatalog(report);
    expect(report.status).toBe("fresh");
    expect(preflightExitCode(report.status)).toBe(0);
    expect(check(report, "home.state")).toMatchObject({ severity: "ok", message: "The selected home is absent." });
    expect(check(report, "home.state").recovery?.message).toContain("does not authorize initialization");
    for (const id of PREFLIGHT_CHECK_IDS.slice(1)) {
      expect(check(report, id).severity).not.toBe("ok");
      expect(check(report, id).message).toContain("does not apply");
    }
  });

  it("accepts an empty home as fresh", () => {
    const report = assessPreflight(currentFacts({ home: { kind: "empty" } }));
    expect(report.status).toBe("fresh");
    expect(check(report, "home.state").severity).toBe("ok");
  });

  it("accepts permitted residue as fresh with a home warning and no installation authority", () => {
    const report = assessPreflight(currentFacts({ home: { kind: "residue", entries: permittedResidue } }));
    expect(report.status).toBe("fresh");
    expect(preflightExitCode(report.status)).toBe(0);
    const home = check(report, "home.state");
    expect(home.severity).toBe("warning");
    expect(home.message).toContain("not installation authority");
    expect(home.recovery?.message).toContain("does not authorize initialization");
    expect(home.recovery?.suggestedCommand).toBeUndefined();
  });

  it("accepts empty logs, empty state, empty run, and logs-only residue as fresh", () => {
    const subsets: PreflightResidueEntry[][] = [
      [{ kind: "directory", name: "logs" }],
      [{ kind: "directory", name: "state" }],
      [{ kind: "directory", name: "run" }],
      [
        { kind: "directory", name: "logs" },
        { kind: "logs-file", name: "sorage.log" },
        { kind: "logs-file", name: "sorage.log.1" },
      ],
    ];
    for (const entries of subsets) {
      const report = assessPreflight(currentFacts({ home: { kind: "residue", entries } }));
      expect(report.status).toBe("fresh");
      expect(preflightExitCode(report.status)).toBe(0);
      expect(check(report, "home.state").severity).toBe("warning");
    }
  });

  it("does not treat a root-level sorage.log or other flat name as a log inside logs", () => {
    for (const name of ["sorage.log", "config.yaml"]) {
      const report = assessPreflight(
        currentFacts({ home: { kind: "residue", entries: [{ kind: "unqualified", scope: "root", name }] } }),
      );
      expect(report.status).toBe("recovery_required");
      expect(check(report, "home.state").severity).toBe("blocking");
    }
  });

  it.each([
    { kind: "unqualified", scope: "root", name: "config.yaml" },
    { kind: "unqualified", scope: "root", name: "logs" },
    { kind: "logs-file", name: "sorage.log.0" },
    { kind: "logs-file", name: "sorage.log.01" },
    { kind: "unqualified", scope: "logs", name: "note.txt" },
    { kind: "unqualified", scope: "state", name: "lock" },
  ] as const)("rejects a residue inventory that is not the permitted set", (intruder) => {
    const report = assessPreflight(
      currentFacts({ home: { kind: "residue", entries: [...permittedResidue, intruder] } }),
    );
    expect(report.status).toBe("recovery_required");
    expect(preflightExitCode(report.status)).toBe(78);
    expect(check(report, "home.state").severity).toBe("blocking");
  });

  it("reports an unreadable home with an unavailable snapshot as unverified", () => {
    const report = assessPreflight(
      currentFacts({
        home: { kind: "unreadable" },
        snapshot: { kind: "unavailable" },
        config: { kind: "unverified" },
        database: { kind: "unverified" },
        integrity: { kind: "unverified" },
        vault: { kind: "unverified" },
        identity: { kind: "unverified" },
      }),
    );
    expect(report.status).toBe("unverifiable");
    expect(preflightExitCode(report.status)).toBe(75);
    const downstream = report.checks.slice(1);
    expect(downstream.every((item) => item.message === "This check does not apply to the selected home.")).toBe(false);
    expect(check(report, "source.snapshot").message).toBe("A coherent snapshot was not available.");
    for (const id of [
      "config.schema",
      "db.schema",
      "db.integrity",
      "vault.marker",
      "installation.identity",
      "upgrade.preparation",
    ] as const) {
      expect(check(report, id).message).toBe("This check could not be verified.");
    }
  });

  it.each(["unreadable", "broken-link", "non-directory"] as const)("does not call an unreadable home fresh", (kind) => {
    const report = assessPreflight(currentFacts({ home: { kind }, config: { kind: "newer" } }));
    expect(report.status).toBe("unverifiable");
    expect(preflightExitCode(report.status)).toBe(75);
    expect(check(report, "home.state").severity).toBe("blocking");
    expect(check(report, "home.state").message).toContain("not fresh");
  });

  it("keeps recovery_required for a partial home while another check cannot complete", () => {
    const report = assessPreflight(currentFacts({ home: { kind: "partial" }, snapshot: { kind: "unverified" } }));
    expect(report.status).toBe("recovery_required");
    expect(check(report, "source.snapshot").severity).not.toBe("ok");
    expect(check(report, "source.snapshot").message).toContain("could not be verified");
  });

  it("requires recovery for an unexplained readable inventory", () => {
    const report = assessPreflight(currentFacts({ home: { kind: "unexplained" } }));
    expect(report.status).toBe("recovery_required");
    expect(check(report, "home.state").recovery?.message).toContain("Do not initialize");
  });

  it.each(["config", "database", "vault"] as const)(
    "reports a readable newer schema as unsupported while other checks are unfinished",
    (which) => {
      const report = assessPreflight(
        currentFacts({
          config: which === "config" ? { kind: "newer" } : { kind: "unverified" },
          database: which === "database" ? { kind: "newer" } : { kind: "unverified" },
          vault: which === "vault" ? { kind: "newer" } : { kind: "unverified" },
          integrity: { kind: "unverified" },
        }),
      );
      expect(report.status).toBe("unsupported");
      expect(preflightExitCode(report.status)).toBe(78);
      expect(check(report, "db.integrity").severity).not.toBe("ok");
    },
  );

  it("keeps unsupported when a newer configuration and a corrupt database are both observed", () => {
    const report = assessPreflight(currentFacts({ config: { kind: "newer" }, database: { kind: "corrupt" } }));
    expect(report.status).toBe("unsupported");
    expect(preflightExitCode(report.status)).toBe(78);
    expect(check(report, "config.schema").message).toBe("The configuration schema is newer than this build supports.");
    expect(check(report, "db.schema").message).toBe("The database observation is corrupt.");
  });

  it("reports each readable unsupported format as unsupported without calling it newer", () => {
    const origins = [
      {
        facts: { config: { kind: "unsupported-format" as const } },
        id: "config.schema" as const,
        message: "The configuration format is readable and is not supported by this build.",
      },
      {
        facts: { database: { kind: "unsupported-format" as const } },
        id: "db.schema" as const,
        message: "The database format is readable and is not supported by this build.",
      },
      {
        facts: { vault: { kind: "unsupported-format" as const } },
        id: "vault.marker" as const,
        message: "The Vault format is readable and is not supported by this build.",
      },
    ];
    for (const origin of origins) {
      const report = assessPreflight(currentFacts(origin.facts));
      expect(report.contractVersion).toBe(1);
      expect(parsePreflightReport(report).ok).toBe(true);
      expect(report.status).toBe("unsupported");
      expect(preflightExitCode(report.status)).toBe(78);
      const item = check(report, origin.id);
      expect(item.severity).toBe("blocking");
      expect(item.message).toBe(origin.message);
      expect(item.message).not.toContain("newer");
      expect(item.recovery?.message).toContain("explicitly authorized recovery path");
      expect(item.recovery?.suggestedCommand).toBeUndefined();
    }
  });

  it("keeps an unsupported format verdict when a mandatory check is unfinished", () => {
    const report = assessPreflight(
      currentFacts({ config: { kind: "unsupported-format" }, integrity: { kind: "unverified" } }),
    );
    expect(report.status).toBe("unsupported");
    expect(preflightExitCode(report.status)).toBe(78);
    expect(check(report, "config.schema").message).toBe(
      "The configuration format is readable and is not supported by this build.",
    );
    expect(check(report, "db.integrity").message).toContain("could not be verified");
  });

  it("keeps unsupported when an unsupported format and a corrupt database are both observed", () => {
    const report = assessPreflight(
      currentFacts({ config: { kind: "unsupported-format" }, database: { kind: "corrupt" } }),
    );
    expect(report.status).toBe("unsupported");
    expect(preflightExitCode(report.status)).toBe(78);
    expect(check(report, "config.schema").message).toBe(
      "The configuration format is readable and is not supported by this build.",
    );
    expect(check(report, "db.schema").message).toBe("The database observation is corrupt.");
  });

  it("does not treat a maximum schema marker or one optional record as compatible or upgrade_required", () => {
    for (const database of [{ kind: "maximum-version-only" } as const, { kind: "memo-table-only" } as const]) {
      const report = assessPreflight(currentFacts({ database }));
      expect(report.status).toBe("unverifiable");
      expect(preflightExitCode(report.status)).toBe(75);
      expect(check(report, "db.schema").message).toContain("neither compatibility nor a required upgrade");
      expect(check(report, "db.schema").severity).toBe("blocking");
    }
  });

  it("requires an upgrade only for a valid known ordered history", () => {
    const report = assessPreflight(currentFacts({ database: { kind: "known-older-ordered", preMemo: false } }));
    expect(report.status).toBe("upgrade_required");
    expect(preflightExitCode(report.status)).toBe(78);
    expect(check(report, "db.schema").message).toContain("needs migration");
    const preparation = check(report, "upgrade.preparation");
    expect(preparation.message).toContain("Pre-Memo backup verification");
    expect(preparation.message).toContain("does not approve an upgrade");
    expect(preparation.recovery?.suggestedCommand).toBeUndefined();
  });

  it("separates pre-Memo preparation from migration and does not certify a drill", () => {
    const report = assessPreflight(currentFacts({ database: { kind: "known-older-ordered", preMemo: true } }));
    expect(report.status).toBe("upgrade_required");
    const preparation = check(report, "upgrade.preparation");
    expect(preparation.message).toContain("separately from preparation");
    expect(preparation.message).toContain("does not confirm that an external drill already happened");
    expect(preparation.message).not.toContain("drill already happened.");
    expect(preparation.recovery).toBeUndefined();
  });

  it("does not upgrade when a known older history still has an unresolved mandatory check", () => {
    const report = assessPreflight(
      currentFacts({ database: { kind: "known-older-ordered", preMemo: true }, integrity: { kind: "unverified" } }),
    );
    expect(report.status).toBe("unverifiable");
    expect(check(report, "upgrade.preparation").message).toContain("does not apply");
  });

  it("prefers recovery when integrity failed on otherwise older storage", () => {
    const report = assessPreflight(
      currentFacts({ database: { kind: "known-older-ordered", preMemo: false }, integrity: { kind: "failed" } }),
    );
    expect(report.status).toBe("recovery_required");
    expect(check(report, "db.integrity").severity).toBe("blocking");
  });

  it("accepts a coherent current installation as compatible", () => {
    const report = assessPreflight(currentFacts());
    expectCatalog(report);
    expect(report.status).toBe("compatible");
    expect(preflightExitCode(report.status)).toBe(0);
    expect(check(report, "upgrade.preparation").message).toContain("does not confirm an external drill");
  });

  it("keeps a stale fence as a warning without describing removal or repair", () => {
    const report = assessPreflight(currentFacts({ snapshot: { kind: "coherent", staleFence: true } }));
    expect(report.status).toBe("compatible");
    const snapshot = check(report, "source.snapshot");
    expect(snapshot.severity).toBe("warning");
    expect(snapshot.message).toContain("left untouched");
    expect(snapshot.message).not.toContain("removed");
    expect(snapshot.message).not.toContain("repaired");
  });

  it("does not invent an absent optional identity row or treat it as incomplete", () => {
    const report = assessPreflight(currentFacts({ identity: { kind: "consistent", row: "absent-optional" } }));
    expect(report.status).toBe("compatible");
    expect(check(report, "installation.identity").message).toContain("was not invented");
    expect(check(report, "installation.identity").severity).toBe("ok");
  });

  it.each([
    currentFacts({ identity: { kind: "inconsistent" } }),
    currentFacts({ database: { kind: "corrupt" } }),
    currentFacts({ database: { kind: "invalid-structure" } }),
    currentFacts({ config: { kind: "invalid" } }),
    currentFacts({ vault: { kind: "malformed" } }),
    currentFacts({ config: { kind: "absent" } }),
  ])("reports conclusive incomplete or damaged storage as recovery_required", (facts) => {
    const report = assessPreflight(facts);
    expect(report.status).toBe("recovery_required");
    expect(preflightExitCode(report.status)).toBe(78);
  });

  it("yields unverifiable when a mandatory snapshot cannot be proved and no conclusive verdict stands", () => {
    const report = assessPreflight(currentFacts({ snapshot: { kind: "unavailable" } }));
    expect(report.status).toBe("unverifiable");
    expect(check(report, "source.snapshot").severity).toBe("blocking");
    expect(check(report, "source.snapshot").message).toContain("not available");
  });

  it("maps every status to its exit and keeps ok true for blocking exits", () => {
    const samples: Array<[PreflightFacts, PreflightStatus, 0 | 75 | 78]> = [
      [currentFacts({ home: { kind: "absent" } }), "fresh", 0],
      [currentFacts(), "compatible", 0],
      [currentFacts({ database: { kind: "known-older-ordered", preMemo: false } }), "upgrade_required", 78],
      [currentFacts({ home: { kind: "partial" } }), "recovery_required", 78],
      [currentFacts({ config: { kind: "newer" } }), "unsupported", 78],
      [currentFacts({ home: { kind: "unreadable" } }), "unverifiable", 75],
    ];
    for (const [facts, status, exit] of samples) {
      const report = assessPreflight(facts);
      expect(report.status).toBe(status);
      expect(preflightExitCode(report.status)).toBe(exit);
      const envelope = preflightEnvelope(report, "2f0ac9a0-0000-4000-8000-000000000097");
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toBe(report);
    }
  });

  it("rejects an invalid report DTO", () => {
    const valid = assessPreflight(currentFacts({ home: { kind: "residue", entries: permittedResidue } }));
    expect(parsePreflightReport(valid).ok).toBe(true);
    expect(issue({ ...valid, contractVersion: 2 })).toBe("contract-version");
    expect(issue({ ...valid, status: "healthy" })).toBe("status");
    expect(issue({ ...valid, checks: [...valid.checks].reverse() })).toBe("catalog");
    expect(issue({ ...valid, checks: valid.checks.slice(1) })).toBe("catalog");
    const [first, ...rest] = valid.checks;
    expect(issue({ ...valid, checks: [{ ...first, severity: "error" }, ...rest] })).toBe("severity");
    expect(issue({ ...valid, checks: [{ ...first, severity: "ok", message: " " }, ...rest] })).toBe("unexplained-ok");
  });
});
