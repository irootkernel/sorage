import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { appError, err, ok } from "@sorage/core";
import type { ConfigCommandPorts } from "@sorage/core";
import { createConfigStore, type ConfigStoreFs } from "./config-store";
import { createHomePaths, type HomeEnvironment } from "./home";
import { createNodeLockProbePorts, type LockClock } from "./lockfile";

/**
 * The production wiring of the configuration commands: the shared atomic store plus
 * the user's editor launched with argument-array execution, never a shell string
 * (SEC-004, SEC-005). The same store serves init, so every writer shares one
 * Config Service (CFG-016).
 */
export interface NodeConfigCommandPortsOptions {
  env?: (HomeEnvironment & { EDITOR?: string | undefined }) | undefined;
  userHome?: string | undefined;
  clock?: LockClock | undefined;
  fs?: ConfigStoreFs | undefined;
}

export function createNodeConfigCommandPorts(options: NodeConfigCommandPortsOptions = {}): ConfigCommandPorts {
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const store = createConfigStore({
    home,
    lockPorts: createNodeLockProbePorts(options.clock),
    userHome,
    fs: options.fs,
  });
  return {
    store,
    configFile: home.configFile,
    userHome,
    sorageHome: home.home,
    openEditor(path) {
      const editor = env.EDITOR?.trim() !== "" ? (env.EDITOR as string) : "vi";
      const result = spawnSync(editor, [path], { stdio: "inherit" });
      if (result.error !== undefined) {
        return err(appError("INTERNAL_ERROR", `the editor '${editor}' could not be started: ${String(result.error)}`));
      }
      if (result.status !== 0) {
        return err(appError("INTERNAL_ERROR", `the editor '${editor}' exited with status ${result.status}`));
      }
      return ok(undefined);
    },
  };
}
