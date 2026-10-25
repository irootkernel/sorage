import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expands a leading `~` to the user's home directory, the CLI's own rule for
 * path options. Shared with the MCP adapter, whose workspace-confinement
 * check must expand a file argument exactly as the CLI it spawns would.
 */
export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
