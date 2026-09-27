import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, type Page } from "@playwright/test";
import type { Memo, MemoReceipt } from "../../packages/core/src/index";
import { twoProjectFixture, sorage, envelopeOf, registerCleanup } from "./helpers";

export const MEMO_STORAGE = "sorage-memo-recovery-v1";
export async function memoBrowserFixture() {
  const f = twoProjectFixture("aj21-browser");
  const port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
  function run(args: string[], home = f.home) {
    const result = sorage([...args, "--json"], { home });
    if (result.status !== 0) throw new Error(result.stderr);
    return envelopeOf(result).data;
  }
  run(["config", "set", "server.port", String(port), "--as-user"]);
  run(["config", "set", "ui.defaultPageSize", "10", "--as-user"]);
  run(["daemon", "start"]);
  registerCleanup(() => {
    sorage(["daemon", "stop"], { home: f.home });
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const origin = `http://127.0.0.1:${port}`;
  const project = (run(["project", "show", "alpha"]) as { project: { id: string } }).project.id;
  const other = (run(["project", "show", "beta"]) as { project: { id: string } }).project.id;
  async function authenticate(target: Page = page, home = f.home) {
    const web = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
    if (web.status !== 0) throw new Error(web.stderr);
    await target.goto((JSON.parse(web.stdout) as { url: string }).url);
    await target.waitForSelector(".counts");
  }
  await authenticate();
  async function list(projectId = project, target = page) {
    await target.goto(`${origin}/#/memos?projectId=${projectId}`);
    await target.getByRole("button", { name: "Create Memo", exact: true }).waitFor();
  }
  function add(title: string, body = "", slug = "alpha"): Memo {
    return (run(["memo", "add", "--project", slug, "--title", title, "--body", body]) as MemoReceipt).memo;
  }
  function show(id: string): Memo {
    return run(["memo", "show", id]) as Memo;
  }
  function inventory(home = f.home) {
    const db = new DatabaseSync(join(home, "state", "sorage.sqlite3"));
    try {
      return ["project_memos", "events", "idempotency_keys"].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    } finally {
      db.close();
    }
  }
  function sql(sql: string, ...values: Array<string | number>) {
    const db = new DatabaseSync(join(f.home, "state", "sorage.sqlite3"));
    try {
      db.prepare(sql).run(...values);
    } finally {
      db.close();
    }
  }
  return {
    ...f,
    run,
    browser,
    page,
    port,
    origin,
    project,
    other,
    authenticate,
    list,
    add,
    show,
    inventory,
    sql,
    async close() {
      await browser.close();
    },
  };
}
export interface PendingMemo {
  origin: string;
  installationId: string;
  key: string;
  projectId: string;
  memoId: string | null;
  operation: string;
  title: string;
  firstAttemptAt: string;
  input: { title?: string; body?: string; projectId?: string; expectedRowVersion?: number };
}
export async function recovery(page: Page): Promise<{
  version: number;
  active: PendingMemo | null;
  notices: Array<Omit<PendingMemo, "input"> & { outcome: string; retryDisposition: string }>;
}> {
  return page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key) || '{"version":1,"active":null,"notices":[]}'),
    MEMO_STORAGE,
  );
}
export async function createThroughUi(page: Page, title: string, body = "") {
  await page.getByLabel("Memo title", { exact: true }).fill(title);
  await page.getByLabel("Memo body", { exact: true }).fill(body);
  await page.getByRole("button", { name: "Create Memo", exact: true }).click();
}
