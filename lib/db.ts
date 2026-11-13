// D1 helpers. Schema lives in migrations/0001_init.sql (applied with
// `wrangler d1 migrations apply`), so there is no ensureSchema() here.

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM sync_state WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row ? String(row.value) : null;
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)")
    .bind(key, value)
    .run();
}

export async function hasCheckin(db: D1Database, fsqId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM seen_checkins WHERE fsq_id = ?")
    .bind(fsqId)
    .first();
  return row !== null;
}

export async function recordCheckin(
  db: D1Database,
  fsqId: string,
  fsqCreatedAt: number,
  pdsAtUri: string,
  pdsCid: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO seen_checkins (fsq_id, fsq_created_at, pds_at_uri, pds_cid)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(fsqId, fsqCreatedAt, pdsAtUri, pdsCid)
    .run();
}
