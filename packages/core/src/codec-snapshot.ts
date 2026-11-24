import type { SnapshotFile } from "./backup-snapshot";
import { type AppError, ok, type Result } from "./errors";
import type { ExchangeSnapshotManifest } from "./memo-snapshot";
import { canonicalJson } from "./primitives/json";

/**
 * Per-run shared content inventory passed between domain codecs during a single
 * V5 snapshot build. Created fresh per invocation so no state ever leaks across
 * exports (ADR-0036).
 */
export interface SnapshotCodecContext {
  readonly carriedContent: Map<string, Uint8Array>;
  readonly referencedContent: Set<string>;
  readonly memoDigests: Record<string, string>;
  readonly contentDigests: Record<string, string>;
}

/**
 * Single-pass domain codec contract for format-5 snapshot export (TASK-165).
 * Each domain owns its validation, deterministic file emission, manifest count
 * contribution, and optional manifest digest contribution.
 */
export interface SnapshotDomainCodec<T> {
  readonly id: string;
  readonly validationOrder?: number;
  readonly placement?: "before-manifest" | "after-manifest";
  validate(data: T, context: SnapshotCodecContext): Result<void, AppError>;
  files(data: T, context: SnapshotCodecContext): Result<SnapshotFile[], AppError>;
  counts(data: T): Partial<ExchangeSnapshotManifest["counts"]>;
  digests?(
    data: T,
    context: SnapshotCodecContext,
  ): Partial<Pick<ExchangeSnapshotManifest, "memoDigests" | "contentDigests">>;
}

/**
 * Executes a format-5 snapshot export in one pass over the ordered domain
 * codecs: validates in declared precedence order, emits every domain's files
 * directly, aggregates manifest counts and digests, and builds `manifest.json`
 * once.
 */
export function runV5SnapshotCodecs<T>(
  data: T,
  codecs: readonly SnapshotDomainCodec<T>[],
): Result<{ files: SnapshotFile[]; manifest: ExchangeSnapshotManifest }, AppError> {
  const context: SnapshotCodecContext = {
    carriedContent: new Map(),
    referencedContent: new Set(),
    memoDigests: {},
    contentDigests: {},
  };
  const validationOrder = [...codecs].sort((a, b) => (a.validationOrder ?? 0) - (b.validationOrder ?? 0));
  for (const codec of validationOrder) {
    const valid = codec.validate(data, context);
    if (!valid.ok) return valid;
  }

  const beforeManifest: SnapshotFile[] = [];
  const afterManifest: SnapshotFile[] = [];
  const counts: Partial<ExchangeSnapshotManifest["counts"]> = {};
  const memoDigests: Record<string, string> = {};
  const contentDigests: Record<string, string> = {};

  for (const codec of codecs) {
    const emitted = codec.files(data, context);
    if (!emitted.ok) return emitted;
    if (codec.placement === "after-manifest") {
      afterManifest.push(...emitted.value);
    } else {
      beforeManifest.push(...emitted.value);
    }
    Object.assign(counts, codec.counts(data));
    const digests = codec.digests?.(data, context);
    if (digests?.memoDigests) Object.assign(memoDigests, digests.memoDigests);
    if (digests?.contentDigests) Object.assign(contentDigests, digests.contentDigests);
  }

  const manifest: ExchangeSnapshotManifest = {
    formatVersion: 5,
    counts: {
      projects: counts.projects ?? 0,
      handoffs: counts.handoffs ?? 0,
      events: counts.events ?? 0,
      artifacts: counts.artifacts ?? 0,
      memos: counts.memos ?? 0,
      channels: counts.channels ?? 0,
      exchanges: counts.exchanges ?? 0,
    },
    memoDigests,
    contentDigests,
  };

  return ok({
    files: [...beforeManifest, { path: "manifest.json", content: canonicalJson(manifest) }, ...afterManifest],
    manifest,
  });
}
