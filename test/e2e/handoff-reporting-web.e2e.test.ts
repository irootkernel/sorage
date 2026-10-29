import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { chromium, expect as browserExpect, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, sorage } from "./helpers";

const home = makeTempDir("sorage-web-report-home-");
let port = 0;
const origin = () => `http://127.0.0.1:${port}`;
function cli(args: string[]) {
  const run = sorage([...args, "--json"], { home });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout).data;
}
function send(title: string) {
  return cli([
    "send",
    "--as-user",
    "--to",
    "report-recipient",
    "--title",
    title,
    "--body",
    "# Untrusted document\n<script>window.pwned=true</script>",
  ]).handoffs[0].handoffId as string;
}
async function open(page: Page, id: string) {
  await page.goto(`${origin()}/#/handoff/${id}`);
  await page.waitForSelector('[aria-label="Recipient reporting"]');
  await page.waitForLoadState("networkidle");
}
async function click(page: Page, label: string) {
  const previous = await page.locator("dl.meta").first().elementHandle();
  const response = page.waitForResponse(
    (response) => response.request().method() !== "GET" && response.url().includes("/api/v1/handoffs/"),
  );
  await page.getByRole("button", { name: label, exact: true }).click();
  const result = await response;
  expect(result.status(), await result.text()).toBe(200);
  if (previous) await page.waitForFunction((node) => !node.isConnected, previous);
  await page.waitForSelector("dl.meta");
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Latest recipient comment"]')?.textContent?.includes("Loading comment…"),
  );
}
const comment = (page: Page) => page.getByRole("region", { name: "Latest recipient comment", exact: true });
const report = (page: Page) => page.getByRole("region", { name: "Recipient reporting", exact: true });

beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const value = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(value));
    });
    probe.on("error", reject);
  });
  cli(["init", "--vault", join(home, "vault"), "--non-interactive"]);
  cli(["config", "set", "server.port", String(port), "--as-user"]);
  const work = join(home, "recipient");
  mkdirSync(work);
  cli(["project", "add", "--name", "Report Recipient", "--dir", work]);
  cli(["daemon", "start"]);
});
afterAll(() => sorage(["daemon", "stop", "--json"], { home }));

