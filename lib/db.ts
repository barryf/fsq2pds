import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

export async function ensureSchema(): Promise<void> {
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS seen_checkins (
      fsq_id         TEXT PRIMARY KEY,
      fsq_created_at INTEGER NOT NULL,
      pds_at_uri     TEXT NOT NULL,
      pds_cid        TEXT NOT NULL,
      processed_at   INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_seen_created ON seen_checkins(fsq_created_at)`,
  );
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

export async function getState(key: string): Promise<string | null> {
  const result = await sqlite.execute({
    sql: "SELECT value FROM sync_state WHERE key = ?",
    args: [key],
  });
  return result.rows.length > 0 ? String(result.rows[0].value) : null;
}

export async function setState(key: string, value: string): Promise<void> {
  await sqlite.execute({
    sql: "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)",
    args: [key, value],
  });
}

export async function hasCheckin(fsqId: string): Promise<boolean> {
  const result = await sqlite.execute({
    sql: "SELECT 1 FROM seen_checkins WHERE fsq_id = ?",
    args: [fsqId],
  });
  return result.rows.length > 0;
}

export async function recordCheckin(
  fsqId: string,
  fsqCreatedAt: number,
  pdsAtUri: string,
  pdsCid: string,
): Promise<void> {
  await sqlite.execute({
    sql: `INSERT OR IGNORE INTO seen_checkins (fsq_id, fsq_created_at, pds_at_uri, pds_cid)
          VALUES (?, ?, ?, ?)`,
    args: [fsqId, fsqCreatedAt, pdsAtUri, pdsCid],
  });
}
