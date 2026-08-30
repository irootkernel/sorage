import { mkdirSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { join } from "node:path";
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
    sorage(["send", "--to", "app", "--title", "The backup web brief", "--file", join(work, "brief.md"), "--json"], {
      home,
      cwd: work,
    }).status,
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
    const url = (JSON.parse(web.stdout) as { url: string }).url;
    await page.goto(url);
    await page.waitForSelector(".counts");

    // WEB-002: the dashboard Backup Health card is populated from backup_runs.
    await page.waitForSelector(".backup-health");
    const health = await page.textContent(".backup-health");
    expect(health).toContain("Backup:");
    expect(health).toContain("local");

    // BKP-018: the backup page states the protection plainly.
    await page.goto(`http://127.0.0.1:${port}/#/backup`);
    await page.waitForSelector("table tbody tr");
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
  }, 30000);
});
