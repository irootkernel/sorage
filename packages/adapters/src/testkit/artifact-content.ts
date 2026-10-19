import { UuidGenerator } from "@sorage/core";
import { createSqliteContentStore, sqliteContentReferences } from "../content-store";
import type { SqliteEventLedger } from "../events";
import type { ArtifactContentBindings } from "../handoffs";
import type { SorageSqlite } from "../sqlite/connection";

/**
 * Real shared-store `ArtifactContentBindings` for schema-9 integration fixtures
 * (SHR-004): the same composition the production Handoff command ports use —
 * the SQLite content store's in-transaction primitives, the reference-proof
 * removal over the default SQL reference provider, and the shared UUID
 * generator — over a caller-initialized temporary Vault. Never a stub: a
 * fixture that only needs the constructor shape still gets the real store.
 */
export interface ArtifactContentFixtureOptions {
  db: SorageSqlite;
  ledger?: SqliteEventLedger;
  vaultPath: string;
  installationId: string;
  now?: () => Date;
}

export function makeArtifactContentBindings(options: ArtifactContentFixtureOptions): ArtifactContentBindings {
  const store = createSqliteContentStore({
    db: options.db,
    vaultPath: options.vaultPath,
    installationId: options.installationId,
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
  });
  const references = sqliteContentReferences(options.db);
  const ids = new UuidGenerator();
  const now = options.now ?? (() => new Date());
  return {
    insertArtifactContentRecord: (record) => store.insertContentRecord(record),
    removeArtifactContentRecord: (recordId) => store.removeContentRecordInTx(recordId, { references, now: now() }),
    nextContentRecordId: () => ids.next(),
  };
}