describe("versioned Web recipient reporting (AJ-31/32)", () => {
  it.each([
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ])(
    "reports independently of acceptance and preserves declined attribution on $name",
    async (viewport) => {
      const evidence = process.env.SORAGE_UI_EVIDENCE_DIR ?? makeTempDir("sorage-report-evidence-");
      mkdirSync(evidence, { recursive: true });
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const errors: string[] = [];
      const diagnostics: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (["warning", "error"].includes(message.type())) diagnostics.push(message.text());
      });
      const proof: Record<string, unknown> = {
        viewport,
        browser: "Playwright Chromium",
        browserAvailability: "Browser plugin not available",
        errors,
        diagnostics,
      };
      try {
        const entry = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
        expect(entry.status).toBe(0);
        await page.goto(JSON.parse(entry.stdout).url as string);
        await page.waitForSelector(".counts");
        const id = send(`Report ${viewport.name}`);
        await open(page, id);
        expect(page.url()).toBe(`${origin()}/#/handoff/${id}`);
        expect(await page.title()).toBe("Sorage");
        expect(await page.locator("main").innerText()).toContain("Processing not started — unfinished");
        expect(await page.locator("main").innerText()).toContain("Revision 1: unconfirmed");
        expect(await page.locator("main").innerText()).toContain("explicit User proxy");
        expect(await page.locator("nextjs-portal, vite-error-overlay, webpack-dev-server-client-overlay").count()).toBe(
          0,
        );
        expect(await page.evaluate(() => (window as unknown as { pwned?: boolean }).pwned)).toBeUndefined();
        // Preview is the body acquisition. Metadata displayed above retains the original proposal observation.
        expect(cli(["get", id, "--as-user"]).read.status).toBe("read");
        await page.reload();
        await page.waitForLoadState("networkidle");
        expect(await page.locator("main").innerText()).toContain("Revision 1: read");
        const exact = " General result <img src=x onerror='window.pwned=true'>\nSecond line 가 ";
        await page.getByLabel("Recipient comment", { exact: true }).fill(exact);
        await click(page, "Set comment");
        expect(await comment(page).innerText()).toContain(exact.trim());
        expect(await comment(page).innerText()).toContain("Purpose: general; inactive; target Revision 1");
        expect(await comment(page).locator("img, script").count()).toBe(0);
        await click(page, "Accept");
        expect(cli(["get", id, "--as-user"])).toMatchObject({
          reviewState: "accepted",
          processing: { status: "not_started" },
          nextActors: { reviewNextActor: null },
        });
        await page.goto(`${origin()}/#/outbox`);
        await page.waitForSelector("table tbody tr");
        expect(
          await page
            .getByRole("row")
            .filter({ hasText: `Report ${viewport.name}` })
            .innerText(),
        ).toContain("not started — unfinished");
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(evidence, `report-${viewport.name}-outbox-pending.png`), fullPage: false });
        await open(page, id);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: join(evidence, `report-${viewport.name}-accepted-pending.png`),
          fullPage: false,
        });
        await page.getByLabel("Recipient comment", { exact: true }).fill("Started through explicit User proxy");
        await page.getByLabel("Include comment with processing").check();
        await click(page, "Start processing");
        expect(cli(["get", id, "--as-user"])).toMatchObject({
          reviewState: "accepted",
          processing: { status: "in_progress" },
        });
        expect(await comment(page).innerText()).toContain("Started through explicit User proxy");
        expect(await page.getByRole("button", { name: "Start processing", exact: true }).isDisabled()).toBe(true);
        await page.goto(`${origin()}/#/outbox`);
        await page.waitForSelector("table tbody tr");
        expect(
          await page
            .getByRole("row")
            .filter({ hasText: `Report ${viewport.name}` })
            .innerText(),
        ).toContain("in progress — unfinished");
        await open(page, id);
        await page
          .getByLabel("Recipient comment", { exact: true })
          .fill("Implemented and tested; please inspect the result.");
        await page.getByLabel("Include comment with processing").check();
        await click(page, "Complete processing");
        const completed = cli(["get", id, "--as-user"]);
        const acceptedDb = new DatabaseSync(join(home, "state", "sorage.sqlite3"), { readOnly: true });
        expect(acceptedDb.prepare("SELECT accepted_revision FROM handoffs WHERE id=?").get(id)).toEqual({
          accepted_revision: 1,
        });
        acceptedDb.close();
        expect(completed).toMatchObject({
          reviewState: "accepted",
          processing: { status: "completed" },
        });
        expect(await comment(page).innerText()).toContain("Implemented and tested");
        expect(await page.getByRole("button", { name: "Complete processing", exact: true }).isDisabled()).toBe(true);
        expect(await page.getByLabel("Replacement document").count()).toBe(0);
        await click(page, "Archive");
        await page.getByLabel("Recipient comment", { exact: true }).fill("Archived general update");
        await click(page, "Set comment");
        expect(cli(["get", id, "--as-user"])).toMatchObject({
          processing: { status: "completed" },
        });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(evidence, `report-${viewport.name}-completed.png`), fullPage: true });
        await page.goto(`${origin()}/#/outbox?includeArchived=true`);
        await page.waitForSelector("table tbody tr");
        expect(
          await page
            .getByRole("row")
            .filter({ hasText: `Report ${viewport.name}` })
            .innerText(),
        ).toContain("Processing completed");
        // A faithful unknown-evidence fixture, not an inference from acceptance.
        const legacy = send(`Legacy ${viewport.name}`);
        cli(["accept", legacy, "--as-user", "--expected-revision", "1", "--expected-row-version", "1"]);
        const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
        db.prepare(
          "UPDATE handoffs SET read_status='unrecorded',read_revision=NULL,revision_read_at=NULL,processing_status='unrecorded' WHERE id=?",
        ).run(legacy);
        db.close();
        await page.goto(`${origin()}/#/outbox`);
        await page.waitForSelector("table tbody tr");
        expect(
          await page
            .getByRole("row")
            .filter({ hasText: `Legacy ${viewport.name}` })
            .innerText(),
        ).toContain("unrecorded — completion unknown");
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: join(evidence, `report-${viewport.name}-outbox-unrecorded.png`),
          fullPage: false,
        });
        proof.outboxDom = await page.locator("main").innerText();
        await open(page, legacy);
        expect(await page.locator("main").innerText()).toContain("unrecorded — completion unknown");
        // Direct completion without a replacement retains the latest comment.
        await page.getByLabel("Recipient comment", { exact: true }).fill("Retain this comment");
        await click(page, "Set comment");
        await click(page, "Complete processing");
        expect(cli(["get", legacy, "--as-user"]).processing).toMatchObject({ status: "completed", startedAt: null });
        expect(await comment(page).innerText()).toContain("Retain this comment");
        const declined = send(`Declined ${viewport.name}`);
        await open(page, declined);
        await page.getByLabel("Comment purpose").selectOption("change_request");
        await page.getByLabel("Recipient comment", { exact: true }).fill("Original explicit change request");
        await click(page, "Set comment");
        expect(await comment(page).innerText()).toContain("change_request; active request");
        expect(await page.getByRole("button", { name: "Set comment", exact: true }).isDisabled()).toBe(true);
        expect(await page.getByRole("button", { name: "Complete processing", exact: true }).isDisabled()).toBe(true);
        expect(await page.getByRole("button", { name: "Accept", exact: true }).isDisabled()).toBe(true);
        await page.getByLabel("Include comment with processing").check();
        expect(await page.getByRole("button", { name: "Start processing", exact: true }).isDisabled()).toBe(true);
        await page.getByLabel("Include comment with processing").uncheck();
        await click(page, "Start processing");
        await click(page, "Decline");
        expect(await comment(page).innerText()).toContain("change_request; inactive; target Revision 1");
        expect(await comment(page).innerText()).toContain("Original explicit change request");
        expect(await page.locator("main").innerText()).toContain(
          "Processing stopped (declined); historical evidence: in_progress",
        );
        await page.getByLabel("Recipient comment", { exact: true }).fill("Later general explanation after decline");
        await click(page, "Set comment");
        expect(cli(["get", declined, "--as-user"])).toMatchObject({
          reviewState: "declined",
          processing: { status: "in_progress", completedAt: null },
        });
        expect(await comment(page).innerText()).toContain("general; inactive");
        expect(await page.getByRole("button", { name: "Start processing", exact: true }).isDisabled()).toBe(true);
        expect(await page.getByRole("button", { name: "Complete processing", exact: true }).isDisabled()).toBe(true);
        expect(
          await page
            .getByLabel("Comment purpose")
            .locator('option[value="change_request"]')
            .evaluate((node) => (node as HTMLOptionElement).disabled),
        ).toBe(true);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(evidence, `report-${viewport.name}-declined.png`), fullPage: true });
        await page.goto(`${origin()}/#/inbox`);
        await page.waitForSelector("table tbody tr");
        expect(
          await page
            .getByRole("row")
            .filter({ hasText: `Declined ${viewport.name}` })
            .innerText(),
        ).toContain("Processing stopped (declined)");
        // Older attribution survives a real changed-content upload.
        const older = send(`Older ${viewport.name}`);
        await open(page, older);
        await page.getByLabel("Comment purpose").selectOption("change_request");
        await page.getByLabel("Recipient comment", { exact: true }).fill("Feedback about R1");
        await click(page, "Set comment");
        const upload = join(home, `replacement-${viewport.name}.bin`);
        writeFileSync(upload, new Uint8Array([0, 1, 2, 3]));
        await page.getByLabel("Replacement document").setInputFiles(upload);
        await click(page, "Revise through upload");
        expect(await comment(page).innerText()).toContain("target Revision 1 (older Revision)");
        expect(cli(["get", older, "--as-user"])).toMatchObject({
          revision: 2,
          read: { status: "unconfirmed" },
          processing: { status: "not_started" },
        });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(evidence, `report-${viewport.name}-older.png`), fullPage: true });
        // Report guards survive archive and tombstone content removal.
        await click(page, "Accept");
        await click(page, "Request deletion");
        await click(page, "Approve deletion");
        expect(await page.locator(".tombstone").innerText()).toContain("tombstone");
        expect(await report(page).count()).toBe(0);
        expect(await comment(page).count()).toBe(0);
        expect(await page.getByRole("button", { name: "Set comment", exact: true }).count()).toBe(0);
        const withdrawn = send(`Withdrawn ${viewport.name}`);
        cli(["withdraw", withdrawn, "--as-user"]);
        await open(page, withdrawn);
        expect(await page.locator("main").innerText()).toContain("Processing stopped (withdrawn)");
        await page.getByLabel("Recipient comment", { exact: true }).fill("Terminal general explanation");
        await click(page, "Set comment");
        expect(cli(["get", withdrawn, "--as-user"])).toMatchObject({
          reviewState: "withdrawn",
          processing: { status: "not_started", completedAt: null },
        });
        expect(await page.getByRole("button", { name: "Start processing", exact: true }).isDisabled()).toBe(true);
        await open(page, declined);
        const axeSource = readFileSync(
          fileURLToPath(new URL("../../node_modules/axe-core/axe.min.js", import.meta.url)),
          "utf8",
        );
        await page.evaluate(axeSource);
        const a11y = await page.evaluate(async () =>
          (
            window as unknown as {
              axe: { run: () => Promise<{ violations: Array<{ id: string; impact: string; nodes: unknown[] }> }> };
            }
          ).axe.run(),
        );
        proof.accessibility = a11y.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
        expect(a11y.violations.filter((v) => ["critical", "serious"].includes(v.impact))).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
        expect(errors).toEqual([]);
        expect(diagnostics).toEqual([]);
        Object.assign(proof, {
          pass: true,
          url: page.url(),
          title: await page.title(),
          identity: true,
          nonblank: true,
          noOverlay: true,
          interaction: true,
          dom: await page.locator("main").innerText(),
          complete: completed,
        });
      } finally {
        writeFileSync(join(evidence, `report-${viewport.name}-proof.json`), `${JSON.stringify(proof, null, 2)}\n`);
        await browser.close();
      }
    },
    90000,
  );
  it.each([
    { name: "desktop", width: 1280, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ])(
    "retains complete report proposals on conflict and uncertainty on $name",
    async (viewport) => {
      const evidence = process.env.SORAGE_UI_EVIDENCE_DIR ?? makeTempDir("sorage-report-conflict-");
      mkdirSync(evidence, { recursive: true });
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const errors: string[] = [];
      const diagnostics: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (["warning", "error"].includes(message.type())) diagnostics.push(message.text());
      });
      const proof: Record<string, unknown> = {
        viewport,
        errors,
        diagnostics,
        browser: "Playwright Chromium",
        browserAvailability: "Browser plugin not available",
      };
      try {
        const entry = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
        expect(entry.status).toBe(0);
        await page.goto(JSON.parse(entry.stdout).url as string);
        await page.waitForSelector(".counts");
        const id = send(`Conflict reporting ${viewport.name}`);
        await open(page, id);
        const exact = " Unsent proposal <script>untrusted</script>\nLine 2 가 with trailing space ";
        await page.getByLabel("Recipient comment", { exact: true }).fill(exact);
        await page.getByLabel("Include comment with processing").check();
        await page.getByLabel("Comment purpose").selectOption("change_request");
        await page.getByLabel("Review note", { exact: true }).fill("Retained legacy draft");
        const path = join(home, `conflict-${viewport.name}.md`);
        writeFileSync(path, "Keep the selected document");
        await page.getByLabel("Replacement document").setInputFiles(path);
        await page.getByLabel("Pinned deletion confirmation").fill("Keep confirmation");
        cli([
          "comment",
          "set",
          id,
          "--as-user",
          "--text",
          "Competing writer",
          "--expected-revision",
          "1",
          "--expected-row-version",
          "1",
        ]);
        const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"), { readOnly: true });
        const state = () =>
          ["handoffs", "review_notes", "events"].map((table) =>
            db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          );
        const before = state();
        const writes: unknown[] = [];
        let reads = 0;
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (request.method() === "GET" && url.pathname === `/api/v1/handoffs/${id}`) reads++;
          if (
            ["PUT", "POST"].includes(request.method()) &&
            ["/comment", "/processing/complete"].some((suffix) => url.pathname === `/api/v1/handoffs/${id}${suffix}`)
          )
            writes.push(request.postDataJSON());
        });
        try {
          for (const name of ["Set comment", "Complete processing"]) {
            const response = page.waitForResponse(
              (response) => response.request().method() !== "GET" && response.url().includes(`/api/v1/handoffs/${id}`),
            );
            await page.getByRole("button", { name, exact: true }).click();
            const refused = await response;
            expect(refused.status()).toBe(409);
            expect(await refused.json()).toMatchObject({ error: { code: "ROW_VERSION_CONFLICT" } });
            await page.waitForFunction(() =>
              document
                .querySelector('[aria-label="Recipient reporting"] [role="status"]')
                ?.textContent?.includes("ROW_VERSION_CONFLICT"),
            );
            expect(await page.getByLabel("Recipient comment", { exact: true }).inputValue()).toBe(exact);
            expect(await page.getByLabel("Comment purpose").inputValue()).toBe("change_request");
            expect(await page.getByLabel("Include comment with processing").isChecked()).toBe(true);
            expect(await page.getByLabel("Review note", { exact: true }).inputValue()).toBe("Retained legacy draft");
            expect(await page.getByLabel("Pinned deletion confirmation").inputValue()).toBe("Keep confirmation");
            expect(
              await page
                .getByLabel("Replacement document")
                .evaluate((node) => (node as HTMLInputElement).files?.[0]?.name),
            ).toBe(`conflict-${viewport.name}.md`);
            expect(state()).toEqual(before);
            expect(reads).toBe(0);
          }
          expect(writes).toEqual([
            { text: exact, purpose: "change_request", expectedRevision: 1, expectedRowVersion: 1 },
            { comment: exact, expectedRevision: 1, expectedRowVersion: 1 },
          ]);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: join(evidence, `report-${viewport.name}-conflict.png`), fullPage: true });
          proof.conflict = {
            writes: [...writes],
            reads,
            unchanged: true,
            dom: await page.locator("main").innerText(),
            draft: exact,
          };
          // Explicit inspection acquires a fresh proposal basis. No automatic mutation follows it.
          await page.reload();
          await page.waitForLoadState("networkidle");
          await page.getByLabel("Recipient comment", { exact: true }).fill("Reconciled deliberately");
          await click(page, "Set comment");
          expect(cli(["comment", "show", id, "--as-user"]).body).toBe("Reconciled deliberately");
          // An actual Revision conflict likewise retains the old basis and complete proposal.
          await page.getByLabel("Recipient comment", { exact: true }).fill(exact);
          const loaded = cli(["get", id, "--as-user"]);
          cli([
            "revise",
            id,
            "--as-user",
            "--body",
            "R2 document",
            "--expected-row-version",
            String(loaded.rowVersion),
          ]);
          const revisionBefore = state();
          const stale = page.waitForResponse(
            (response) => response.request().method() === "PUT" && response.url().includes(`/handoffs/${id}/comment`),
          );
          await page.getByRole("button", { name: "Set comment", exact: true }).click();
          expect(await (await stale).json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
          expect(await page.getByLabel("Recipient comment", { exact: true }).inputValue()).toBe(exact);
          expect(state()).toEqual(revisionBefore);
          await page.reload();
          await page.waitForLoadState("networkidle");
          await page.getByLabel("Recipient comment", { exact: true }).fill(exact);
          await page.getByLabel("Include comment with processing").check();
          const beforeUnknown = state();
          let intercepted = 0;
          await page.route(`**/api/v1/handoffs/${id}/processing/start?asUser=true`, (route) => {
            intercepted++;
            return route.abort("failed");
          });
          const readsBeforeUnknown = reads;
          await page.getByRole("button", { name: "Start processing", exact: true }).click();
          await page.waitForFunction(() =>
            document
              .querySelector('[aria-label="Recipient reporting"] [role="status"]')
              ?.textContent?.includes("Outcome unknown"),
          );
          expect(intercepted).toBe(1);
          expect(reads).toBe(readsBeforeUnknown);
          expect(await page.getByLabel("Recipient comment", { exact: true }).inputValue()).toBe(exact);
          expect(await page.getByLabel("Include comment with processing").isChecked()).toBe(true);
          expect(state()).toEqual(beforeUnknown);
          expect(await report(page).innerText()).toContain(`Revision 2, Row Version ${loaded.rowVersion + 1}`);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: join(evidence, `report-${viewport.name}-unknown.png`), fullPage: true });
          proof.uncertainty = {
            intercepted,
            noAutomaticRead: true,
            noRetry: true,
            unchanged: true,
            dom: await report(page).innerText(),
            draft: exact,
          };
        } finally {
          db.close();
        }
        expect(errors).toEqual([]);
        expect(diagnostics.filter((text) => !/status of 409|net::ERR_FAILED/.test(text))).toEqual([]);
        Object.assign(proof, { pass: true, url: page.url(), title: await page.title() });
      } finally {
        writeFileSync(
          join(evidence, `report-${viewport.name}-conflict-proof.json`),
          `${JSON.stringify(proof, null, 2)}\n`,
        );
        await browser.close();
      }
    },
    90000,
  );
  it("labels a separately acquired newer comment against the original view without refreshing its proposal", async () => {
    const evidence = process.env.SORAGE_UI_EVIDENCE_DIR ?? makeTempDir("sorage-report-race-");
    mkdirSync(evidence, { recursive: true });
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      const entry = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
      expect(entry.status).toBe(0);
      await page.goto(JSON.parse(entry.stdout).url as string);
      await page.waitForSelector(".counts");
      // Same-document navigation retains this load state while the comment is pending.
      await page.waitForLoadState("networkidle");
      const id = send("Concurrent separate comment acquisition");
      let release: () => void = () => {};
      let arrived: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const acquired = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      await page.route(`**/api/v1/handoffs/${id}/comment?asUser=true`, async (route) => {
        arrived();
        await held;
        await route.continue();
      });
      await page.goto(`${origin()}/#/handoff/${id}`);
      await acquired;
      await page.waitForSelector('[aria-label="Recipient reporting"]');
      await page.getByLabel("Recipient comment", { exact: true }).fill("Draft based on original Revision 1");
      cli(["revise", id, "--as-user", "--body", "New Revision 2", "--expected-row-version", "1"]);
      cli([
        "comment",
        "set",
        id,
        "--as-user",
        "--text",
        "Newer Revision 2 feedback",
        "--expected-revision",
        "2",
        "--expected-row-version",
        "2",
      ]);
      expect(await comment(page).innerText()).toContain("Loading comment…");
      release();
      await browserExpect(comment(page)).toContainText("target Revision 2 (newer than this view; inspect explicitly)");
      const text = await comment(page).innerText();
      expect(text).not.toContain("current Revision");
      expect(await report(page).innerText()).toContain("Revision 1, Row Version 1");
      expect(await page.getByLabel("Recipient comment", { exact: true }).inputValue()).toBe(
        "Draft based on original Revision 1",
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(evidence, "report-newer-comment.png"), fullPage: true });
      writeFileSync(
        join(evidence, "report-newer-comment-proof.json"),
        JSON.stringify(
          {
            pass: true,
            url: page.url(),
            title: await page.title(),
            dom: await page.locator("main").innerText(),
            originalObservationsRetained: true,
          },
          null,
          2,
        ),
      );
    } finally {
      await browser.close();
    }
  });
});
