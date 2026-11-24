import { describe, expect, it, vi } from "vitest";
import {
  type ApplyInitChoicesPorts,
  appError,
  applyInitChoices,
  CONFIG_ACCESS_REPAIR,
  CONFIG_PATH_REPAIR,
  err,
  type InitChoicesInput,
  type InitResult,
  ok,
} from "../../src/index";

function defaultChoices(overrides: Partial<InitChoicesInput> = {}): InitChoicesInput {
  return {
    vaultPath: "/tmp/sorage-home/vault",
    createVault: true,
    serverPort: 46321,
    installService: false,
    startDaemon: false,
    initializeGit: false,
    enableDailyBackup: false,
    backupAt: "03:00",
    backupTimezone: "UTC",
    enablePush: false,
    pushRemote: "origin",
    pushBranch: "main",
    registerProject: false,
    projectName: "",
    projectDir: "",
    ...overrides,
  };
}

function createdResult(overrides: Partial<InitResult> = {}): InitResult {
  return {
    outcome: "created",
    installationId: "11111111-1111-4111-8111-111111111111",
    vaultPath: "/tmp/sorage-home/vault",
    home: "/tmp/sorage-home",
    ...overrides,
  };
}

function makePorts(overrides: Partial<ApplyInitChoicesPorts> = {}): ApplyInitChoicesPorts {
  return {
    configFile: "/tmp/sorage-home/config.yaml",
    defaultVaultPath: "/tmp/sorage-home/vault",
    existingConfiguration: () => "absent",
    vaultExists: () => true,
    initialize: () => ok(createdResult()),
    configuredVaultOpens: () => true,
    configureBackup: () => ok({ gitBackup: {} }),
    addProject: () =>
      ok({
        project: { slug: "alpha", displayName: "Alpha" },
        binding: { bindingKind: "directory", directory: "/tmp/work-a" },
      }),
    installService: () => ok({ plistPath: "/tmp/LaunchAgents/xyz.rootkernel.sorage.plist", bootstrapped: true }),
    startDaemon: () => ({ ok: true }),
    ...overrides,
  };
}

