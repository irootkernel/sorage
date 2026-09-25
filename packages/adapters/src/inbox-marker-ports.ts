import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { InboxMarkerPorts } from "@sorage/core";
import { createNodeHandoffReadPorts, type NodeHandoffCommandPortsOptions } from "./handoff-command-ports";
import { createConfigStore } from "./config-store";
import { createNodeLockProbePorts } from "./lockfile";
import { createHomePaths } from "./home";
import { withInboxMarkerLock } from "./inbox-marker-lock";

/**
 * The Node wiring of the derived inbox marker (HND-026): the flag comes from the
 * effective configuration and each write lands atomically under
 * `<binding>/.sorage/INBOX.md` through a temporary file and a rename, so a crash
 * mid-write never leaves a half-written marker behind.
 */
export function createNodeInboxMarkerPorts(options: NodeHandoffCommandPortsOptions = {}): InboxMarkerPorts {
  const read = createNodeHandoffReadPorts(options);
  const env = options.env ?? process.env;
  const userHome = options.userHome ?? homedir();
  const home = createHomePaths({ SORAGE_HOME: env.SORAGE_HOME }, userHome);
  const config = createConfigStore({ home, lockPorts: createNodeLockProbePorts(), userHome });
  const effective = config.read();
  const enabled = effective.ok && effective.value !== null ? effective.value.config.handoff.inboxMarker : false;
  return {
    ...read,
    marker: {
      enabled,
      withLock(body) {
        return withInboxMarkerLock(home, body);
      },
      writes: {
        writeInboxMarker(bindingDirectory: string, content: string) {
          const directory = resolve(bindingDirectory, ".sorage");
          try {
            mkdirSync(directory, { recursive: true });
            const temporary = join(directory, `.INBOX.md.${process.pid}.tmp`);
            writeFileSync(temporary, content, "utf8");
            renameSync(temporary, join(directory, "INBOX.md"));
            return { ok: true as const, value: undefined };
          } catch (error) {
            try {
              rmSync(join(directory, `.INBOX.md.${process.pid}.tmp`), { force: true });
            } catch {
              // The marker is derived; leaving a stale temporary behind is harmless.
            }
            return {
              ok: false as const,
              error: {
                code: "INTERNAL_ERROR" as const,
                message: `the inbox marker under ${bindingDirectory} could not be written: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            };
          }
        },
        removeInboxMarker(bindingDirectory: string) {
          const marker = join(resolve(bindingDirectory, ".sorage"), "INBOX.md");
          try {
            if (!existsSync(marker)) return { ok: true as const, value: undefined };
            const content = readFileSync(marker, "utf8");
            if (!content.startsWith("# Inbox\n\nDerived by Sorage from this Project's current inbox;")) {
              return {
                ok: false as const,
                error: { code: "INTERNAL_ERROR" as const, message: "the old inbox marker is not Sorage-generated" },
              };
            }
            rmSync(marker);
            return { ok: true as const, value: undefined };
          } catch (error) {
            return {
              ok: false as const,
              error: {
                code: "INTERNAL_ERROR" as const,
                message: `the old inbox marker could not be removed: ${error instanceof Error ? error.message : String(error)}`,
              },
            };
          }
        },
      },
    },
  };
}
