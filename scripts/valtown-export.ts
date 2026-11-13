/**
 * One-time Val Town export of fsq2pds state, for importing into Cloudflare D1.
 *
 * Paste into a NEW HTTP val in the same Val Town account as the fsq2pds cron
 * val. Val Town SQLite is per-val, so if your project's database is scoped to
 * the fsq2pds val, add this file to that project instead (e.g. as
 * `export.ts`, HTTP trigger) so it reads the same database.
 *
 * Open the val's URL and save the response as valtown-export.sql, then:
 *   npx wrangler d1 execute fsq2pds --remote --file=valtown-export.sql
 *
 * Delete the HTTP val afterwards. The data isn't secret (checkin IDs and
 * at:// URIs are public on the PDS), but there's no reason to leave it up.
 *
 * Not part of the Worker; Val Town-only (uses esm.town std/sqlite).
 */
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
}

export default async function (_req: Request): Promise<Response> {
  const lines: string[] = [
    `-- fsq2pds Val Town export, ${new Date().toISOString()}`,
  ];

  const state = await sqlite.execute("SELECT key, value FROM sync_state ORDER BY key");
  for (const r of state.rows) {
    lines.push(
      `INSERT OR REPLACE INTO sync_state (key, value) VALUES (${lit(r.key ?? r[0])}, ${lit(r.value ?? r[1])});`,
    );
  }

  const seen = await sqlite.execute(
    "SELECT fsq_id, fsq_created_at, pds_at_uri, pds_cid, processed_at FROM seen_checkins ORDER BY fsq_created_at",
  );
  for (const r of seen.rows) {
    const vals = ["fsq_id", "fsq_created_at", "pds_at_uri", "pds_cid", "processed_at"]
      .map((k, i) => lit(r[k] ?? r[i]));
    lines.push(
      `INSERT OR IGNORE INTO seen_checkins (fsq_id, fsq_created_at, pds_at_uri, pds_cid, processed_at) VALUES (${vals.join(", ")});`,
    );
  }

  lines.push(`-- ${state.rows.length} sync_state row(s), ${seen.rows.length} seen_checkins row(s)`);
  return new Response(lines.join("\n") + "\n", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
