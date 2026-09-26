import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProject,
  archiveProject,
  initializeInstallation,
  rebindProject,
  sendHandoffs,
  unbindProject,
  USER_ACTOR,
} from "@sorage/core";
import { afterAll, describe, expect, it } from "vitest";
import { createNodeSendPorts } from "../../src/handoff-command-ports";
import { createNodeInitPorts } from "../../src/init-ports";
import { createNodeProjectPorts } from "../../src/project-command-ports";
import { MIGRATIONS } from "../../src/sqlite/migrations";
import { openAndMigrate } from "../../src/sqlite/migrator";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("send sender registration race", () => {
  it.each([
    { archived: false, nested: false, allow: false, error: "SENDER_IDENTITY_DOWNGRADE" },
    { archived: true, nested: false, allow: false, error: "PROJECT_ARCHIVED" },
    { archived: false, nested: true, allow: false, error: "SENDER_IDENTITY_DOWNGRADE" },
    { archived: true, nested: true, allow: false, error: "SENDER_IDENTITY_DOWNGRADE" },
    { archived: false, nested: true, allow: true, error: null },
  ])(
    "applies registration and downgrade rules to a staged Workspace send (archived=$archived, nested=$nested, allow=$allow)",
    ({ archived, nested, allow, error }) => {
      const root = mkdtempSync(join(tmpdir(), "sorage-send-registration-"));
      roots.push(root);
      const home = join(root, "home");
      const sender = join(root, "sender");
      const recipient = join(root, "recipient");
      const userHome = join(root, "user");
      for (const directory of [home, sender, recipient, userHome]) mkdirSync(directory);
      const env = { SORAGE_HOME: home };
      const initialized = initializeInstallation(createNodeInitPorts({ env, userHome }), {
        vaultPath: join(home, "vault"),
      });
      expect(initialized.ok).toBe(true);
      const projects = createNodeProjectPorts({ env, userHome });
      const beta = addProject(projects, { name: "Beta", dir: recipient, userHome, actor: USER_ACTOR });
      expect(beta.ok).toBe(true);
      const ports = createNodeSendPorts({ env, userHome });
      ports.config.allowUnregisteredSenders = false;
      const stage = ports.artifactStore.stage.bind(ports.artifactStore);
      let injected = false;
      ports.artifactStore.stage = (input) => {
        const staged = stage(input);
        if (staged.ok && !injected) {
          injected = true;
          const bound = nested ? join(sender, "nested") : sender;
          if (nested) mkdirSync(bound);
          const alpha = addProject(projects, { name: "Alpha", dir: bound, userHome, actor: USER_ACTOR });
          expect(alpha.ok).toBe(true);
          if (archived) {
            const changed = archiveProject(projects, { slug: "alpha" });
            expect(changed.ok).toBe(true);
          }
        }
        return staged;
      };
      const result = sendHandoffs(ports, {
        to: ["beta"],
        title: "Raced send",
        body: "# Prepared before registration",
        allowExternalSource: false,
        allowUnregistered: allow,
        path: sender,
        userHome,
      });
      expect(injected).toBe(true);
      expect(result.ok).toBe(error === null);
      if (error !== null) expect(!result.ok && result.error.code).toBe(error);
      const db = openAndMigrate(join(home, "state", "sorage.sqlite3"), MIGRATIONS).db;
      const rows = db.prepare("SELECT id FROM handoffs").all();
      expect(rows).toHaveLength(error === null ? 1 : 0);
      db.close();
    },
  );
});

