/**
 * Shared CLI self-invocation helpers: under `bun apps/cli/src/main.ts` the
 * interpreter and entry script occupy separate argv slots, whereas the
 * compiled binary is a single executable.
 */
export function selfInvocationScriptArgs(): string[] {
  const entry = process.argv[1];
  return entry?.endsWith("main.ts") ? [entry] : [];
}

export function selfInvocationArgv(argv: string[]): string[] {
  const entry = process.argv[1];
  return entry?.endsWith("main.ts") ? [entry, ...argv] : argv;
}

export function selfInvocation(extraArgs: string[]): { interpreter: string; args: string[] } {
  return { interpreter: process.execPath, args: selfInvocationArgv(extraArgs) };
}
