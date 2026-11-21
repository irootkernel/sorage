import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { isMemoUuid } from "@sorage/core";
import { fsyncDirectory } from "./intent-log";
import { managedDirectory, managedFile, managedPath, openManagedFile } from "./managed-paths";

interface StageOwner {
  exchangeId: string;
  pid: number;
  realm: string | null;
}

let knownRealm: string | null | undefined;

function localProcessRealm(): string | null {
  if (knownRealm !== undefined) return knownRealm;
  knownRealm = null;
  try {
    if (process.platform === "linux") {
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (isMemoUuid(boot)) knownRealm = `${hostname()}:${boot}:${readlinkSync("/proc/self/ns/pid")}`;
    } else if (process.platform === "darwin") {
      const boot = spawnSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 1_000 });
      const stamp = boot.stdout?.match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/);
      if (boot.status === 0 && stamp) knownRealm = `${hostname()}:${stamp[1]}:${stamp[2]}`;
    }
  } catch {
    // An unavailable realm makes subsequent liveness observations inconclusive.
  }
  return knownRealm;
}

export function recordExchangeStageOwner(root: string, id: string, exchangeId: string): void {
  const key = managedPath(root, `owners/${id}`, true, 0o700);
  const fd = openSync(key, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const owner: StageOwner = { exchangeId, pid: process.pid, realm: localProcessRealm() };
    writeFileSync(fd, JSON.stringify(owner), "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(key));
  fsyncDirectory(root);
}

export function removeExchangeStageOwner(root: string, id: string): void {
  const owner = managedFile(root, `owners/${id}`);
  if (owner.stat === undefined) return;
  try {
    unlinkSync(owner.path);
    fsyncDirectory(dirname(owner.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Legacy staging and any marker without a definitive local death proof remain untouched. */
export function reclaimExchangeStages(root: string, exchangeId: string, unowned: (id: string) => boolean): number {
  const directory = managedDirectory(root, "owners");
  const realm = localProcessRealm();
  if (directory === undefined || realm === null) return 0;
  let reclaimed = 0;
  for (const id of readdirSync(directory)) {
    if (!isMemoUuid(id)) continue;
    try {
      const marker = managedFile(root, `owners/${id}`);
      if (marker.stat === undefined || marker.stat.size > 4096) continue;
      const fd = openManagedFile(root, `owners/${id}`);
      let owner: StageOwner;
      try {
        owner = JSON.parse(readFileSync(fd, "utf8")) as StageOwner;
      } finally {
        closeSync(fd);
      }
      if (
        !owner ||
        Object.keys(owner).length !== 3 ||
        owner.exchangeId !== exchangeId ||
        owner.realm !== realm ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0
      )
        continue;
      try {
        process.kill(owner.pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      if (!unowned(id)) continue;
      const stage = managedFile(root, `staging/${id}`);
      if (stage.stat !== undefined) {
        unlinkSync(stage.path);
        fsyncDirectory(dirname(stage.path));
        reclaimed++;
      }
      removeExchangeStageOwner(root, id);
    } catch {
      // A malformed or racing path is no authorization to remove its bytes.
    }
  }
  return reclaimed;
}
