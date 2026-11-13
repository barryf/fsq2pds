# fsq2pds

Syncs Foursquare/Swarm checkins to an ATProto PDS (bsky.social) as `com.barryfrost.checkin` records. Runs as a Cloudflare Worker (`scheduled` handler, Cron Trigger every 15 min) with state in D1. Migrated from Val Town (shut down); bootstrap scripts still run locally under Deno.

## File layout

| File | Purpose |
|------|---------|
| `worker.ts` | Worker entry point; `scheduled()` calls `run(env)` |
| `lib/run.ts` | The sync loop (cursor, dedup, subrequest budget) |
| `lib/db.ts` | D1 helpers (state, dedup). Schema is in `migrations/` |
| `lib/foursquare.ts` | Foursquare v2 API client |
| `lib/atproto.ts` | Bluesky XRPC client (createSession, uploadBlob, createRecord, getRecord); takes config, never reads env |
| `lib/photos.ts` | Downloads FSQ photos, enforces 1MB size cap |
| `bootstrap/fsq-oauth.ts` | One-time local script to mint an FSQ OAuth token |
| `bootstrap/backfill.ts` | One-time script to backfill historical checkins |
| `bootstrap/backfill-shouts.ts` | One-time script to backfill `comment` onto already-synced records |
| `migrations/0001_init.sql` | D1 schema (`seen_checkins`, `sync_state`) |
| `scripts/valtown-export.ts` | One-time Val Town HTTP val that dumps SQLite state as SQL for D1 import |
| `wrangler.toml` | Worker config: cron, D1 binding, vars, observability |

`lib/` must stay runtime-neutral (plain `fetch`, no `Deno.*`, no env reads). The Worker passes `env` in, and the Deno bootstrap scripts pass `Deno.env` values in. `lib/db.ts` and `lib/run.ts` are Worker-only (D1 types).

## Required env vars (Worker secrets via `wrangler secret put`; plain vars in `wrangler.toml`)

| Var | Purpose |
|-----|---------|
| `FSQ_OAUTH_TOKEN` | Long-lived Foursquare user token (doesn't expire) |
| `FSQ_API_VERSION` | FSQ API date-version param (e.g. `20240101`); a `[vars]` entry |
| `BSKY_HANDLE` | Bluesky handle (e.g. `barryfrost.com`) |
| `BSKY_APP_PASSWORD` | Bluesky app password from bsky.app/settings/app-passwords |
| `BSKY_PDS_URL` | PDS base URL (optional `[vars]` entry; defaults to `https://bsky.social`) |

The bootstrap scripts read the same names from their shell environment.

## Key design decisions

- **Idempotency**: `seen_checkins` table with PRIMARY KEY on `fsq_id`. `INSERT OR IGNORE` means re-running is always safe. Before creating a record the cron calls `getRecord`; if the rkey already exists on the PDS it is adopted into D1, so the loop never gets stuck on an rkey conflict.
- **Subrequest budget**: free Workers allow 50 outbound fetches per invocation. `run()` budgets 45 (FSQ + session + 2 per checkin + 2 per photo) and defers the rest to the next run.
- **Cursor**: `sync_state` table holds `cursor_ts` (unix seconds). Advanced only after successful write.
- **First run**: Sets cursor to NOW and exits immediately. Sync begins next run (prevents accidental historical import).
- **rkey**: Uses FSQ checkin ID directly (hex string, valid AT Proto rkey chars, guaranteed unique).
- **Photos**: Downloaded at FSQ's `1024x1024` size variant. Skipped silently if fetch fails or bytes > 1MB. Checkin record still created.
- **Session**: `getSession(config)` creates a fresh session each call (no cache); called once per cron run. No refresh token logic.
- **Edits/deletes**: Not synced. Records are write-once. Manually delete PDS records if needed. One exception: `bootstrap/backfill-shouts.ts` is a one-time script that patches the `comment` field onto existing records via `putRecord` (with `swapRecord` CAS) when a shout was added to Foursquare after the record was first synced.
- **Backfill**: None for new checkins. Only checkins after first-run timestamp are synced going forward. `bootstrap/backfill.ts` and `bootstrap/backfill-shouts.ts` are one-time scripts for historical data.

## Lexicon

Record collection: `com.barryfrost.checkin`  
Location embedded via `community.lexicon.location.fsq` (struct, not a separate record).  
Record shape: `{ createdAt, location, address?, category?, comment?, photos? }`  
The lexicon doc itself is canonical in the `barryfrost-v7` repo (published there via `npm run publish:lexicon`) — no local copy lives in this repo.

## Tasks

| npm script | Purpose |
|------|---------|
| `npm run dev` | `wrangler dev --test-scheduled`; trigger with `curl localhost:8787/__scheduled` |
| `npm run deploy` | Deploy the Worker |
| `npm run typecheck` | `tsc --noEmit` over `worker.ts` + `lib/` |
| `npm run db:migrate` | Apply D1 migrations to the remote DB |
| `npm run tail` | Stream live Worker logs |

## Deno tasks (local, one-time)

| Task | Purpose |
|------|---------|
| `deno task bootstrap` | Mint an FSQ OAuth token (one-time, local, interactive) |
| `deno task backfill` | Import all historical checkins not yet in the PDS |
| `deno task backfill-shouts` | One-time: add `comment` to already-synced records whose FSQ checkin has a shout that predates this feature. Supports `--dry-run`. |

## Observability

- Workers Logs (`[observability]` enabled) / `npm run tail` show per-checkin outcome: `Synced <fsq_id> (<venue>) → at://...`
- D1 `seen_checkins` is the audit trail; inspect via the Cloudflare dashboard or `wrangler d1 execute fsq2pds --remote --command "…"`.
- `sync_state` holds `cursor_ts` and `launched_at`.
