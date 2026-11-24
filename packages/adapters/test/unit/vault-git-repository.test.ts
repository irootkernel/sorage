import { type AppError, MANAGED_PATHSPECS, ok, type Result } from "@sorage/core";
import { describe, expect, it } from "vitest";
import {
  type AsyncGitClient,
  classifyPushFailure,
  GIT_ARGS,
  type GitClient,
  type GitRunOutcome,
  type GitRunRequest,
  gitInvocationError,
} from "../../src/git-client";
import { createNodeAsyncVaultGitRepository, createNodeVaultGitRepository } from "../../src/vault-git-repository";

type ScriptResponder = (request: GitRunRequest) => Result<GitRunOutcome, AppError> | null;

function scriptedSyncClient(responders: ScriptResponder[]) {
  const requests: GitRunRequest[] = [];
  const client: GitClient = {
    run(request) {
      requests.push(request);
      for (const respond of responders) {
        const result = respond(request);
        if (result !== null) return result;
      }
      return ok({ exitCode: 0, stdout: "", stderr: "" });
    },
  };
  return { client, requests };
}

function scriptedAsyncClient(responders: ScriptResponder[]) {
  const requests: GitRunRequest[] = [];
  const client: AsyncGitClient = {
    async run(request) {
      requests.push(request);
      for (const respond of responders) {
        const result = respond(request);
        if (result !== null) return result;
      }
      return ok({ exitCode: 0, stdout: "", stderr: "" });
    },
  };
  return { client, requests };
}

describe("classifyPushFailure", () => {
  it.each([
    "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
    "fatal: unable to get password from user",
  ])("maps a missing credential to GIT_AUTH_REQUIRED: %s", (stderr) => {
    const error = classifyPushFailure({ exitCode: 128, stderr, stdout: "" });
    expect(error.code).toBe("GIT_AUTH_REQUIRED");
    expect(error.message).toBe(`Pushing to the remote needs a credential that batch mode cannot supply: ${stderr}`);
    expect(error.details).toEqual({ exitCode: 128 });
  });

  it("maps an authentication refusal to GIT_AUTH_REQUIRED", () => {
    const error = classifyPushFailure({
      exitCode: 128,
      stderr: "git@example.com: Permission denied (publickey).",
      stdout: "",
    });
    expect(error.code).toBe("GIT_AUTH_REQUIRED");
  });

  it("maps a non-fast-forward rejection to GIT_BACKUP_CONFLICT with byte-identical message", () => {
    const error = classifyPushFailure({
      exitCode: 1,
      stderr: "To origin\n ! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs",
      stdout: "",
    });
    expect(error.code).toBe("GIT_BACKUP_CONFLICT");
    expect(error.message).toBe(
      "The push was refused; resolve the remote state manually, Sorage never force pushes: To origin",
    );
    expect(error.details).toEqual({ exitCode: 1 });
  });
});

