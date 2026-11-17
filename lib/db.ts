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

/**
 * Returns which of the given FSQ checkin IDs are already in seen_checkins,
 * in a single query. Callers pass at most one FSQ page (50 IDs), well under
 * D1's 100-bound-parameter limit.
 */
export async function seenCheckinIds(db: D1Database, fsqIds: string[]): Promise<Set<string>> {
  if (fsqIds.length === 0) return new Set();
  const placeholders = fsqIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT fsq_id FROM seen_checkins WHERE fsq_id IN (${placeholders})`)
    .bind(...fsqIds)
    .all<{ fsq_id: string }>();
  return new Set(results.map((r) => r.fsq_id));
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
