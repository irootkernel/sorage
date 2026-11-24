import type { Envelope } from "@sorage/core";

export type { Envelope };

/**
 * Async lazy CLI bootstrap: keeps `main.ts` as the entry path (required by
 * `endsWith("main.ts")` self-invocation detection) while dynamically importing
 * internal probes, `mcp`, `daemon serve`, and the Commander program so
 * `exchange renew` and internal probes never evaluate `@sorage/daemon`.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "__health-probe" || argv[0] === "__config-put" || argv[0] === "__port-probe") {
    const { runInternalProbe } = await import("./internal-probes");
    return runInternalProbe(argv);
  }
  // `sorage mcp` runs the long-lived STDIO MCP server of interface section 39;
  // exactly `["mcp"]` is intercepted here while `--help`, `-h`, extra args,
  // and global-option forms fall through to synchronous Commander parsing.
  if (argv.length === 1 && argv[0] === "mcp") {
    const { serveMcp } = await import("./mcp-server");
    serveMcp();
    return -1;
  }
  // `daemon serve` is the sole branch that loads `@sorage/daemon`.
  if (argv[0] === "daemon" && argv[1] === "serve") {
    const { runDaemonServe } = await import("./daemon-serve");
    return runDaemonServe(argv);
  }
  const { runCli } = await import("./program");
  let mcpRequested = false;
  const code = runCli(argv, undefined, undefined, true, {
    onMcpRequested: () => {
      mcpRequested = true;
    },
  });
  // Global-flag `sorage --json mcp` signals via synchronous callback; load and
  // start the MCP server inside `main()`'s own async boundary rather than an
  // unawaited dynamic import inside Commander's synchronous `.action()`.
  if (code === -1 && mcpRequested) {
    const { serveMcp } = await import("./mcp-server");
    serveMcp();
    return -1;
  }
  return code;
}

if (import.meta.main) {
  const code = await main();
  // A negative code means an internal probe, MCP server, or daemon owns the process.
  // Let pending stdout/stderr writes drain, including full Memo bodies piped to a slow reader.
  if (code >= 0) process.exitCode = code;
}
