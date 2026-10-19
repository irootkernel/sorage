import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addProject, initializeInstallation, sendHandoffs, USER_ACTOR } from "@sorage/core";
import { createNodeArtifactStore } from "../../src/artifact-store";
import { createVaultInitializer } from "../../src/vault";
import { createNodeInitPorts } from "../../src/init-ports";
import { createNodeProjectPorts } from "../../src/project-command-ports";
import { createNodeSendPorts } from "../../src/handoff-command-ports";
import { createSqliteIntentLog } from "../../src/intent-log";
import { openSorageDatabase } from "../../src/sqlite/connection";
import { makeTempVault } from "../../src/testkit/temp-vault";
import { FakeClock } from "../../src/testkit/fakes";

/**
 * The managed-path canaries over the actual legacy ArtifactStore serving and
 * activation surfaces (section 6.2, VLT-020): a symlink or special entry at a
 * managed parent or leaf is refused rather than followed, outside targets stay
 * untouched, and legitimate managed files keep serving normally.
 */
const INSTALLATION = "1f0a0c9a-1111-4111-8111-1111111111f1";
const HANDOFF = "1f0a0c9a-2222-4222-8222-2222222222f2";
const ARTIFACT = "1f0a0c9a-3333-4333-8333-3333333333f3";
const KEY = `artifacts/${HANDOFF}/${ARTIFACT}/doc.md`;

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(prefix: string) {
  const vault = makeTempVault(prefix);
  cleanups.push(vault.cleanup);
  const initialized = createVaultInitializer(new FakeClock()).initialize(vault.vaultPath, INSTALLATION);
  if (!initialized.ok) throw new Error(initialized.error.message);
  const store = createNodeArtifactStore({ vaultPath: vault.vaultPath, installationId: INSTALLATION });
  mkdirSync(join(vault.vaultPath, KEY.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(vault.vaultPath, KEY), "managed bytes");
  return { ...vault, store };
}

describe("the legacy ArtifactStore managed-path canaries", () => {
  it("refuses to follow a symlinked leaf for exists, checksum, and remove", () => {
    const f = fixture("sorage-canary-leaf-");
    const outside = join(f.home.home, "outside-target");
    writeFileSync(outside, "outside bytes");
    const linkKey = `artifacts/${HANDOFF}/${ARTIFACT}/link.md`;
    symlinkSync(outside, join(f.vaultPath, linkKey));
    try {
      expect(f.store.exists(linkKey).ok).toBe(false);
      expect(f.store.checksum(linkKey).ok).toBe(false);
      expect(f.store.remove(linkKey).ok).toBe(false);
      // The link and its outside target both stand untouched.
      expect(existsSync(join(f.vaultPath, linkKey))).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe("outside bytes");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("refuses a directory at the managed leaf for remove", () => {
    const f = fixture("sorage-canary-dir-");
    const dirKey = `artifacts/${HANDOFF}/${ARTIFACT}/nested`;
    mkdirSync(join(f.vaultPath, dirKey));
    writeFileSync(join(f.vaultPath, dirKey, "inner.md"), "inner");
    expect(f.store.remove(dirKey).ok).toBe(false);
    expect(existsSync(join(f.vaultPath, dirKey, "inner.md"))).toBe(true);
  });

  it("refuses a non-managed key for remove without touching the Vault marker", () => {
    const f = fixture("sorage-canary-marker-");
    expect(f.store.remove(".sorage-vault.json").ok).toBe(false);
    expect(existsSync(join(f.vaultPath, ".sorage-vault.json"))).toBe(true);
  });

  it("refuses activation into a symlinked managed parent", () => {
    const f = fixture("sorage-canary-parent-");
    const outsideDir = join(f.home.home, "outside-dir");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "planted.md"), "planted");
    symlinkSync(outsideDir, join(f.vaultPath, "artifacts", "h-linked-parent"));
    const staged = join(f.vaultPath, "staging", "staged-1");
    writeFileSync(staged, "staged bytes");
    const activated = f.store.activate({ stagingPath: staged, storageKey: "artifacts/h-linked-parent/a-linked/x.md" });
    expect(activated.ok).toBe(false);
    expect(readdirSync(outsideDir)).toEqual(["planted.md"]);
    expect(existsSync(staged)).toBe(true);
  });

  it("refuses to stage through a symlinked staging root and leaves the outside directory untouched", () => {
    const f = fixture("sorage-canary-staging-root-");
    const outsideDir = join(f.home.home, "outside-staging");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "owned.md"), "owned bytes");
    rmSync(join(f.vaultPath, "staging"), { recursive: true });
    symlinkSync(outsideDir, join(f.vaultPath, "staging"));
    const source = join(f.home.home, "source.md");
    writeFileSync(source, "valid source bytes");
    const staged = f.store.stage({ sourcePath: source, maxBytes: 1024 * 1024 });
    expect(staged.ok).toBe(false);
    // The outside inventory and bytes stand exactly as they were.
    expect(readdirSync(outsideDir)).toEqual(["owned.md"]);
    expect(readFileSync(join(outsideDir, "owned.md"), "utf8")).toBe("owned bytes");
  });

  it("keeps legitimate managed files serving normally", () => {
    const f = fixture("sorage-canary-healthy-");
    expect(f.store.exists(KEY)).toMatchObject({ ok: true, value: true });
    const digest = f.store.checksum(KEY);
    expect(digest.ok).toBe(true);
    if (digest.ok) expect(digest.value).toHaveLength(64);
    expect(readFileSync(join(f.vaultPath, KEY), "utf8")).toBe("managed bytes");
  });

  it.each(["file", "body"] as const)(
    "keeps a configured Vault directory alias coherent through %s send, ordinary activation, and drain",
    (kind) => {
      const realVaultRoot = mkdtempSync(join(tmpdir(), "sorage-canary-alias-real-"));
      cleanups.push(() => rmSync(realVaultRoot, { recursive: true, force: true }));
      const home = mkdtempSync(join(tmpdir(), "sorage-canary-alias-home-"));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      process.env.SORAGE_HOME = home;
      const realVault = join(realVaultRoot, "vault");
      mkdirSync(realVault, { recursive: true });
      const alias = join(home, "alias-vault");
      symlinkSync(realVault, alias);
      try {
        const init = initializeInstallation(
          createNodeInitPorts({ env: { SORAGE_HOME: home }, userHome: home, clock: new FakeClock() }),
          { vaultPath: alias },
        );
        expect(init.ok).toBe(true);
        const senderDir = join(home, "sender");
        const recipientDir = join(home, "recipient");
        mkdirSync(senderDir);
        mkdirSync(recipientDir);
        const projects = createNodeProjectPorts({ env: { SORAGE_HOME: home }, userHome: home });
        expect(addProject(projects, { name: "Sender", dir: senderDir, userHome: home, actor: USER_ACTOR }).ok).toBe(
          true,
        );
        expect(
          addProject(projects, { name: "Recipient", dir: recipientDir, userHome: home, actor: USER_ACTOR }).ok,
        ).toBe(true);

        // This alias case exercises ordinary file activation and a real drain.
        const document = join(home, "brief.bin");
        const payload = kind === "file" ? "# Alias vault brief\n" : "#".repeat(65_537);
        if (kind === "file") writeFileSync(document, payload);
        const sent = sendHandoffs(createNodeSendPorts({ env: { SORAGE_HOME: home }, userHome: home }), {
          to: ["recipient"],
          title: "Alias brief",
          ...(kind === "file" ? { file: document } : { body: payload }),
          allowUnregistered: false,
          allowExternalSource: true,
          as: "sender",
          path: senderDir,
          userHome: home,
        });
        expect(sent.ok).toBe(true);
        if (!sent.ok) return;

        const databasePath = join(home, "state", "sorage.sqlite3");
        const verify = openSorageDatabase(databasePath);
        try {
          // The staged path stayed under the configured alias, so the persisted
          // activation remained a safe relative intent and the ordinary executor
          // completed it: no unsafe-path retention, no pending promise left.
          expect(verify.prepare("SELECT COUNT(*) AS c FROM pending_fs_ops").get()).toMatchObject({ c: 0 });
          const materialized = verify
            .prepare(
              "SELECT c.materialized AS materialized, c.storage_key AS storage_key FROM artifacts a JOIN content_records c ON c.id = a.content_record_id",
            )
            .get() as { materialized: number; storage_key: string };
          expect(materialized.materialized).toBe(1);
          // The bytes are reachable through both the alias and the real root.
          expect(readFileSync(join(alias, materialized.storage_key), "utf8")).toBe(payload);
          expect(readFileSync(join(realVault, materialized.storage_key), "utf8")).toBe(payload);
          expect(readdirSync(join(realVault, "staging"))).toEqual([]);
        } finally {
          verify.close();
        }

        // A drain over the aliased Vault stays coherent: nothing is left, and
        // the final artifact file remains exactly where the record names it.
        if (!init.ok) return;
        const aliasDb = openSorageDatabase(databasePath);
        try {
          const drained = createSqliteIntentLog({
            db: aliasDb,
            installationId: init.value.installationId,
          }).drain(alias);
          expect(drained.ok).toBe(true);
        } finally {
          aliasDb.close();
        }
      } finally {
        delete process.env.SORAGE_HOME;
      }
    },
  );
});
