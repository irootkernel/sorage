// Vitest alias: tests execute through Vitest's runner, which cannot resolve bun:
// schemes; Bun's node:sqlite is the same synchronous SQLite engine. The only
// divergence this bridge translates is the readonly-open option's key: Bun's
// Database(path, { readonly: true }) is Node DatabaseSync(path, { readOnly: true }),
// which the true-readonly admission factory depends on for its write refusal
// and WAL-preserving behavior (SHR-009). Construction without options passes
// through unchanged; no other flags are emulated.
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";

interface NodeOpenOptions {
  readOnly?: boolean;
}

class BridgedDatabase extends NodeDatabaseSync {
  constructor(path: string, options?: { readonly?: boolean } & Record<string, unknown>) {
    if (options !== undefined && options.readonly === true) {
      const { readonly: _ignored, ...rest } = options;
      super(path, { ...(rest as NodeOpenOptions), readOnly: true });
    } else if (options === undefined) {
      super(path);
    } else {
      super(path, options as NodeOpenOptions);
    }
  }
}

export { BridgedDatabase as Database };