describe("send binding changes during staging", () => {
  it("rejects a registered sender after its path is rebound to another Project", () => {
    const root = mkdtempSync(join(tmpdir(), "sorage-send-rebind-race-"));
    roots.push(root);
    const home = join(root, "home");
    const sender = join(root, "sender");
    const replacement = join(root, "replacement");
    const recipient = join(root, "recipient");
    const userHome = join(root, "user");
    for (const directory of [home, sender, replacement, recipient, userHome]) mkdirSync(directory);
    const env = { SORAGE_HOME: home };
    expect(initializeInstallation(createNodeInitPorts({ env, userHome }), { vaultPath: join(home, "vault") }).ok).toBe(
      true,
    );
    const projects = createNodeProjectPorts({ env, userHome });
    expect(addProject(projects, { name: "Alpha", dir: sender, userHome, actor: USER_ACTOR }).ok).toBe(true);
    expect(addProject(projects, { name: "Beta", dir: recipient, userHome, actor: USER_ACTOR }).ok).toBe(true);
    const ports = createNodeSendPorts({ env, userHome });
    const stage = ports.artifactStore.stage.bind(ports.artifactStore);
    let injected = false;
    ports.artifactStore.stage = (input) => {
      const staged = stage(input);
      if (staged.ok && !injected) {
        injected = true;
        expect(
          rebindProject(projects, { slug: "alpha", from: sender, to: replacement, userHome, actor: USER_ACTOR }).ok,
        ).toBe(true);
        expect(addProject(projects, { name: "Gamma", dir: sender, userHome, actor: USER_ACTOR }).ok).toBe(true);
      }
      return staged;
    };
    const result = sendHandoffs(ports, {
      to: ["beta"],
      title: "Stale sender",
      body: "# Old path",
      allowExternalSource: false,
      allowUnregistered: false,
      path: sender,
      userHome,
    });
    expect(injected).toBe(true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("SENDER_IDENTITY_DOWNGRADE");
    const db = openAndMigrate(join(home, "state", "sorage.sqlite3"), MIGRATIONS).db;
    expect(db.prepare("SELECT id FROM handoffs").all()).toHaveLength(0);
    db.close();
  });

  it("rejects a recipient whose final binding was removed before creation commits", () => {
    const root = mkdtempSync(join(tmpdir(), "sorage-send-unbind-race-"));
    roots.push(root);
    const home = join(root, "home");
    const sender = join(root, "sender");
    const recipient = join(root, "recipient");
    const userHome = join(root, "user");
    for (const directory of [home, sender, recipient, userHome]) mkdirSync(directory);
    const env = { SORAGE_HOME: home };
    expect(initializeInstallation(createNodeInitPorts({ env, userHome }), { vaultPath: join(home, "vault") }).ok).toBe(
      true,
    );
    const projects = createNodeProjectPorts({ env, userHome });
    expect(addProject(projects, { name: "Alpha", dir: sender, userHome, actor: USER_ACTOR }).ok).toBe(true);
    expect(addProject(projects, { name: "Beta", dir: recipient, userHome, actor: USER_ACTOR }).ok).toBe(true);
    const ports = createNodeSendPorts({ env, userHome });
    const stage = ports.artifactStore.stage.bind(ports.artifactStore);
    let injected = false;
    ports.artifactStore.stage = (input) => {
      const staged = stage(input);
      if (staged.ok && !injected) {
        injected = true;
        expect(
          unbindProject(projects, { slug: "beta", dir: recipient, userHome, actor: USER_ACTOR, confirm: false }).ok,
        ).toBe(true);
      }
      return staged;
    };
    const result = sendHandoffs(ports, {
      to: ["beta"],
      title: "Unbound recipient",
      body: "# Pending",
      allowExternalSource: false,
      allowUnregistered: false,
      path: sender,
      userHome,
    });
    expect(injected).toBe(true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("PROJECT_UNBOUND");
    const db = openAndMigrate(join(home, "state", "sorage.sqlite3"), MIGRATIONS).db;
    expect(db.prepare("SELECT id FROM handoffs").all()).toHaveLength(0);
    db.close();
  });
});

describe("send idempotency race", () => {
  it.each([{ same: true }, { same: false }])(
    "returns the stored result or conflict after another send commits the same key (same=$same)",
    ({ same }) => {
      const root = mkdtempSync(join(tmpdir(), "sorage-send-idempotency-"));
      roots.push(root);
      const home = join(root, "home");
      const sender = join(root, "sender");
      const recipient = join(root, "recipient");
      const userHome = join(root, "user");
      for (const directory of [home, sender, recipient, userHome]) mkdirSync(directory);
      const env = { SORAGE_HOME: home };
      expect(
        initializeInstallation(createNodeInitPorts({ env, userHome }), { vaultPath: join(home, "vault") }).ok,
      ).toBe(true);
      const projects = createNodeProjectPorts({ env, userHome });
      expect(addProject(projects, { name: "Alpha", dir: sender, userHome, actor: USER_ACTOR }).ok).toBe(true);
      expect(addProject(projects, { name: "Beta", dir: recipient, userHome, actor: USER_ACTOR }).ok).toBe(true);
      const ports = createNodeSendPorts({ env, userHome });
      const key = "a75a53b2-243c-4f31-861f-00d89958db95";
      const input = {
        to: ["beta"],
        title: "Raced key",
        body: "# Original",
        idempotencyKey: key,
        allowExternalSource: false,
        allowUnregistered: false,
        path: sender,
        userHome,
      };
      const stage = ports.artifactStore.stage.bind(ports.artifactStore);
      let winnerId: string | undefined;
      ports.artifactStore.stage = (source) => {
        const staged = stage(source);
        if (staged.ok && winnerId === undefined) {
          const winner = sendHandoffs(createNodeSendPorts({ env, userHome }), {
            ...input,
            body: same ? input.body : "# Different",
          });
          expect(winner.ok).toBe(true);
          if (!winner.ok) throw new Error(winner.error.message);
          winnerId = winner.value.handoffs[0]?.handoffId;
          if (same) expect(archiveProject(projects, { slug: "alpha" }).ok).toBe(true);
        }
        return staged;
      };
      const result = sendHandoffs(ports, input);
      expect(winnerId).toBeDefined();
      if (same) {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.replayed).toBe(true);
          expect(result.value.handoffs[0]?.handoffId).toBe(winnerId);
        }
      } else {
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error.code).toBe("IDEMPOTENCY_CONFLICT");
      }
      const db = openAndMigrate(join(home, "state", "sorage.sqlite3"), MIGRATIONS).db;
      expect(db.prepare("SELECT id FROM handoffs").all()).toHaveLength(1);
      db.close();
    },
  );
});
