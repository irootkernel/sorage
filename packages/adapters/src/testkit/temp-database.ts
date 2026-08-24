import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeTempHome, type TempHome } from "./temp-home";
import type { SorageSqlite } from "../sqlite/connection";

export interface TempDatabase {
  home: TempHome;
  /** Absolute path of the temporary SQLite database file. */
  databasePath: string;
  /** An open SQLite connection in WAL mode with foreign keys on; closed by cleanup. */
  db: DatabaseSync & SorageSqlite;
  cleanup: () => void;
}

/** Creates a temporary SQLite database file under a temporary home, never the real one. */
export function makeTempDatabase(fileName = "sorage.db"): TempDatabase {
  const home = makeTempHome("sorage-test-db-");
  const databasePath = join(home.home, fileName);
  const db = new DatabaseSync(databasePath) as unknown as DatabaseSync & SorageSqlite;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return {
    home,
    databasePath,
    db,
    cleanup: () => {
      db.close();
      rmSync(databasePath, { force: true });
      rmSync(`${databasePath}-wal`, { force: true });
      rmSync(`${databasePath}-shm`, { force: true });
      home.cleanup();
    },
  };
}
