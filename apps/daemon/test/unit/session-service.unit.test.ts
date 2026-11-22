import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ApiTokenStorePort } from "@sorage/core";
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

  it("caches API token stat/mtime across repeated requests and prunes sessions on rotation", () => {
    const dir = mkdtempSync(join(tmpdir(), "sorage-session-cache-"));
    try {
      const inner = createNodeApiTokenStore({ stateDir: dir });
      inner.ensure();
      let readCalls = 0;
      const spiedToken: ApiTokenStorePort = {
        path: inner.path,
        read: () => {
          readCalls += 1;
          return inner.read();
        },
        ensure: () => inner.ensure(),
        rotate: () => inner.rotate(),
      };
      const webSecret = createNodeWebSecretStore({ stateDir: dir, clock: { now: () => new Date() } });
      const service = createSessionService({ token: spiedToken, webSecret, entropy: createNodeTokenEntropy() });
      const apiToken = inner.read() as string;

      // Issue three browser sessions.
      const sessionTokens: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const issued = webSecret.issue();
        if (!issued.ok) throw new Error("issue failed");
        const exchanged = service.exchange(issued.value.secret);
        expect(exchanged.ok).toBe(true);
        if (exchanged.ok && exchanged.token) sessionTokens.push(exchanged.token);
      }
      expect(service.activeSessionCount?.()).toBe(3);
      expect(readCalls).toBe(1);

      // Repeated authentications for both API token and sessions hit the stat cache.
      for (let i = 0; i < 10; i += 1) {
        expect(service.authenticate(apiToken).ok).toBe(true);
        expect(service.authenticate(sessionTokens[i % sessionTokens.length] as string).ok).toBe(true);
      }
      expect(readCalls).toBe(1);

      // Back-to-back rotations in the same millisecond invalidate via inode/ctimeNs/mtimeNs and prune sessions.
      inner.rotate();
      const midToken = inner.read() as string;
      expect(service.authenticate(sessionTokens[0] as string)).toMatchObject({
        ok: false,
        error: { code: "TOKEN_INVALID" },
      });
      expect(service.activeSessionCount?.()).toBe(0);
      expect(readCalls).toBe(2);

      // Issue a fresh session under midToken, then rotate immediately again in the same tick.
      const issued2 = webSecret.issue();
      if (!issued2.ok) throw new Error("issue failed");
      const exchanged2 = service.exchange(issued2.value.secret);
      expect(exchanged2.ok).toBe(true);
      expect(service.activeSessionCount?.()).toBe(1);
      inner.rotate();
      const latestToken = inner.read() as string;
      expect(latestToken).not.toBe(midToken);
      expect(service.authenticate(midToken).ok).toBe(false);
      expect(service.authenticate(exchanged2.token as string).ok).toBe(false);
      expect(service.activeSessionCount?.()).toBe(0);
      expect(service.authenticate(latestToken)).toMatchObject({ ok: true, context: { kind: "api-token" } });
      expect(readCalls).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed and prunes sessions when the token file is deleted, emptied, corrupted, or non-regular", () => {
    const dir = mkdtempSync(join(tmpdir(), "sorage-session-failclosed-"));
    try {
      const token = createNodeApiTokenStore({ stateDir: dir });
      token.ensure();
      const webSecret = createNodeWebSecretStore({ stateDir: dir, clock: { now: () => new Date() } });
      const service = createSessionService({ token, webSecret, entropy: createNodeTokenEntropy() });

      const issueSession = () => {
        const issued = webSecret.issue();
        if (!issued.ok) throw new Error("issue failed");
        const exchanged = service.exchange(issued.value.secret);
        if (!exchanged.ok || !exchanged.token) throw new Error("exchange failed");
        return exchanged.token;
      };

      // 1. Truncated/empty file fails closed and prunes sessions.
      const s1 = issueSession();
      expect(service.authenticate(s1).ok).toBe(true);
      writeFileSync(token.path, "   \n");
      expect(service.authenticate(s1)).toMatchObject({ ok: false, error: { code: "TOKEN_INVALID" } });
      expect(service.activeSessionCount?.()).toBe(0);

      // 2. Corrupted/changed file fails closed for prior tokens and prunes sessions.
      token.rotate();
      const oldApi = token.read() as string;
      const s2 = issueSession();
      writeFileSync(token.path, "corrupted-material");
      expect(service.authenticate(oldApi)).toMatchObject({ ok: false, error: { code: "TOKEN_INVALID" } });
      expect(service.authenticate(s2)).toMatchObject({ ok: false, error: { code: "TOKEN_INVALID" } });
      expect(service.activeSessionCount?.()).toBe(0);

      // 3. Deleted file fails closed for authenticate and exchange, pruning sessions.
      token.rotate();
      const s3 = issueSession();
      unlinkSync(token.path);
      expect(service.authenticate(s3)).toMatchObject({ ok: false, error: { code: "TOKEN_INVALID" } });
      expect(service.activeSessionCount?.()).toBe(0);
      const issuedWhileMissing = webSecret.issue();
      if (!issuedWhileMissing.ok) throw new Error("issue failed");
      expect(service.exchange(issuedWhileMissing.value.secret)).toMatchObject({
        ok: false,
        error: { code: "UNAUTHENTICATED" },
      });

      // 4. Non-regular path (directory in place of token file) fails closed.
      mkdirSync(token.path, { recursive: true });
      expect(service.authenticate(s3)).toMatchObject({ ok: false, error: { code: "TOKEN_INVALID" } });
      expect(service.activeSessionCount?.()).toBe(0);
      rmSync(token.path, { recursive: true, force: true });

      // 5. Dangling symlink and symlink-to-directory fail closed.
      symlinkSync(join(dir, "missing-target"), token.path);
      expect(service.authenticate(s3)).toMatchObject({ ok: false, error: { code: "TOKEN_INVALID" } });
      expect(service.activeSessionCount?.()).toBe(0);
      unlinkSync(token.path);

      const targetDir = join(dir, "some-dir");
      mkdirSync(targetDir, { recursive: true });
      symlinkSync(targetDir, token.path);
      expect(service.authenticate(s3)).toMatchObject({ ok: false, error: { code: "TOKEN_INVALID" } });
      expect(service.activeSessionCount?.()).toBe(0);
      unlinkSync(token.path);

      // 6. Unreadable file (chmod 000) fails closed and recovers immediately on chmod 0600 (skip if running as root).
      if (process.getuid?.() !== 0) {
        token.rotate();
        const apiAfterRotate = token.read() as string;
        const s4 = issueSession();
        chmodSync(token.path, 0o000);
        try {
          expect(service.authenticate(s4)).toMatchObject({ ok: false, error: { code: "TOKEN_INVALID" } });
          expect(service.activeSessionCount?.()).toBe(0);
        } finally {
          chmodSync(token.path, 0o600);
        }
        // Recovery after permission restoration must not be latched closed by a negative cache.
        expect(service.authenticate(apiAfterRotate)).toMatchObject({ ok: true, context: { kind: "api-token" } });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not negatively cache transient null reads from the token store", () => {
    const dir = mkdtempSync(join(tmpdir(), "sorage-session-transient-"));
    try {
      const inner = createNodeApiTokenStore({ stateDir: dir });
      inner.ensure();
      const realToken = inner.read() as string;
      let failReadOnce = true;
      const flakyToken: ApiTokenStorePort = {
        path: inner.path,
        read: () => {
          if (failReadOnce) {
            failReadOnce = false;
            return null;
          }
          return inner.read();
        },
        ensure: () => inner.ensure(),
        rotate: () => inner.rotate(),
      };
      const service = createSessionService({
        token: flakyToken,
        webSecret: createNodeWebSecretStore({ stateDir: dir, clock: { now: () => new Date() } }),
        entropy: createNodeTokenEntropy(),
      });
      // First read returns transient null -> fails closed without caching null.
      expect(service.authenticate(realToken)).toMatchObject({ ok: false, error: { code: "TOKEN_INVALID" } });
      // Next read on the same unchanged stat succeeds immediately.
      expect(service.authenticate(realToken)).toMatchObject({ ok: true, context: { kind: "api-token" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
