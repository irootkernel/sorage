import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, sorage } from "./helpers";

/**
 * The TASK-058 Web backup surface (WEB-002, BKP-018, BKP-019) in a real
 * browser: the dashboard carries the Backup Health card populated from
 * backup_runs, and the backup page states whether protection is local-only or
 * includes a remote while separating the snapshot, commit, and push outcomes
 * of its recent runs.
 */
const home = makeTempDir("sorage-backupweb-home-");
let port = 0;
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
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  expect(
    sorage(["init", "--vault", `${home}/vault`, "--initialize-git", "--non-interactive", "--json"], { home }).status,
  ).toBe(0);
  expect(sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home }).status).toBe(0);
  writeFileSync(join(work, "brief.md"), "# The backup web brief\n");
  expect(sorage(["project", "add", "--name", "App", "--dir", work, "--json"], { home, cwd: work }).status).toBe(0);
  expect(
    sorage(
      [
        "send",
        "--as-user",
        "--allow-external-source",
        "--to",
        "app",
        "--title",
        "The backup web brief",
        "--file",
        join(work, "brief.md"),
        "--json",
      ],
      {
        home,
        cwd: work,
      },
    ).status,
  ).toBe(0);
  expect(sorage(["backup", "run", "--json"], { home }).status).toBe(0);
  expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);
  cleanup.push(() => sorage(["daemon", "stop", "--json"], { home }));
});

afterAll(() => {
  for (const close of cleanup.reverse()) close();
});

describe("the Web backup page and the Backup Health card", () => {
  it("shows the protection statement, the separated outcomes, and the health card", async () => {
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    const page = await browser.newPage();

    const web = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
    const url = (JSON.parse(web.stdout) as { data: { url: string } }).data.url;
    await page.goto(url);
    await page.waitForSelector(".counts");

    // WEB-002: the dashboard Backup Health card is populated from backup_runs.
    await page.waitForFunction(() => document.querySelector(".backup-health")?.textContent?.includes("Backup:"));
    const health = await page.textContent(".backup-health");
    expect(health).toContain("Backup:");
    expect(health).toContain("local");

    // BKP-018: the backup page states the protection plainly.
    await page.goto(`http://127.0.0.1:${port}/#/backup`);
    await page.waitForSelector("table tbody tr");
    expect(await page.locator("table tbody tr").count()).toBe(1);
    const body = (await page.textContent("main")) ?? "";
    expect(body).toContain("Protection is local-only.");
    expect(body).toContain("Recent runs");
    expect(body).toContain("Snapshot");
    expect(body).toContain("Commit");
    expect(body).toContain("Push");
    expect(body).toContain("manual");
    expect(body).toContain("success");
    // BKP-021: restore is named as the CLI bootstrap it is, never a button.
    expect(body).toContain("sorage backup restore --from");
    // BKP-019: the Git-history deletion warning with no purge offer.
    expect(body).toContain("prior Git commits may retain earlier content");
    expect(body.toLowerCase()).not.toContain("purge history");

    // TASK-173: trigger a real backup push failure so lastFailure warning and multiple rows render at 390px and 1280px.
    expect(
      sorage(["backup", "enable-push", "--remote", "missing-remote", "--branch", "main", "--as-user", "--json"], {
        home,
      }).status,
    ).toBe(0);
    const failedRun = sorage(["backup", "run", "--json"], { home });
    expect(failedRun.status).toBe(75);

    const axeSource = readFileSync(
      fileURLToPath(new URL("../../node_modules/axe-core/axe.min.js", import.meta.url)),
      "utf8",
    );

    for (const vp of [
      { name: "mobile", width: 390, height: 844 },
      { name: "desktop", width: 1280, height: 900 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const route of ["#/dashboard", "#/backup"] as const) {
        await page.goto(`http://127.0.0.1:${port}/${route}`);
        await page.waitForSelector(".table-wrap table tbody tr");
        if (route === "#/dashboard") {
          await page.waitForFunction(() => document.querySelector(".backup-health")?.textContent?.includes("Backup:"));
        } else {
          await page.waitForSelector("p.warning");
          expect(await page.locator(".backup-runs-table tbody tr").count()).toBeGreaterThanOrEqual(2);
          expect((await page.textContent("p.warning")) ?? "").toContain("The last backup run failed with");
          await page.evaluate(axeSource);
          const axeReport = (await page.evaluate(() =>
            (
              window as unknown as {
                axe: { run: () => Promise<{ violations: Array<{ id: string; impact: string }> }> };
              }
            ).axe.run(),
          )) as { violations: Array<{ id: string; impact: string }> };
          expect(axeReport.violations, `${vp.name} #/backup failure-warning axe violations`).toEqual([]);
        }
        const fit = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(fit.scrollWidth, `${vp.name} ${route} overflow`).toBeLessThanOrEqual(fit.innerWidth);
        const region = page.locator('.table-wrap[role="region"][tabindex="0"]');
        expect(await region.count()).toBe(1);
        await region.focus();
        expect(await page.evaluate(() => document.activeElement?.className)).toContain("table-wrap");
        if (vp.name === "mobile" && route === "#/backup") {
          const metricsBefore = await page.evaluate(() => {
            const wrap = document.querySelector(".table-wrap");
            if (!wrap) return null;
            return { scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth, scrollLeft: wrap.scrollLeft };
          });
          expect(metricsBefore).not.toBeNull();
          if (metricsBefore !== null) {
            expect(metricsBefore.scrollWidth).toBeGreaterThan(metricsBefore.clientWidth);
          }
          await page.keyboard.press("ArrowRight");
          await page.waitForFunction(() => {
            const wrap = document.querySelector(".table-wrap");
            return wrap !== null && wrap.scrollLeft > 0;
          });
          for (let step = 0; step < 20; step += 1) {
            const reached = await page.evaluate(() => {
              const wrap = document.querySelector(".table-wrap");
              const lastTh = document.querySelector(".table-wrap thead th:last-child");
              if (!wrap || !lastTh) return false;
              return lastTh.getBoundingClientRect().right <= wrap.getBoundingClientRect().right + 1;
            });
            if (reached) break;
            await page.keyboard.press("ArrowRight");
            await page.waitForTimeout(30);
          }
          const metricsAfter = await page.evaluate(() => {
            const wrap = document.querySelector(".table-wrap");
            const lastTh = document.querySelector(".table-wrap thead th:last-child");
            if (!wrap || !lastTh) return null;
            const wrapRect = wrap.getBoundingClientRect();
            const thRect = lastTh.getBoundingClientRect();
            return {
              scrollLeft: wrap.scrollLeft,
              thRight: thRect.right,
              wrapRight: wrapRect.right,
            };
          });
          expect(metricsAfter).not.toBeNull();
          if (metricsAfter !== null) {
            expect(metricsAfter.scrollLeft).toBeGreaterThan(0);
            expect(metricsAfter.thRight).toBeLessThanOrEqual(metricsAfter.wrapRight + 1);
          }
        }
      }
    }
  }, 60000);
});
