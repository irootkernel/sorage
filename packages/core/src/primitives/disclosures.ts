/** Post-commit completion warning sink (SHR-015 category (i)); throwing sinks never change outcomes. */
export interface CompletionWarningSink {
  completionWarning?(text: string): void;
}

/** Large-content Git-history disclosure seam (SHR-011) with optional post-commit completion warning sink. */
export interface LargeContentDisclosurePorts extends CompletionWarningSink {
  backupEnabled: boolean;
  thresholdBytes: number;
  largeContent(sizeBytes: number, thresholdBytes: number): void;
}

/** Emits one post-commit completion warning; a throwing sink never changes the committed outcome. */
export function emitCompletionWarning(sink: CompletionWarningSink | undefined, text: string): void {
  try {
    sink?.completionWarning?.(text);
  } catch {
    // A diagnostic sink failure never changes the committed outcome.
  }
}

/** Emits one large-content Git-history disclosure when backup is enabled and the size exceeds the threshold. */
export function discloseLargeContent(ports: LargeContentDisclosurePorts | undefined, sizeBytes: number): void {
  if (ports === undefined || !ports.backupEnabled || !(sizeBytes > ports.thresholdBytes)) return;
  try {
    ports.largeContent(sizeBytes, ports.thresholdBytes);
  } catch {
    // A diagnostic sink failure never changes the committed outcome.
  }
}
