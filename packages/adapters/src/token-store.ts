import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  isWellFormedToken,
  tokensEqual,
  WEB_SECRET_TTL_MS,
  type ApiTokenStorePort,
  type TokenEntropyPort,
  type WebSecretPort,
} from "@sorage/core";
import type { Clock } from "@sorage/core";

/**
 * The file-backed API token and one-time web secret stores (SEC-002, SEC-019,
 * SEC-020): the Installation token lives at `<stateDir>/api-token` with owner-only
 * permissions and is replaced atomically on rotation, and the pending browser secret
 * lives at `<stateDir>/web-secret` as a single single-use record whose file deletion
 * is the use-once guarantee shared between the `web` CLI process and the daemon.
 */

const TOKEN_MODE = 0o600;

function atomicWrite(path: string, contents: string): void {
  const temporary = join(dirname(path), `.${basenameSafe(path)}.tmp-${process.pid}`);
  writeFileSync(temporary, contents, { encoding: "utf8", mode: TOKEN_MODE });
  chmodSync(temporary, TOKEN_MODE);
  renameSync(temporary, path);
}

function basenameSafe(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? "token";
}

/** The production entropy source: 32 random bytes from the platform CSPRNG. */
export function createNodeTokenEntropy(byteCount = 32): TokenEntropyPort {
  return {
    next: () => randomBytes(byteCount).toString("base64url"),
  };
}

export interface NodeApiTokenStoreOptions {
  stateDir: string;
  entropy?: TokenEntropyPort;
}

/** The Installation API token file (SEC-020). */
export function createNodeApiTokenStore(options: NodeApiTokenStoreOptions): ApiTokenStorePort {
  const path = join(options.stateDir, "api-token");
  const entropy = options.entropy ?? createNodeTokenEntropy();
  const write = (token: string): void => {
    mkdirSync(options.stateDir, { recursive: true });
    atomicWrite(path, token);
  };
  return {
    path,
    read: () => {
      try {
        const value = readFileSync(path, "utf8").trim();
        return value === "" ? null : value;
      } catch {
        return null;
      }
    },
    ensure: () => {
      const current = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
      if (current !== "" && isWellFormedToken(current)) return { ok: true as const, value: { created: false } };
      write(entropy.next());
      return { ok: true as const, value: { created: true } };
    },
    rotate: () => {
      write(entropy.next());
      return { ok: true as const, value: { rotated: true as const } };
    },
  };
}

interface WebSecretRecord {
  secret: string;
  expiresAt: string;
}

export interface NodeWebSecretStoreOptions {
  stateDir: string;
  clock: Clock;
  entropy?: TokenEntropyPort;
}

/** The single-use browser secret file behind `sorage web` (SEC-019, RUN-012). */
export function createNodeWebSecretStore(options: NodeWebSecretStoreOptions): WebSecretPort {
  const path = join(options.stateDir, "web-secret");
  const entropy = options.entropy ?? createNodeTokenEntropy();
  return {
    issue: () => {
      mkdirSync(options.stateDir, { recursive: true });
      const secret = entropy.next();
      const expiresAt = new Date(options.clock.now().getTime() + WEB_SECRET_TTL_MS).toISOString();
      atomicWrite(path, `${JSON.stringify({ secret, expiresAt } satisfies WebSecretRecord)}\n`);
      return { ok: true as const, value: { secret, expiresAt } };
    },
    consume: (candidate: string) => {
      let record: WebSecretRecord;
      try {
        record = JSON.parse(readFileSync(path, "utf8")) as WebSecretRecord;
      } catch {
        return false;
      }
      // The read is the use: a matching or expired record is deleted before the
      // comparison result is known, so a replay can never succeed twice.
      try {
        unlinkSync(path);
      } catch {
        // Another consumer won the race; the record is gone either way.
      }
      const expiresAt = Date.parse(record.expiresAt);
      if (Number.isNaN(expiresAt) || options.clock.now().getTime() > expiresAt) return false;
      return tokensEqual(record.secret, candidate);
    },
  };
}

/** The stat mode of the token file, for the permission assertions of SEC-020. */
export function tokenFileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}
