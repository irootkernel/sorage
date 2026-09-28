import { mkdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir, sorage } from "./helpers";

/**
 * AJ-18: the User creates a Handoff from Web compose body text, as User, with the
 * M2 file-upload path unchanged (WEB-019, API-013, HND-023, ADR-0025).
 */
const home = makeTempDir("sorage-aj18-home-");
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

function raw(path: string, init: { method?: string; bearer?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

beforeAll(async () => {
  port = await freePort();
  expect(sorage(["init", "--vault", `${home}/vault`, "--non-interactive", "--json"], { home }).status).toBe(0);
  expect(sorage(["config", "set", "server.port", String(port), "--as-user", "--json"], { home }).status).toBe(0);
  for (const name of ["alpha", "beta"]) {
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true });
    expect(sorage(["project", "add", "--name", name, "--dir", dir, "--json"], { home, cwd: dir }).status).toBe(0);
  }
  expect(sorage(["daemon", "start", "--json"], { home }).status).toBe(0);
  cleanup.push(() => sorage(["daemon", "stop", "--json"], { home }));
});

afterAll(() => {
  for (const close of cleanup.reverse()) close();
});

describe("AJ-18 User creates a Handoff from Web compose body text", () => {
  it("sends body-only as the User, refuses XOR in the UI, and keeps file upload", async () => {
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    const page = await browser.newPage();
    const web = sorage(["web", "--json"], { home, env: { SORAGE_WEB_SUPPRESS_OPEN: "1" } });
    expect(web.status).toBe(0);
    await page.goto((JSON.parse(web.stdout) as { url: string }).url);
    await page.waitForFunction(() => window.document.querySelector("#session-note")?.textContent === "");

    await page.goto(`http://127.0.0.1:${port}/#/compose`);
    expect(await page.getByLabel("Title").count()).toBe(1);
    expect(await page.getByLabel("To").count()).toBe(1);
    expect(await page.getByLabel("Document").count()).toBe(1);
    expect(await page.getByLabel("Body").count()).toBe(1);
    expect(await page.locator("select").count()).toBe(0);
    expect(await page.getByText("allow-unregistered", { exact: false }).count()).toBe(0);
    expect(await page.getByText("unregistered", { exact: false }).count()).toBe(0);

    await page.getByLabel("Title").fill("Compose Body");
    await page.getByLabel("To").fill("beta");
    await page.getByLabel("Body").fill("# Compose body\n\nfrom the Web form.\n");
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll("form ul li").length === 1);
    const sent = await page.$eval("form ul li", (item) => item.textContent ?? "");
    const handoffId = /([0-9a-f-]{36})/.exec(sent)?.[1] ?? "";
    expect(handoffId).not.toBe("");

    const token = await page.evaluate(() => sessionStorage.getItem("sorage-session"));
    expect(token).toBeTruthy();
    const detail = await raw(`/api/v1/handoffs/${handoffId}?asUser=true`, { bearer: token ?? "" });
    expect(detail.status).toBe(200);
    const data = JSON.parse(detail.body).data as {
      senderKind: string;
      currentArtifact: { originalName: string; mimeType: string };
    };
    expect(data.senderKind).toBe("user");
    expect(data.currentArtifact.originalName).toBe("compose-body-1.md");
    expect(data.currentArtifact.mimeType).toBe("text/markdown");

    await page.goto(`http://127.0.0.1:${port}/#/inbox`);
    await page.waitForSelector("table tbody tr");
    await page.goto(`http://127.0.0.1:${port}/#/handoff/${handoffId}`);
    await page.waitForSelector("dl.meta");
    await page.waitForFunction(() => document.body.textContent?.includes("from the Web form"));
    expect(await page.textContent("main")).toContain("from the Web form");

    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download" }).click();
    const artifactDownload = await downloaded;
    expect(artifactDownload.suggestedFilename()).toBe("compose-body-1.md");
    expect(readFileSync(await artifactDownload.path())).toEqual(
      Buffer.from("# Compose body\r\n\r\nfrom the Web form.\r\n"),
    );

    const downloadUrl = `**/api/v1/handoffs/${handoffId}/artifact/content?asUser=true`;
    await page.route(downloadUrl, (route) => route.fulfill({ status: 401, body: "" }));
    await page.getByRole("button", { name: "Download" }).click();
    await page.waitForFunction(() => document.body.textContent?.includes("Download failed (HTTP 401)."));
    await page.unroute(downloadUrl);

    await page.goto(`http://127.0.0.1:${port}/#/dashboard`);
    await page.goto(`http://127.0.0.1:${port}/#/compose`);
    await page.getByLabel("Title").fill("Both refused");
    await page.getByLabel("To").fill("beta");
    await page.getByLabel("Body").fill("# should not send");
    await page.setInputFiles('input[type="file"]', {
      name: "both.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# file\n"),
    });
    await page.click('button[type="submit"]');
    expect(await page.textContent("form")).toContain("not both");
    expect(await page.locator("form ul li").count()).toBe(0);

    await page.getByLabel("Body").fill("");
    await page.setInputFiles('input[type="file"]', []);
    await page.getByLabel("Title").fill("Neither refused");
    await page.getByLabel("To").fill("beta");
    await page.click('button[type="submit"]');
    expect(await page.textContent("form")).toContain("Choose a document or enter a Markdown body.");
    expect(await page.locator("form ul li").count()).toBe(0);

    await page.goto(`http://127.0.0.1:${port}/#/dashboard`);
    await page.goto(`http://127.0.0.1:${port}/#/compose`);
    await page.getByLabel("Title").fill("File still works");
    await page.getByLabel("To").fill("beta");
    await page.setInputFiles('input[type="file"]', {
      name: "still.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# file still works\n"),
    });
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll("form ul li").length === 1);
    const fileSent = await page.$eval("form ul li", (item) => item.textContent ?? "");
    const fileId = /([0-9a-f-]{36})/.exec(fileSent)?.[1] ?? "";
    const fileDetail = await raw(`/api/v1/handoffs/${fileId}?asUser=true`, { bearer: token ?? "" });
    expect(JSON.parse(fileDetail.body).data.currentArtifact.originalName).toBe("still.md");
  });
});
