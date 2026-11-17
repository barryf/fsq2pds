/**
 * One-time Val Town export of fsq2pds state, for importing into Cloudflare D1.
 * Follows https://docs.val.town/migration/cloudflare/migrate-sqlite.
 *
 * Must be created BEFORE Val Town code goes read-only on 2026-12-10.
 *
 * 1. Add this file to the fsq2pds val as an HTTP file. It must live in the
 *    same val, because std/sqlite/main.ts is scoped to the val it runs in.
 * 2. Set a Val Town env var SQLITE_EXPORT_TOKEN to a random secret, e.g. the
 *    output of `openssl rand -hex 32`.
 * 3. Pause the fsq2pds cron so the state doesn't change mid-export.
 * 4. Download, keeping the token out of your shell history and process list:
 *      printf 'Authorization: Bearer %s' "$SQLITE_EXPORT_TOKEN" \
 *        | curl -fsS -H @- -o valtown-export.sql https://<your-endpoint>
 *    Check the file ends with "-- Export complete" before importing.
 * 5. npx wrangler d1 execute fsq2pds --remote --file=valtown-export.sql
 * 6. Delete this HTTP file and the SQLITE_EXPORT_TOKEN env var.
 *
 * Not part of the Worker; Val Town-only (Deno, esm.town std/sqlite).
 */
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return `'${String(v).replaceAll("'", "''")}'`;
}

export default async function (req: Request): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  const token = Deno.env.get("SQLITE_EXPORT_TOKEN");
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
    return new Response("Unauthorized", { status: 401, headers });
  }
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers });
  }

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

  lines.push(`-- Rows: sync_state=${state.rows.length} seen_checkins=${seen.rows.length}`);
  lines.push("-- Export complete");
  return new Response(lines.join("\n") + "\n", {
    headers: { ...headers, "content-type": "application/sql; charset=utf-8" },
  });
}
