import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { chromium, expect as browserExpect } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, runCleanups, sorage } from "./helpers";

/**
 * TASK-150 Playwright Web E2E & axe-a11y verification covering confirmed Web UI
 * defects #5 and #6 against the compiled `dist/sorage` binary, a real daemon,
 * and real Chromium on desktop and mobile viewports.
 */
const home = makeTempDir("sorage-web-defects-home-");
let port = 0;
let origin = "";
let projectId = "";
let markdownHandoffId = "";
let deletedHandoffTitle = "";
let oldDeletionHandoffTitle = "";
let unregisteredWorkspaceKey = "";
let totalAwaiting = 0;
let totalDeleted = 0;
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

function cli(args: string[], cwd?: string) {
  const result = sorage([...args, "--json"], { home, cwd });
  expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout).data;
}

function seedBulkHandoffs(recipientProjectId: string, count: number): void {
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");
    db.exec("PRAGMA defer_foreign_keys = ON");
    const insertRecord = db.prepare(
      "INSERT INTO content_records (id, inline_text, storage_key, size_bytes, sha256, materialized, created_at) VALUES (?, CAST(? AS TEXT), NULL, ?, ?, 1, ?)",
    );
    const insertHandoff = db.prepare(
      "INSERT INTO handoffs (id, dispatch_group_id, supersedes_handoff_id, title, sender_kind, sender_project_id, sender_workspace_key, sender_path_snapshot, recipient_project_id, current_artifact_id, revision, row_version, review_state, consecutive_no_change_resolutions, pinned, read_status, processing_status, created_at, updated_at) VALUES (?, NULL, NULL, ?, 'user', NULL, NULL, NULL, ?, ?, 1, 1, 'awaiting_recipient', 0, 0, 'unconfirmed', 'not_started', ?, ?)",
    );
    const insertArtifact = db.prepare(
      "INSERT INTO artifacts (id, handoff_id, original_name, stored_name, mime_type, imported_from_path, created_at, content_record_id) VALUES (?, ?, ?, ?, 'text/markdown', NULL, ?, ?)",
    );
    const baseMs = Date.parse("2026-06-01T00:00:00.000Z");
    for (let i = 0; i < count; i++) {
      const hid = randomUUID();
      const aid = randomUUID();
      const cid = randomUUID();
      const body = `# Seeded ${i + 1}\n`;
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      const ts = new Date(baseMs + i * 1000).toISOString();
      insertRecord.run(cid, body, Buffer.byteLength(body, "utf8"), digest, ts);
      insertHandoff.run(hid, `Seeded Handoff ${i + 1}`, recipientProjectId, aid, ts, ts);
      insertArtifact.run(aid, hid, `seed-${i + 1}.md`, `seed-${i + 1}.md`, ts, cid);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const work = join(home, "alpha");
  const outside = join(home, "outside-workspace");
  mkdirSync(work, { recursive: true });
  mkdirSync(outside, { recursive: true });

  cli(["init", "--vault", join(home, "vault"), "--initialize-git", "--non-interactive"]);
  cli(["config", "set", "server.port", String(port), "--as-user"]);
  const added = cli(["project", "add", "--name", "Alpha", "--dir", work]);
  projectId = added.project.id as string;

  // 1. Handoff with angle brackets, ampersands, and hostile markup for #5.
  const mdBody = [
    "# Title <T> & Co",
    "- bullet a < b & c > d",
    "Plain a < b & c > d and <script>window.__task150Xss=true</script>",
    '<img src="https://attacker.invalid/x.png" onerror="window.__task150Xss=true">',
  ].join("\n");
  markdownHandoffId = cli(["send", "--as-user", "--to", "alpha", "--title", "Markdown Special Chars", "--body", mdBody])
    .handoffs[0].handoffId as string;

  // 2. Deleted Handoff for #6a parameter-injection check (`sender=alpha&includeDeleted=true`).
  deletedHandoffTitle = "Deleted Secret Handoff";
  const deletedId = cli([
    "send",
    "--as-user",
    "--to",
    "alpha",
    "--title",
    deletedHandoffTitle,
    "--body",
    "Tombstone body",
  ]).handoffs[0].handoffId as string;
  cli(["accept", deletedId, "--as-user", "--expected-revision", "1", "--expected-row-version", "1"]);
  cli(["delete", "request", deletedId, "--as-user"]);
  cli(["delete", "approve", deletedId, "--as-user", "--confirm", "--expected-row-version", "3"]);
  totalDeleted = 1;

  // 3. Pending deletion request pushed past row #200 for #6c.
  oldDeletionHandoffTitle = "Old Pending Deletion Beyond 200";
  const oldDeletionId = cli([
    "send",
    "--as-user",
    "--to",
    "alpha",
    "--title",
    oldDeletionHandoffTitle,
    "--body",
    "Old pending deletion",
  ]).handoffs[0].handoffId as string;
  cli(["delete", "request", oldDeletionId, "--as-user"]);

  // 4. Unregistered workspace send pushed past row #50 and #200 for #6c.
  const looseDoc = join(outside, "loose.md");
  writeFileSync(looseDoc, "# Loose doc\n");
  const unregId = cli(
    ["send", "--to", "alpha", "--title", "Old Unregistered Beyond 200", "--file", looseDoc, "--allow-unregistered"],
    outside,
  ).handoffs[0].handoffId as string;
  unregisteredWorkspaceKey = cli(["get", unregId, "--as-user"]).senderWorkspaceKey as string;

  // Push the two older real Handoffs below the 202 seeded rows so they live on page 2 (>200).
  const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
  try {
    db.prepare("UPDATE handoffs SET updated_at = '2025-01-01T00:00:01.000Z' WHERE id = ?").run(oldDeletionId);
    db.prepare("UPDATE handoffs SET updated_at = '2025-01-01T00:00:02.000Z' WHERE id = ?").run(unregId);
  } finally {
    db.close();
  }

  // Seed 202 additional awaiting_recipient Handoffs -> 205 awaiting + 1 deleted = 206 total (>200).
  seedBulkHandoffs(projectId, 202);
  totalAwaiting = 205;

  // Run one backup so lastAttempt/lastSuccess/lastCommit share one run.id (#6b).
  cli(["backup", "run"]);

  // Add one Memo with +, &, ? in title/body for #6a end-to-end Memo search filter.
  cli(["memo", "add", "--project", "alpha", "--title", "Query a+b&c?d", "--body", "Special filter body"]);

  cli(["daemon", "start"]);
  cleanup.push(() => sorage(["daemon", "stop", "--json"], { home }));
}, 60000);

