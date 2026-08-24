import { createHash } from "node:crypto";

/**
 * Deterministic 10,000-Handoff seed for scale and pagination checks (NFR-004, HND scale).
 * The domain tables land in TASK-027; until then the seed produces stable row-shaped
 * records with UUIDs, timestamps, and content digests derived from the row index, so
 * two generations of the same index are byte-identical.
 */
export interface SeedHandoffRow {
  handoffId: string;
  senderSlug: string;
  recipientSlug: string;
  title: string;
  createdAt: string;
  contentSha256: string;
}

function stableUuid(index: number): string {
  const digest = createHash("sha256").update(`sorage-seed-handoff-${index}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

export function generateHandoffSeed(count = 10_000): SeedHandoffRow[] {
  const rows: SeedHandoffRow[] = [];
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  for (let index = 0; index < count; index++) {
    const sender = `sender-${(index % 40).toString().padStart(2, "0")}`;
    const recipient = `recipient-${(index % 25).toString().padStart(2, "0")}`;
    rows.push({
      handoffId: stableUuid(index),
      senderSlug: sender,
      recipientSlug: recipient,
      title: `Seed handoff ${index}`,
      createdAt: new Date(baseMs + index * 60_000).toISOString(),
      contentSha256: createHash("sha256").update(`seed-content-${index}`).digest("hex"),
    });
  }
  return rows;
}
