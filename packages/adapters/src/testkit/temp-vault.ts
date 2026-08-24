import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome, type TempHome } from "./temp-home";

export interface TempVault {
  home: TempHome;
  /** The vault root directory with the canonical artifacts/ and staging/ subdirectories. */
  vaultPath: string;
  artifactsPath: string;
  stagingPath: string;
  cleanup: () => void;
}

/** Creates a temporary Vault layout: `<home>/vault` with `artifacts/` and `staging/`. */
export function makeTempVault(prefix?: string): TempVault {
  const home = makeTempHome(prefix);
  const vaultPath = join(home.home, "vault");
  const artifactsPath = join(vaultPath, "artifacts");
  const stagingPath = join(vaultPath, "staging");
  mkdirSync(artifactsPath, { recursive: true });
  mkdirSync(stagingPath, { recursive: true });
  return {
    home,
    vaultPath,
    artifactsPath,
    stagingPath,
    cleanup: () => {
      rmSync(vaultPath, { recursive: true, force: true });
      home.cleanup();
    },
  };
}