afterAll(() => {
  for (const close of cleanup.reverse()) close();
  runCleanups();
});

async function openAuthenticatedPage(viewport: { width: number; height: number }) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const web = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
  expect(web.status, web.stderr).toBe(0);
  const url = (JSON.parse(web.stdout) as { url: string }).url;
  await page.goto(url);
  await page.waitForSelector(".counts");
  return { browser, page, pageErrors, consoleErrors };
}

describe("TASK-150 Web UI defect fixes (#5 and #6)", () => {
  it("verifies #5, #6a, #6b, #6c, #6d and axe-a11y in real Chromium on desktop and mobile", async () => {
    const axeSource = readFileSync(
      fileURLToPath(new URL("../../node_modules/axe-core/axe.min.js", import.meta.url)),
      "utf8",
    );
    const { browser, page, pageErrors, consoleErrors } = await openAuthenticatedPage({ width: 1280, height: 900 });
    try {
      // --- #6c: Dashboard census covers >200 Handoffs ---
      const awaitingStat = page.locator('.stat[data-state="awaiting_recipient"] strong');
      await browserExpect(awaitingStat).toHaveText(String(totalAwaiting));
      const deletedStat = page.locator(".stat", { hasText: /^1deleted$|^1\s+deleted$/ });
      await browserExpect(deletedStat).toHaveCount(totalDeleted);
      const deletionRequestedStat = page.locator(".stat", { hasText: "deletion requested" }).locator("strong");
      await browserExpect(deletionRequestedStat).toHaveText("1");
      // Recent updates keeps top 10 newest rows.
      await browserExpect(page.locator("table tbody tr")).toHaveCount(10);

      // --- #6c: Deletion Requests page finds pending request beyond row #200 ---
      await page.goto(`${origin}/#/deletion-requests`);
      await browserExpect(page.locator("table tbody tr")).toHaveCount(1);
      await browserExpect(page.locator("table tbody")).toContainText(oldDeletionHandoffTitle);

      // --- #6c: Projects page Unregistered Workspaces covers beyond row #50 and #200 ---
      await page.goto(`${origin}/#/projects`);
      await browserExpect(page.locator("main")).toContainText("1 sent Handoff(s); not a recipient");
      await browserExpect(page.locator("main")).toContainText(unregisteredWorkspaceKey);

      // --- #6b: Backup page deduplicates identical run.id across lastAttempt/lastSuccess/lastCommit ---
      await page.goto(`${origin}/#/backup`);
      await page.waitForSelector("table tbody tr");
      await browserExpect(page.locator("table tbody tr")).toHaveCount(1);

      // --- #5: Handoff Markdown preview renders <, >, & uncorrupted without XSS ---
      await page.goto(`${origin}/#/handoff/${markdownHandoffId}`);
      await page.getByRole("heading", { name: "Preview", exact: true }).waitFor();
      const previewCard = page.locator(".card", { has: page.getByRole("heading", { name: "Preview", exact: true }) });
      const previewText = await previewCard.innerText();
      expect(previewText).toContain("Title <T> & Co");
      expect(previewText).toContain("bullet a < b & c > d");
      expect(previewText).toContain("Plain a < b & c > d and <script>window.__task150Xss=true</script>");
      expect(previewText).not.toContain("&lt;");
      expect(previewText).not.toContain("&gt;");
      expect(previewText).not.toContain("&amp;");
      expect(await page.locator("main script, main img, main iframe").count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, "__task150Xss"))).toBeUndefined();

      // --- #6a: Inbox URL query encoding prevents parameter injection & preserves +, &, ?, % ---
      const capturedUrls: string[] = [];
      const onRequest = (req: { url(): string }) => {
        if (req.url().includes("/api/v1/handoffs")) capturedUrls.push(req.url());
      };
      page.on("request", onRequest);

      await page.goto(`${origin}/#/inbox`);
      await page.waitForSelector("table tbody tr");
      capturedUrls.length = 0;

      const injectedSender = "alpha+beta&includeDeleted=true?x=1%20";
      await page.getByLabel("Sender slug", { exact: true }).fill(injectedSender);
      const listingResponse = page.waitForResponse((res) => res.url().includes("/api/v1/handoffs"));
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await listingResponse;

      const lastCaptured = capturedUrls.at(-1);
      if (!lastCaptured) throw new Error("Expected handoffs listing request");
      const requested = new URL(lastCaptured);
      expect(requested.searchParams.get("sender")).toBe(injectedSender);
      expect(requested.searchParams.get("includeDeleted")).toBeNull();
      // Injected `includeDeleted=true` did NOT leak the deleted Handoff into results.
      await browserExpect(page.locator("main")).not.toContainText(deletedHandoffTitle);
      // Reload preserves the exact literal filter input value.
      await page.reload();
      await browserExpect(page.getByLabel("Sender slug", { exact: true })).toHaveValue(injectedSender);

      // Verify state filter encoding with +, &, ? through direct hash navigation.
      capturedUrls.length = 0;
      const specialState = "a+b&c?d%e";
      const stateResponse = page.waitForResponse((res) => res.url().includes("/api/v1/handoffs"));
      await page.goto(`${origin}/#/inbox?state=${encodeURIComponent(specialState)}`);
      await stateResponse;
      const lastStateUrl = capturedUrls.at(-1);
      if (!lastStateUrl) throw new Error("Expected state-filtered handoffs request");
      const stateReq = new URL(lastStateUrl);
      expect(stateReq.searchParams.get("state")).toBe(specialState);
      await browserExpect(page.getByLabel("State filter", { exact: true })).toHaveValue(specialState);
      page.off("request", onRequest);

      // --- #6a: Memo search filter with +, &, ? works end-to-end ---
      await page.goto(`${origin}/#/memos?projectId=${encodeURIComponent(projectId)}`);
      await browserExpect(page.getByLabel("Search Memos", { exact: true })).toBeVisible();
      await page.getByLabel("Search Memos", { exact: true }).fill("a+b&c?d");
      await page.getByRole("button", { name: "Apply Memo filters", exact: true }).click();
      await browserExpect(page.locator(".memo-row")).toHaveCount(1);
      await browserExpect(page.locator(".memo-row")).toContainText("Query a+b&c?d");

      // --- #5 & #6d: Memo editor debounced preview renders <, >, & uncorrupted, and fast typing + immediate Create flushes synchronously ---
      await page.goto(`${origin}/#/memos?projectId=${encodeURIComponent(projectId)}`);
      const memoTitleInput = page.getByLabel("Memo title", { exact: true });
      const memoBodyInput = page.getByLabel("Memo body", { exact: true });
      await browserExpect(memoTitleInput).toBeVisible();

      const memoPreviewBody = "# Memo <H> & Preview\n- check x < y & z > w";
      await memoTitleInput.fill("Debounced Preview Check");
      await memoBodyInput.fill(memoPreviewBody);
      // Wait for debounced preview to settle and verify literal angle brackets/ampersands.
      const memoPreview = page.getByLabel("Memo preview", { exact: true });
      await browserExpect(memoPreview).toContainText("Memo <H> & Preview");
      await browserExpect(memoPreview).toContainText("check x < y & z > w");
      expect(await memoPreview.innerText()).not.toContain("&lt;");
      expect(await memoPreview.innerText()).not.toContain("&amp;");

      // Rapid typing burst immediately followed by Create (before 150ms debounce) submits exact latest body.
      const fastBody = "Burst <1> & <2> immediate save";
      await memoBodyInput.focus();
      await memoBodyInput.fill("");
      await page.keyboard.type(fastBody, { delay: 1 });
      await page.getByRole("button", { name: "Create Memo", exact: true }).click();
      await page.waitForURL(/#\/memo\//);
      const createdMemoId = new URL(page.url()).hash.split("/").at(-1) as string;
      const storedMemo = cli(["memo", "show", createdMemoId]);
      expect(storedMemo.body).toBe(fastBody);
      const fullMemoBody = page.getByLabel("Full Memo body", { exact: true });
      await browserExpect(fullMemoBody).toContainText(fastBody);
      expect(await fullMemoBody.innerText()).not.toContain("&lt;");
      expect(await fullMemoBody.innerText()).not.toContain("&amp;");

      // --- Axe-core accessibility check across affected routes on desktop & mobile ---
      const routes = [
        "#/dashboard",
        "#/inbox",
        "#/deletion-requests",
        "#/projects",
        "#/backup",
        `#/handoff/${markdownHandoffId}`,
        `#/memos?projectId=${encodeURIComponent(projectId)}`,
      ];
      const allViolations: Array<{ viewport: string; route: string; id: string; impact: string }> = [];
      for (const vp of [
        { name: "desktop", width: 1280, height: 900 },
        { name: "mobile", width: 390, height: 844 },
      ]) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        for (const route of routes) {
          await page.goto(`${origin}/${route}`);
          await page.waitForLoadState("networkidle");
          await page.evaluate(axeSource);
          const report = (await page.evaluate(() =>
            (
              window as unknown as {
                axe: { run: () => Promise<{ violations: Array<{ id: string; impact?: string }> }> };
              }
            ).axe.run(),
          )) as { violations: Array<{ id: string; impact?: string }> };
          for (const v of report.violations) {
            allViolations.push({ viewport: vp.name, route, id: v.id, impact: v.impact ?? "unknown" });
          }
        }
      }
      expect(allViolations).toEqual([]);
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120000);
});
