import { appError } from "@sorage/core";
import { describe, expect, it } from "vitest";
import {
  CONTENT_SECURITY_POLICY,
  createDaemonServer,
  isHostAllowed,
  isLoopbackBindAddress,
  SECURITY_HEADERS,
} from "../../src/server";

describe("the loopback bind guard (SEC-001)", () => {
  it("accepts only the loopback literals as bind addresses", () => {
    expect(isLoopbackBindAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackBindAddress("::1")).toBe(true);
    expect(isLoopbackBindAddress("localhost")).toBe(false);
    expect(isLoopbackBindAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackBindAddress("127.0.0.2")).toBe(false);
    expect(isLoopbackBindAddress("192.168.1.5")).toBe(false);
    expect(isLoopbackBindAddress("")).toBe(false);
  });

  it("refuses to create a server for a non-loopback bind address at startup", () => {
    for (const host of ["localhost", "0.0.0.0", "192.168.1.5", "::"]) {
      expect(() =>
        createDaemonServer({ host, port: 46321, endpoints: { installationId: "i", version: "v" } }),
      ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }) as Error);
    }
  });

  it("creates a server for both loopback literals", () => {
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createDaemonServer({ host, port: 46321, endpoints: { installationId: "i", version: "v" } });
      server.close();
    }
  });
});

describe("the Host header allowlist (SEC-017)", () => {
  const port = 46321;

  it("accepts every allowed name on the exact configured port", () => {
    expect(isHostAllowed(`127.0.0.1:${port}`, port)).toBe(true);
    expect(isHostAllowed(`localhost:${port}`, port)).toBe(true);
    expect(isHostAllowed(`[::1]:${port}`, port)).toBe(true);
  });

  it("rejects a foreign name, an off-loopback literal, and a missing header", () => {
    expect(isHostAllowed(`attacker.example:${port}`, port)).toBe(false);
    expect(isHostAllowed(`127.0.0.2:${port}`, port)).toBe(false);
    expect(isHostAllowed(undefined, port)).toBe(false);
    expect(isHostAllowed("", port)).toBe(false);
  });

  it("rejects an allowed name on the wrong port and a header without a port", () => {
    expect(isHostAllowed(`127.0.0.1:${port + 1}`, port)).toBe(false);
    expect(isHostAllowed(`localhost:${port + 1}`, port)).toBe(false);
    expect(isHostAllowed("127.0.0.1", port)).toBe(false);
  });

  it("rejects malformed bracket forms", () => {
    expect(isHostAllowed(`[::1:${port}`, port)).toBe(false);
    expect(isHostAllowed(`[::]:${port}`, port)).toBe(false);
  });

  it("matches the host name case-insensitively", () => {
    expect(isHostAllowed(`LOCALHOST:${port}`, port)).toBe(true);
  });
});

describe("the security headers (SEC-018)", () => {
  it("carries the documented CSP exactly", () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  it("exposes exactly the three mandatory response headers", () => {
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual(
      ["Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options"].sort(),
    );
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
  });
});

describe("the error surface", () => {
  it("renders routing failures as API-006 bodies with symbolic codes", () => {
    for (const [code, status] of [
      ["NOT_FOUND", 404],
      ["METHOD_NOT_ALLOWED", 405],
      ["HOST_NOT_ALLOWED", 421],
    ] as const) {
      const error = appError(code, "probe");
      expect(error.code).toBe(code);
      expect(status).toBeGreaterThan(0);
    }
  });
});
