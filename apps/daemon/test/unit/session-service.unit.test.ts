import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createNodeApiTokenStore,
  createNodeTokenEntropy,
  createNodeWebSecretStore,
} from "@sorage/adapters/src/token-store";
import { bearerValue, createSessionService } from "../../src/auth";

/** The session service contract behind the HTTP surface of SEC-019 and SEC-020. */
const stateDir = mkdtempSync(join(tmpdir(), "sorage-session-unit-"));
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

function build() {
  const token = createNodeApiTokenStore({ stateDir });
  token.ensure();
  const webSecret = createNodeWebSecretStore({ stateDir, clock: { now: () => new Date() } });
  const entropy = createNodeTokenEntropy();
  return { token, service: createSessionService({ token, webSecret, entropy }), webSecret };
}

describe("bearer extraction", () => {
  it("extracts the token after the scheme and rejects other forms", () => {
    expect(bearerValue("Bearer abc")).toBe("abc");
    expect(bearerValue("bearer abc")).toBeNull();
    expect(bearerValue("Basic abc")).toBeNull();
    expect(bearerValue(undefined)).toBeNull();
    expect(bearerValue("Bearer ")).toBeNull();
  });
});

describe("the session lifecycle", () => {
  it("authenticates the Installation token, issues sessions, and kills them on rotation", () => {
    const { token, service, webSecret } = build();
    const apiToken = token.read() as string;
    expect(service.authenticate(apiToken)).toMatchObject({ ok: true, context: { kind: "api-token" } });

    const issued = webSecret.issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const exchange = service.exchange(issued.value.secret);
    expect(exchange.ok).toBe(true);
    if (!exchange.ok) return;
    const sessionToken = exchange.token as string;
    expect(service.authenticate(sessionToken)).toMatchObject({ ok: true, context: { kind: "session" } });

    token.rotate();
    expect(service.authenticate(sessionToken).ok).toBe(false);
    const afterRotation = service.authenticate(sessionToken);
    if (afterRotation.ok) throw new Error("expected failure");
    expect(afterRotation.error.code).toBe("TOKEN_INVALID");
    expect(service.authenticate(apiToken).ok).toBe(false);
    expect(service.authenticate(token.read() as string)).toMatchObject({ ok: true });
  });

  it("refuses a wrong secret with UNAUTHENTICATED; any attempt spends the pending record", () => {
    const { service, webSecret } = build();
    const issued = webSecret.issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const refused = service.exchange("A".repeat(43));
    if (refused.ok) throw new Error("expected failure");
    expect(refused.error.code).toBe("UNAUTHENTICATED");
    // The store's read-is-use rule means even a wrong candidate burns the single
    // pending secret, so the holder reruns `sorage web` for a fresh one.
    expect(service.exchange(issued.value.secret).ok).toBe(false);
  });

  it("exchanges the matching secret once and refuses the replay", () => {
    const { service, webSecret } = build();
    const issued = webSecret.issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const first = service.exchange(issued.value.secret);
    expect(first.ok).toBe(true);
    const replay = service.exchange(issued.value.secret);
    if (replay.ok) throw new Error("expected failure");
    expect(replay.error.code).toBe("UNAUTHENTICATED");
  });
});