describe.each([
  {
    name: "sync VaultGitRepository",
    make: (responders: ScriptResponder[]) => {
      const { client, requests } = scriptedSyncClient(responders);
      const repo = createNodeVaultGitRepository("/vault", client);
      return {
        requests,
        initialize: async (branch: string) => repo.initialize(branch),
        autocrlf: async () => repo.autocrlf(),
        currentBranch: async () => repo.currentBranch(),
        stagedPaths: async () => repo.stagedPaths(),
        trackedPaths: async () => repo.trackedPaths(),
        stageManaged: async () => repo.stageManaged(),
        hasStagedManagedChanges: async () => repo.hasStagedManagedChanges(),
        commit: async (message: string) => repo.commit(message),
        push: async (target: { remote: string; branch: string }) => repo.push(target),
      };
    },
  },
  {
    name: "async AsyncVaultGitRepository",
    make: (responders: ScriptResponder[]) => {
      const { client, requests } = scriptedAsyncClient(responders);
      const repo = createNodeAsyncVaultGitRepository("/vault", client);
      return {
        requests,
        initialize: (branch: string) => repo.initialize(branch),
        autocrlf: () => repo.autocrlf(),
        currentBranch: () => repo.currentBranch(),
        stagedPaths: () => repo.stagedPaths(),
        trackedPaths: () => repo.trackedPaths(),
        stageManaged: () => repo.stageManaged(),
        hasStagedManagedChanges: () => repo.hasStagedManagedChanges(),
        commit: (message: string) => repo.commit(message),
        push: (target: { remote: string; branch: string }) => repo.push(target),
      };
    },
  },
])("$name", ({ make }) => {
  it("initializes the repository on the configured branch and sets core.autocrlf=false", async () => {
    const repo = make([]);
    const result = await repo.initialize("main");
    expect(result.ok).toBe(true);
    expect(repo.requests.map((r) => r.args)).toEqual([
      GIT_ARGS.init("main"),
      GIT_ARGS.configSet("core.autocrlf", "false"),
    ]);
  });

  it("formats non-zero init and stage failures as exact git <context> refused messages", async () => {
    const initFailed = make([(req) => (req.args[0] === "init" ? ok({ exitCode: 128, stdout: "", stderr: "" }) : null)]);
    const initRes = await initFailed.initialize("main");
    expect(initRes.ok).toBe(false);
    if (!initRes.ok) {
      expect(initRes.error.code).toBe("GIT_BACKUP_CONFLICT");
      expect(initRes.error.message).toBe("git init refused: exit 128.");
      expect(initRes.error.details).toEqual({ exitCode: 128 });
    }

    const stageFailed = make([
      (req) => (req.args[0] === "add" ? ok({ exitCode: 2, stdout: "", stderr: "fatal: pathspec" }) : null),
    ]);
    const stageRes = await stageFailed.stageManaged();
    expect(stageRes.ok).toBe(false);
    if (!stageRes.ok) {
      expect(stageRes.error.code).toBe("GIT_BACKUP_CONFLICT");
      expect(stageRes.error.message).toBe("git add refused: fatal: pathspec.");
      expect(stageRes.error.details).toEqual({ exitCode: 2 });
    }
    expect(stageFailed.requests[0]?.args).toEqual(["add", "--", ...MANAGED_PATHSPECS]);
  });

  it("distinguishes exit 0, exit 1, and other exits in hasStagedManagedChanges", async () => {
    const clean = make([() => ok({ exitCode: 0, stdout: "", stderr: "" })]);
    expect(await clean.hasStagedManagedChanges()).toEqual(ok(false));

    const dirty = make([() => ok({ exitCode: 1, stdout: "", stderr: "" })]);
    expect(await dirty.hasStagedManagedChanges()).toEqual(ok(true));

    const broken = make([() => ok({ exitCode: 128, stdout: "", stderr: "fatal: index corrupt" })]);
    const res = await broken.hasStagedManagedChanges();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("GIT_BACKUP_CONFLICT");
      expect(res.error.message).toBe("git diff --cached --quiet refused: fatal: index corrupt.");
      expect(res.error.details).toEqual({ exitCode: 128 });
    }
  });

  it("covers all three commit HEAD-lookup outcomes plus commit spawn and exit failures", async () => {
    // 1. commit exits 0 + rev-parse HEAD exits 0 -> ok({ sha })
    const okSha = make([
      (req) => (req.args[0] === "rev-parse" ? ok({ exitCode: 0, stdout: "deadbeef\n", stderr: "" }) : null),
    ]);
    expect(await okSha.commit("backup msg")).toEqual(ok({ sha: "deadbeef" }));
    expect(okSha.requests[0]?.args).toEqual([
      "-c",
      "user.name=Sorage Backup",
      "-c",
      "user.email=sorage@localhost",
      "commit",
      "-m",
      "backup msg",
    ]);

    // 2. commit exits 0 + rev-parse HEAD exits non-zero -> ok({ sha: null })
    const nullSha = make([
      (req) => (req.args[0] === "rev-parse" ? ok({ exitCode: 128, stdout: "", stderr: "fatal: bad revision" }) : null),
    ]);
    expect(await nullSha.commit("backup msg")).toEqual(ok({ sha: null }));

    // 3. commit exits 0 + rev-parse HEAD spawn fails -> err(gitInvocationError)
    const revParseFail = make([
      (req) => (req.args[0] === "rev-parse" ? gitInvocationError("rev-parse HEAD", new Error("ENOENT")) : null),
    ]);
    const revErr = await revParseFail.commit("backup msg");
    expect(revErr.ok).toBe(false);
    if (!revErr.ok) expect(revErr.error.code).toBe("INTERNAL_ERROR");

    // 4. commit spawn fails -> err(gitInvocationError)
    const commitSpawnFail = make([
      (req) => (req.args.includes("commit") ? gitInvocationError("commit", new Error("ETIMEDOUT")) : null),
    ]);
    const spawnErr = await commitSpawnFail.commit("backup msg");
    expect(spawnErr.ok).toBe(false);
    if (!spawnErr.ok) expect(spawnErr.error.code).toBe("INTERNAL_ERROR");

    // 5. commit exits non-zero -> err(gitStateConflict("commit", outcome))
    const commitRefused = make([
      (req) => (req.args.includes("commit") ? ok({ exitCode: 1, stdout: "", stderr: "nothing to commit" }) : null),
    ]);
    const refusedErr = await commitRefused.commit("backup msg");
    expect(refusedErr.ok).toBe(false);
    if (!refusedErr.ok) {
      expect(refusedErr.error.code).toBe("GIT_BACKUP_CONFLICT");
      expect(refusedErr.error.message).toBe("git commit refused: nothing to commit.");
      expect(refusedErr.error.details).toEqual({ exitCode: 1 });
    }
  });

  it("pushes atomically and classifies spawn, auth, and conflict failures identically", async () => {
    const pushed = make([]);
    expect(await pushed.push({ remote: "origin", branch: "main" })).toEqual(ok(undefined));
    expect(pushed.requests[0]?.args).toEqual(["push", "--atomic", "origin", "main"]);

    const spawnFailed = make([() => gitInvocationError("push --atomic origin main", new Error("timed out"))]);
    const spawnRes = await spawnFailed.push({ remote: "origin", branch: "main" });
    expect(spawnRes.ok).toBe(false);
    if (!spawnRes.ok) expect(spawnRes.error.code).toBe("INTERNAL_ERROR");

    const authFailed = make([
      () => ok({ exitCode: 128, stdout: "", stderr: "fatal: could not read Username: terminal prompts disabled" }),
    ]);
    const authRes = await authFailed.push({ remote: "origin", branch: "main" });
    expect(authRes.ok).toBe(false);
    if (!authRes.ok) expect(authRes.error.code).toBe("GIT_AUTH_REQUIRED");

    const conflictFailed = make([
      () => ok({ exitCode: 1, stdout: "", stderr: "! [rejected] main -> main (non-fast-forward)" }),
    ]);
    const conflictRes = await conflictFailed.push({ remote: "origin", branch: "main" });
    expect(conflictRes.ok).toBe(false);
    if (!conflictRes.ok) expect(conflictRes.error.code).toBe("GIT_BACKUP_CONFLICT");
  });
});
