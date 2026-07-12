# fsq2pds

Syncs Foursquare/Swarm checkins to an ATProto PDS (bsky.social) as `com.barryfrost.checkin` records. Runs as a Val.Town cron val (Deno) every 15 minutes — the free-tier cron minimum.

## File layout

| File | Purpose |
|------|---------|
| `cron.ts` | Entry point; exported default function is the cron handler |
| `lib/db.ts` | Val.Town SQLite helpers (schema, state, dedup) |
| `lib/foursquare.ts` | Foursquare v2 API client |
| `lib/atproto.ts` | Bluesky XRPC client (createSession, uploadBlob, createRecord) |
| `lib/photos.ts` | Downloads FSQ photos, enforces 1MB size cap |
| `bootstrap/fsq-oauth.ts` | One-time local script to mint an FSQ OAuth token |
| `bootstrap/backfill.ts` | One-time script to backfill historical checkins |
| `bootstrap/backfill-shouts.ts` | One-time script to backfill `comment` onto already-synced records |

## Required env vars (Val.Town secrets)

| Var | Purpose |
|-----|---------|
| `FSQ_OAUTH_TOKEN` | Long-lived Foursquare user token (doesn't expire) |
| `FSQ_API_VERSION` | FSQ API date-version param (e.g. `20240101`) |
| `BSKY_HANDLE` | Bluesky handle (e.g. `barryfrost.com`) |
| `BSKY_APP_PASSWORD` | Bluesky app password from bsky.app/settings/app-passwords |
| `BSKY_PDS_URL` | PDS base URL (optional; defaults to `https://bsky.social`) |

## Key design decisions

- **Idempotency**: `seen_checkins` table with PRIMARY KEY on `fsq_id`. `INSERT OR IGNORE` means re-running is always safe.
- **Cursor**: `sync_state` table holds `cursor_ts` (unix seconds). Advanced only after successful write.
- **First run**: Sets cursor to NOW and exits immediately. Sync begins next run (prevents accidental historical import).
- **rkey**: Uses FSQ checkin ID directly (hex string, valid AT Proto rkey chars, guaranteed unique).
- **Photos**: Downloaded at FSQ's `1024x1024` size variant. Skipped silently if fetch fails or bytes > 1MB. Checkin record still created.
- **Session**: `createSession` called at the start of each cron run. No refresh token logic.
- **Edits/deletes**: Not synced. Records are write-once. Manually delete PDS records if needed. One exception: `bootstrap/backfill-shouts.ts` is a one-time script that patches the `comment` field onto existing records via `putRecord` (with `swapRecord` CAS) when a shout was added to Foursquare after the record was first synced.
- **Backfill**: None for new checkins. Only checkins after first-run timestamp are synced going forward. `bootstrap/backfill.ts` and `bootstrap/backfill-shouts.ts` are one-time scripts for historical data.

## Lexicon

Record collection: `com.barryfrost.checkin`  
Location embedded via `community.lexicon.location.fsq` (struct, not a separate record).  
Record shape: `{ createdAt, location, address?, category?, comment?, photos? }`  
The lexicon doc itself is canonical in the `barryfrost-v7` repo (published there via `npm run publish:lexicon`) — no local copy lives in this repo.

## Deno tasks

| Task | Purpose |
|------|---------|
| `deno task bootstrap` | Mint an FSQ OAuth token (one-time, local, interactive) |
| `deno task backfill` | Import all historical checkins not yet in the PDS |
| `deno task backfill-shouts` | One-time: add `comment` to already-synced records whose FSQ checkin has a shout that predates this feature. Supports `--dry-run`. |

## Observability

- Val.Town logs show per-checkin outcome: `Synced <fsq_id> (<venue>) → at://...`
- SQLite `seen_checkins` is the audit trail; inspect via Val.Town admin panel.
- `sync_state` holds `cursor_ts` and `launched_at`.
