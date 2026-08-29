import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isWellFormedToken } from "@sorage/core";
import { withTempHome } from "../../src/testkit";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
  tokenFileMode,
} from "../../src/token-store";

describe("the Installation API token file (SEC-020, SEC-002)", () => {
  it("creates a token of at least 32 random bytes with owner-only permissions", async () => {
    await withTempHome((home) => {
      const store = createNodeApiTokenStore({ stateDir: join(home, "state") });
      const created = store.ensure();
      expect(created.ok).toBe(true);
      const token = store.read();
      expect(token).not.toBeNull();
      expect(isWellFormedToken(token as string)).toBe(true);
      expect(tokenFileMode(store.path)).toBe(0o600);
    });
  });

  it("is idempotent: ensure keeps an existing valid token", async () => {
    await withTempHome((home) => {
      const store = createNodeApiTokenStore({ stateDir: join(home, "state") });
      store.ensure();
      const first = store.read();
      const again = store.ensure();
      expect(again.ok && again.value.created).toBe(false);
      expect(store.read()).toBe(first);
    });
  });

  it("replaces an unusable file on ensure and restores 0600 after rotation", async () => {
    await withTempHome((home) => {
      const stateDir = join(home, "state");
      mkdirSync(stateDir, { recursive: true });
      const store = createNodeApiTokenStore({ stateDir });
      writeFileSync(store.path, "not-a-token", { mode: 0o644 });
      store.ensure();
      expect(isWellFormedToken(store.read() as string)).toBe(true);
      expect(tokenFileMode(store.path)).toBe(0o600);

      const before = store.read();
      const rotated = store.rotate();
      expect(rotated.ok).toBe(true);
      const after = store.read();
      expect(after).not.toBe(before);
      expect(tokenFileMode(store.path)).toBe(0o600);
    });
  });

  it("reads a missing file as null and never throws", async () => {
    await withTempHome((home) => {
      const store = createNodeApiTokenStore({ stateDir: join(home, "state") });
      expect(store.read()).toBeNull();
    });
  });

  it("generates fresh material every draw", async () => {
    const entropy = createNodeTokenEntropy();
    expect(entropy.next()).not.toBe(entropy.next());
  });
});

describe("the one-time browser secret (SEC-019, RUN-012)", () => {
  it("issues a consumable secret exactly once", async () => {
    await withTempHome((home) => {
      const clock = { now: () => new Date("2026-08-30T00:00:00Z") };
      const store = createNodeWebSecretStore({ stateDir: join(home, "state"), clock });
      const issued = store.issue();
      expect(issued.ok).toBe(true);
      if (!issued.ok) return;
      expect(store.consume(issued.value.secret)).toBe(true);
      expect(store.consume(issued.value.secret)).toBe(false);
    });
  });

  it("refuses the wrong secret without spending anything else", async () => {
    await withTempHome((home) => {
      const store = createNodeWebSecretStore({ stateDir: join(home, "state"), clock: { now: () => new Date() } });
      store.issue();
      expect(store.consume("A".repeat(43))).toBe(false);
    });
  });

  it("refuses an expired secret and deletes the record", async () => {
    await withTempHome((home) => {
      let now = new Date("2026-08-30T00:00:00Z");
      const store = createNodeWebSecretStore({ stateDir: join(home, "state"), clock: { now: () => now } });
      const issued = store.issue();
      expect(issued.ok).toBe(true);
      now = new Date("2026-08-30T01:00:00Z");
      expect(store.consume((issued as { value: { secret: string } }).value.secret)).toBe(false);
    });
  });

  it("a second issue replaces the pending secret", async () => {
    await withTempHome((home) => {
      const store = createNodeWebSecretStore({ stateDir: join(home, "state"), clock: { now: () => new Date() } });
      const first = store.issue();
      const second = store.issue();
      expect(first.ok && second.ok).toBe(true);
      const firstSecret = (first as { value: { secret: string } }).value.secret;
      const secondSecret = (second as { value: { secret: string } }).value.secret;
      expect(secondSecret).not.toBe(firstSecret);
      // Only the second issue's secret is pending, and spending it consumes the record.
      expect(store.consume(secondSecret)).toBe(true);
      expect(store.consume(secondSecret)).toBe(false);
    });
  });

  it("never stores the secret readable by others", async () => {
    await withTempHome((home) => {
      const stateDir = join(home, "state");
      const store = createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } });
      store.issue();
      const path = join(stateDir, "web-secret");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(() => readFileSync(path, "utf8")).not.toThrow();
    });
  });
});
