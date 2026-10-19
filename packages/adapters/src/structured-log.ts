import type { Configuration } from "@sorage/core";
import { join } from "node:path";
import type { HomePaths } from "./home";
import { createLogger, type LogRecord } from "./logging";

/** Metadata-only diagnostics use the resolved installation and its normal logging policy. */
export function appendStructuredLog(record: LogRecord, home: HomePaths, config: Configuration["logging"]): void {
  try {
    createLogger({ file: join(home.logsDir, "sorage.log"), ...config, homePath: home.home }).log(record);
  } catch {
    // Diagnostics cannot change a committed outcome or its recovery behavior.
  }
}
