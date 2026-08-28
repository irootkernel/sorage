import { afterAll, describe, expect, it } from "vitest";
import { envelopeOf, runCleanups, sorage } from "./helpers";

/** AJ-02: the pre-initialization guidance and the bootstrap commands that still run. */
afterAll(runCleanups);

describe("AJ-02 pre-initialization guidance", () => {
  it("refuses a domain command with NOT_INITIALIZED and names the next command", () => {
    const run = sorage(["project", "list", "--json"]);
    expect(run.status).toBe(78);
    expect(run.stdout).toBe("");
    const envelope = envelopeOf({ ...run, stdout: run.stderr }) as unknown as {
      error: { code: string; details: { expectedConfigPath: string }; recovery: { suggestedCommand: string } };
    };
    expect(envelope.error.code).toBe("NOT_INITIALIZED");
    expect(envelope.error.details.expectedConfigPath).toContain("config.yaml");
    expect(envelope.error.recovery.suggestedCommand).toBe("sorage init");

    const human = sorage(["project", "list"]);
    expect(human.status).toBe(78);
    expect(human.stderr).toContain("NOT_INITIALIZED");
    expect(human.stderr).toContain("sorage init");
  });

  it("runs the bootstrap commands before initialization", () => {
    for (const args of [["version", "--json"], ["help"], ["doctor", "--json"]]) {
      const run = sorage(args);
      expect(run.status, args.join(" ")).toBe(args[0] === "doctor" ? 1 : 0);
      expect(run.stderr).not.toContain("NOT_INITIALIZED");
    }
    const doctor = sorage(["doctor", "--json"]);
    expect(doctor.status).toBe(1);
    const report = envelopeOf(doctor) as {
      data: {
        checks: Array<{ id: string; severity: string; message: string; recovery?: { suggestedCommand: string } }>;
      };
    };
    const dependent = report.data.checks.filter((check) => check.id !== "config.schema");
    for (const check of dependent) {
      expect(check.severity, check.id).toBe("blocking");
      expect(check.recovery?.suggestedCommand, check.id).toBe("sorage init");
    }
    const schema = report.data.checks.find((check) => check.id === "config.schema");
    expect(schema?.message).toContain("config.yaml");
  });
});