describe("applyInitChoices", () => {
  it("refuses unreadable and unsafe existing configuration paths before initializing", () => {
    const initSpy = vi.fn(() => ok(createdResult()));
    const unreadable = applyInitChoices(makePorts({ existingConfiguration: () => "unreadable", initialize: initSpy }), {
      choices: defaultChoices(),
      vaultOption: undefined,
    });
    expect(unreadable).toEqual({
      kind: "error",
      error: {
        code: "CONFIG_INVALID",
        message: "The configuration at /tmp/sorage-home/config.yaml cannot be read.",
        recovery: { suggestedCommand: CONFIG_ACCESS_REPAIR },
      },
    });
    const unsafe = applyInitChoices(makePorts({ existingConfiguration: () => "unsafe-path", initialize: initSpy }), {
      choices: defaultChoices(),
      vaultOption: undefined,
    });
    expect(unsafe).toEqual({
      kind: "error",
      error: {
        code: "CONFIG_INVALID",
        message: "The configuration path /tmp/sorage-home/config.yaml is not a regular file.",
        recovery: { suggestedCommand: CONFIG_PATH_REPAIR },
      },
    });
    expect(initSpy).not.toHaveBeenCalled();
  });

  it("returns declined-missing-vault when createVault is false and the directory does not exist", () => {
    const initSpy = vi.fn(() => ok(createdResult()));
    const outcome = applyInitChoices(makePorts({ vaultExists: () => false, initialize: initSpy }), {
      choices: defaultChoices({ createVault: false, vaultPath: "/tmp/missing-vault" }),
      vaultOption: "/tmp/missing-vault",
    });
    expect(outcome).toEqual({ kind: "declined-missing-vault", vaultPath: "/tmp/missing-vault" });
    expect(initSpy).not.toHaveBeenCalled();
  });

  it("attaches sorage doctor recoveryOverride only for initialize CONFIG_INVALID failures", () => {
    const configInvalid = applyInitChoices(
      makePorts({ initialize: () => err(appError("CONFIG_INVALID", "broken yaml")) }),
      { choices: defaultChoices(), vaultOption: undefined },
    );
    expect(configInvalid).toEqual({
      kind: "error",
      error: appError("CONFIG_INVALID", "broken yaml"),
      recoveryOverride: "sorage doctor",
    });

    const other = applyInitChoices(makePorts({ initialize: () => err(appError("CONFIG_CONFLICT", "race")) }), {
      choices: defaultChoices(),
      vaultOption: undefined,
    });
    expect(other).toEqual({
      kind: "error",
      error: appError("CONFIG_CONFLICT", "race"),
      recoveryOverride: undefined,
    });
  });

  it("reports already-initialized and probes configuredVaultOpens only when needed", () => {
    const probeSpy = vi.fn(() => false);
    const human = applyInitChoices(
      makePorts({
        initialize: () => ok(createdResult({ outcome: "already-initialized" })),
        configuredVaultOpens: probeSpy,
      }),
      { choices: defaultChoices(), vaultOption: undefined, probeVaultOpens: true },
    );
    expect(human).toEqual({
      kind: "already-initialized",
      init: createdResult({ outcome: "already-initialized" }),
      vaultOpens: false,
    });
    expect(probeSpy).toHaveBeenCalledTimes(1);

    probeSpy.mockClear();
    const json = applyInitChoices(
      makePorts({
        initialize: () => ok(createdResult({ outcome: "already-initialized" })),
        configuredVaultOpens: probeSpy,
      }),
      { choices: defaultChoices(), vaultOption: undefined, probeVaultOpens: false },
    );
    expect(json).toEqual({
      kind: "already-initialized",
      init: createdResult({ outcome: "already-initialized" }),
    });
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it("executes optional steps in configuration order and subsumes startDaemon under installService", () => {
    const calls: string[] = [];
    const outcome = applyInitChoices(
      makePorts({
        initialize: (opts) => {
          calls.push(`init:${String(opts.vaultPath)}:${String(opts.serverPort)}`);
          return ok(createdResult());
        },
        configureBackup: (input) => {
          calls.push(`backup:${input.action}`);
          return ok({ gitBackup: {} });
        },
        addProject: (input) => {
          calls.push(`project:${input.name}`);
          return ok({
            project: { slug: "alpha", displayName: input.name },
            binding: { bindingKind: "directory", directory: input.dir },
          });
        },
        installService: () => {
          calls.push("service");
          return ok({ plistPath: "/tmp/plist", bootstrapped: true });
        },
        startDaemon: () => {
          calls.push("daemon");
          return { ok: true };
        },
      }),
      {
        choices: defaultChoices({
          enableDailyBackup: true,
          backupAt: "04:15",
          backupTimezone: "Asia/Seoul",
          enablePush: true,
          pushRemote: "origin",
          pushBranch: "main",
          registerProject: true,
          projectName: "Alpha",
          projectDir: "/tmp/work-a",
          installService: true,
          startDaemon: true,
        }),
        vaultOption: undefined,
      },
    );
    expect(calls).toEqual(["init:undefined:46321", "backup:enable", "backup:enable-push", "project:Alpha", "service"]);
    expect(outcome).toEqual({
      kind: "completed",
      created: true,
      init: createdResult(),
      backup: { enabled: true, at: "04:15", timezone: "Asia/Seoul" },
      push: { remote: "origin", branch: "main" },
      project: { slug: "alpha", displayName: "Alpha", bindingKind: "directory", binding: "/tmp/work-a" },
      service: {
        label: "xyz.rootkernel.sorage",
        plistPath: "/tmp/plist",
        bootstrapped: true,
        subsumedStartDaemon: true,
      },
    });
  });

  it("passes raw daemon-start exit code without wrapping as AppError and supports reconfigure --install-service", () => {
    const failedDaemon = applyInitChoices(makePorts({ startDaemon: () => ({ ok: false, exitCode: 69 }) }), {
      choices: defaultChoices({ startDaemon: true }),
      vaultOption: undefined,
    });
    expect(failedDaemon).toEqual({ kind: "daemon-start-failed", exitCode: 69 });

    const reconfigured = applyInitChoices(
      makePorts({
        initialize: () => ok(createdResult({ outcome: "already-initialized" })),
        installService: () => ok({ plistPath: "/tmp/plist", bootstrapped: false }),
      }),
      { choices: defaultChoices({ installService: true }), vaultOption: undefined, reconfigure: true },
    );
    expect(reconfigured).toEqual({
      kind: "completed",
      created: false,
      init: createdResult({ outcome: "already-initialized" }),
      service: {
        label: "xyz.rootkernel.sorage",
        plistPath: "/tmp/plist",
        bootstrapped: false,
        subsumedStartDaemon: false,
      },
    });
  });
});
