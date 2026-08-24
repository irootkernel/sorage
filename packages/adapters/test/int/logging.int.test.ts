import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logging";
import { makeTempHome } from "../../src/testkit/temp-home";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function fixture(rotation: { maxBytes: number; maxFiles: number }, secrets?: string[], includeFullPaths?: boolean) {
  const home = makeTempHome("sorage-test-log-");
  cleanups.push(home.cleanup);
  const logger = createLogger({
    file: join(home.home, "logs", "sorage.log"),
    rotation,
    secrets,
    includeFullPaths,
    homePath: home.home,
  });
  return { home, logger, logFile: join(home.home, "logs", "sorage.log") };
}

describe("structured logging", () => {
  it("writes only warn and above at the default CLI level", () => {
    const { logger, logFile } = fixture({ maxBytes: 1024 * 1024, maxFiles: 5 });
    logger.info("cli.started", { requestId: "r1" });
    logger.warn("config.stale", { requestId: "r1" });
    logger.error("db.failed", { requestId: "r1" });
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    const events = lines.map((line) => (JSON.parse(line) as { event: string; level: string }).event);
    expect(events).toEqual(["config.stale", "db.failed"]);
  });

  it("writes every level when the level is debug", () => {
    const home = makeTempHome("sorage-test-log-");
    cleanups.push(home.cleanup);
    const logFile = join(home.home, "logs", "sorage.log");
    const logger = createLogger({ file: logFile, level: "debug", rotation: { maxBytes: 1024 * 1024, maxFiles: 5 } });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(readFileSync(logFile, "utf8").trim().split("\n")).toHaveLength(4);
  });

  it("rotates at maxBytes and retains maxFiles rotated files", () => {
    const { logger, logFile, home } = fixture({ maxBytes: 200, maxFiles: 2 });
    for (let index = 0; index < 20; index++) {
      logger.warn(`event-${index}`, { payload: "x".repeat(40) });
    }
    const rotated = readdirSync(join(home.home, "logs")).filter((name) => name.startsWith("sorage.log."));
    expect(existsSync(logFile)).toBe(true);
    expect(rotated.sort()).toEqual(["sorage.log.1", "sorage.log.2"]);
  });

  it("writes no substring of a handled token to any log line", () => {
    const token = "s3cr3t-token-material-abcdefghijklmnopqrstuvwxyz-0123456789";
    const { logger, logFile } = fixture({ maxBytes: 1024 * 1024, maxFiles: 5 }, [token]);
    logger.warn("token.handled", { requestId: "r9", token, note: `rotated from ${token}` });
    const content = readFileSync(logFile, "utf8");
    for (let start = 0; start + 8 <= token.length; start++) {
      expect(content).not.toContain(token.slice(start, start + 8));
    }
    expect(content).toContain("token.handled");
    expect(content).toContain("[redacted]");
  });

  it("redacts home paths while keeping stable identifiers", () => {
    const { home, logger, logFile } = fixture({ maxBytes: 1024 * 1024, maxFiles: 5 });
    logger.warn("binding.resolved", { path: join(home.home, "vault", "artifacts", "h-1"), project: "web-app" });
    const line = readFileSync(logFile, "utf8");
    expect(line).not.toContain(home.home);
    expect(line).toContain("<home>");
    expect(line).toContain("web-app");
    expect(line).toContain("artifacts");
  });

  it("writes an oversized first line instead of crashing on the missing log file", () => {
    const home = makeTempHome("sorage-test-log-");
    cleanups.push(home.cleanup);
    const logFile = join(home.home, "logs", "sorage.log");
    const logger = createLogger({ file: logFile, rotation: { maxBytes: 10, maxFiles: 2 } });
    logger.warn("first.huge", { payload: "x".repeat(500) });
    expect(readFileSync(logFile, "utf8")).toContain("first.huge");
  });

  it("accounts for multibyte record content in the rotation threshold", () => {
    const { home, logger } = fixture({ maxBytes: 100, maxFiles: 2 });
    for (let index = 0; index < 8; index++) {
      logger.warn(`multibyte-${index}`, { payload: "경".repeat(30) });
    }
    const logs = readdirSync(join(home.home, "logs")).filter((name) => name.startsWith("sorage.log"));
    expect(logs.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps full paths when includeFullPaths is enabled", () => {
    const { home, logger, logFile } = fixture({ maxBytes: 1024 * 1024, maxFiles: 5 }, undefined, true);
    const fullPath = join(home.home, "vault", "artifacts", "h-1");
    logger.warn("path.kept", { path: fullPath });
    expect(readFileSync(logFile, "utf8")).toContain(fullPath);
  });
});
