import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempHome {
  /** The temporary SORAGE_HOME path; never the developer's real ~/.sorage. */
  home: string;
  /** Removes the temporary tree; safe to call more than once. */
  cleanup: () => void;
}

/**
 * Creates an isolated temporary SORAGE_HOME for one test.
 * Every test and manual check must point SORAGE_HOME at a directory like this and
 * never at the developer's real home (AGENTS.md safety rules).
 */
export function makeTempHome(prefix = "sorage-test-home-"): TempHome {
  const home = mkdtempSync(join(tmpdir(), prefix));
  return {
    home,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Runs `body` with a temporary home that is always removed afterwards. */
export async function withTempHome<T>(body: (home: string) => Promise<T> | T, prefix?: string): Promise<T> {
  const temp = makeTempHome(prefix);
  const previous = process.env.SORAGE_HOME;
  process.env.SORAGE_HOME = temp.home;
  try {
    return await body(temp.home);
  } finally {
    if (previous === undefined) delete process.env.SORAGE_HOME;
    else process.env.SORAGE_HOME = previous;
    temp.cleanup();
  }
}
