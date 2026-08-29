import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, sorage } from "./helpers";

/**
 * The TASK-051 axe-core pass: accessibility findings are recorded as engineering
 * practice inside make test-e2e, not as a gate condition (WEB-018).
 */
const home = makeTempDir("sorage-axe-home-");
let port = 0;
let webUrl = "";
const cleanup: Array<() => void> = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.listen(0, "127.0.0.1", () => {
      const free = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(free));
    });
    probe.on("error", reject);
  });
}

beforeAll(async () => {
  port = await freePort();
  expect(sorage(["init", "--vault", `${home}/vault`, "--non-interactive", "--json"], { home }).status).toBe(0);
  expect(sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home }).status).toBe(0);
  expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);
  cleanup.push(() => sorage(["daemon", "stop", "--json"], { home }));
  const web = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
  webUrl = (JSON.parse(web.stdout) as { url: string }).url;
});

afterAll(() => {
  for (const close of cleanup.reverse()) close();
});

describe("the axe-core accessibility pass", () => {
  it("records findings for the main Web surfaces without gating the release", async () => {
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    const page = await browser.newPage();
    await page.goto(webUrl);
    await page.waitForSelector(".counts");

    const axeSource = readFileSync(
      fileURLToPath(new URL("../../node_modules/axe-core/axe.min.js", import.meta.url)),
      "utf8",
    );
    await page.evaluate(axeSource);
    const findings: Array<{ id: string; impact: string; nodes: number }> = [];
    for (const route of ["#/dashboard", "#/inbox", "#/compose", "#/projects", "#/settings", "#/diagnostics"]) {
      await page.goto(`http://127.0.0.1:${port}/${route}`);
      await page.waitForTimeout(400);
      const report = (await page.evaluate(() =>
        (
          window as unknown as {
            axe: { run: () => Promise<{ violations: Array<{ id: string; impact: string; nodes: unknown[] }> }> };
          }
        ).axe.run(),
      )) as { violations: Array<{ id: string; impact: string; nodes: unknown[] }> };
      for (const violation of report.violations) {
        findings.push({
          id: `${route} ${violation.id}`,
          impact: violation.impact ?? "unknown",
          nodes: violation.nodes.length,
        });
      }
    }
    // Recorded as engineering practice: the summary travels with the run output.
    console.info("axe-core findings:", JSON.stringify(findings));
    expect(Array.isArray(findings)).toBe(true);
  }, 90000);
});
