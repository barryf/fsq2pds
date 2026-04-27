# fsq2pds — Foursquare/Swarm checkins → ATProto PDS

## Context

You want a personal pipeline that mirrors your Swarm checkins into your Bluesky-hosted PDS as ATProto records, so your website at barryfrost.com can read them via the AT Proto API. The pipeline runs entirely on Val.Town's free tier (Deno) on a 15-minute cron — which happens to be the free-tier cron floor, so this is the right cadence regardless. State lives in Val.Town SQLite (per-val 10MB DB) for robust idempotency. Records use the `community.lexicon.location.fsq` struct (embedded, not referenced — that schema is an object meant to live inside other records) wrapped in a bespoke `com.barryfrost.checkin` record.

## Decisions locked in (from clarifying Q&A)

- **Source**: Foursquare/Swarm v2 API via OAuth2 user token (you have a dev account, will mint a token via one-time bootstrap).
- **Polling, not Push API**: 15-min cron is fine for a website backfill latency; Push API adds a public webhook + signature verification. Skip unless we need sub-15-min freshness later.
- **Backfill**: none. First run records "launch timestamp"; only checkins after that get synced.
- **State**: Val.Town SQLite, val-scoped (`std/sqlite`). UNIQUE PK on FSQ checkin id is the idempotency primitive.
- **Record contents**: `createdAt` + embedded `community.lexicon.location.fsq` + photos (uploaded as PDS blobs). No shout text, no categories. (Easy to add later — record schema is yours.)
- **Edits/deletes in Swarm**: ignored. Records are write-once. If you delete a Swarm checkin you'll manually delete the PDS record.
- **Lexicon NSID**: `com.barryfrost.checkin`.
- **PDS**: `bsky.social`, app-password auth.

## Architecture

```
┌─────────────────────────┐     every 15min      ┌────────────────────┐
│ Val.Town cron val       │ ───────────────────▶ │ Foursquare v2 API  │
│   cron.ts               │  GET users/self/      │ (oauth_token)      │
│                         │  checkins?after=...  └────────────────────┘
│                         │
│   ┌──────────────┐      │  per new checkin
│   │ SQLite       │ ◀──▶ │   1. fetch photo bytes (if any)
│   │ seen_checkins│      │   2. createSession on bsky.social
│   │ sync_state   │      │   3. uploadBlob × N photos
│   └──────────────┘      │   4. createRecord (com.barryfrost.checkin)
│                         │   5. insert seen_checkins row
│                         │
│                         │ ───────────────────▶ ┌────────────────────┐
└─────────────────────────┘                      │ bsky.social PDS    │
                                                 │ XRPC               │
                                                 └────────────────────┘
```

## File layout (Val.Town project, edited locally via `vt`)

```
fsq2pds/
├── CLAUDE.md                          # session context for future Claude runs
├── README.md                          # setup steps (token mint, env vars)
├── deno.json                          # imports + tasks
├── cron.ts                            # main cron entry point
├── lib/
│   ├── foursquare.ts                  # FSQ v2 client (checkins, photo URL build)
│   ├── atproto.ts                     # bsky XRPC: createSession, uploadBlob, createRecord
│   ├── db.ts                          # SQLite schema + helpers
│   └── photos.ts                      # fetch photo bytes from FSQ photo prefix/suffix
├── lexicons/
│   └── com.barryfrost.checkin.json    # lexicon doc (publishable to PDS later)
└── bootstrap/
    └── fsq-oauth.ts                   # one-time local script to mint FSQ token
```

## Lexicon: `com.barryfrost.checkin`

```json
{
  "lexicon": 1,
  "id": "com.barryfrost.checkin",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["createdAt", "location"],
        "properties": {
          "createdAt": { "type": "string", "format": "datetime" },
          "location": {
            "type": "ref",
            "ref": "community.lexicon.location.fsq"
          },
          "photos": {
            "type": "array",
            "maxLength": 8,
            "items": {
              "type": "object",
              "required": ["image"],
              "properties": {
                "image": {
                  "type": "blob",
                  "accept": ["image/jpeg", "image/png", "image/webp"],
                  "maxSize": 1000000
                },
                "alt": { "type": "string", "maxLength": 1000 }
              }
            }
          }
        }
      }
    }
  }
}
```

Embedded location object inside each record looks like:
```json
{
  "$type": "community.lexicon.location.fsq",
  "fsq_place_id": "<id>",
  "name": "Blue Bottle Coffee",
  "latitude": "37.776",
  "longitude": "-122.418"
}
```

Record `rkey` = TID derived from FSQ `createdAt` (gives chronological ordering for free).

## SQLite schema

```sql
CREATE TABLE IF NOT EXISTS seen_checkins (
  fsq_id          TEXT PRIMARY KEY,
  fsq_created_at  INTEGER NOT NULL,           -- unix seconds
  pds_at_uri      TEXT NOT NULL,
  pds_cid         TEXT NOT NULL,
  processed_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_seen_created ON seen_checkins(fsq_created_at);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 'cursor_ts'  → unix sec; advance only after successful run
-- 'launched_at' → unix sec; written once on first ever run, used as initial cursor
```

The PRIMARY KEY on `fsq_id` is the durability anchor: even if FSQ returns a checkin twice, or a run dies after PDS write but before cursor advance, the `INSERT OR IGNORE` keeps things consistent.

## Cron flow (cron.ts, runs every 15 min)

1. Open SQLite, ensure schema.
2. `cursor_ts = sync_state['cursor_ts']`. If null → set `launched_at = now()`, `cursor_ts = now()`, exit (next run does the work).
3. Call FSQ: `GET /v2/users/self/checkins?oauth_token=…&v=20240101&afterTimestamp=<cursor_ts>&sort=oldestfirst&limit=50`.
4. For each checkin (in order):
   - Skip if `fsq_id` already in `seen_checkins`.
   - Build `community.lexicon.location.fsq` from `venue` (id, name, lat/lng).
   - For each `photos.items[]`: fetch `${prefix}1024x1024${suffix}` (caps each photo at safe size; FSQ's "original" can exceed 1MB lex limit), keep bytes only if ≤ 1,000,000 bytes.
   - Lazily createSession (once per cron run); cache `accessJwt` in a module-scoped variable.
   - For each photo: `com.atproto.repo.uploadBlob` → blob ref.
   - `com.atproto.repo.createRecord` with `repo=<did>`, `collection=com.barryfrost.checkin`, `rkey=<TID-from-createdAt>`, `record={createdAt, location, photos}`.
   - On success: `INSERT OR IGNORE` into `seen_checkins`, advance in-memory `cursor_ts` to `max(cursor_ts, fsq_created_at)`.
   - On failure: log, do NOT advance cursor past this id, continue to next (or break — see "Failure semantics" below).
5. Persist final `cursor_ts` to `sync_state`.

### Failure semantics

- Per-checkin try/catch. A failure on one checkin stops the run (so we don't skip past it) but the cursor stays at the last *successfully* processed checkin's timestamp. Next run picks up at the same point; idempotency on `fsq_id` ensures any partially-processed checkin (e.g. blobs uploaded but record not created) just retries cleanly — orphan blobs on the PDS are GC'd by Bluesky after a TTL.
- Network/auth errors at the top of the run abort early, no state change.

## Secrets (Val.Town env vars)

| Name | Purpose |
|---|---|
| `FSQ_OAUTH_TOKEN`   | Long-lived FSQ user token (minted via bootstrap, doesn't expire) |
| `FSQ_API_VERSION`   | e.g. `20240101` — the FSQ `v=` param |
| `BSKY_HANDLE`       | e.g. `barryfrost.com` or `barryfrost.bsky.social` |
| `BSKY_APP_PASSWORD` | App password from bsky.app/settings/app-passwords |
| `BSKY_PDS_URL`      | `https://bsky.social` (default) |

## Bootstrap (one-time, run locally)

`bootstrap/fsq-oauth.ts` — small Deno script:
1. Print FSQ authorize URL using `FSQ_CLIENT_ID` from env + redirect_uri `http://localhost:8765/callback`.
2. Spin up a one-shot HTTP server on `:8765`, capture `?code=`.
3. POST to `https://foursquare.com/oauth2/access_token` to exchange for `access_token`.
4. Print the token to stdout — paste into Val.Town env var.

This stays local (not deployed) because it needs an interactive browser handoff and is one-time.

## Maintenance & durability notes

- **Token longevity**: FSQ OAuth user tokens don't expire (historically). Bluesky `accessJwt` expires in ~2h, but we createSession each cron run — one extra request, no refresh logic, no edge cases. Trade tiny request volume for zero state.
- **Rate limits**: FSQ ≈ 500 req/h/user — we use 1 req per 15 min plus a few per checkin → trivial. Bluesky free is generous; one session + N writes per run is fine.
- **Storage**: 10MB SQLite holds ~100k checkin rows easily. Photos go to PDS blob storage, not Val.Town.
- **Photo size**: We pull the `1024x1024` FSQ variant (rather than `original`) to stay under the 1MB lex `maxSize`. If a photo still exceeds 1MB after fetch, skip it (record still gets created without that photo) and log.
- **Cron drift / catch-up**: If Val.Town cron is paused for hours, the `afterTimestamp` cursor + 50-checkin page size means we replay the gap on resume. For longer outages, the run loops through pages until current.
- **Observability**: Log per checkin (fsq_id → at-uri); inspect via Val.Town logs UI. SQLite `seen_checkins` is the audit trail.
- **Single-user assumption**: All code assumes one operator. No multi-tenancy in schema or auth.

## Critical files / external references

- Val.Town SQLite: `import { sqlite } from "https://esm.town/v/std/sqlite"`.
- Val.Town blob (not used here, but available): `https://esm.town/v/std/blob`.
- FSQ v2 endpoint: `https://api.foursquare.com/v2/users/self/checkins`.
- Bluesky XRPC: `https://bsky.social/xrpc/com.atproto.server.createSession`, `…/com.atproto.repo.uploadBlob`, `…/com.atproto.repo.createRecord`.
- Lexicon to embed: `community.lexicon.location.fsq` (struct, NOT a record — embedded via `$type` field).

## Verification

End-to-end test plan once deployed:
1. **Bootstrap**: run `bootstrap/fsq-oauth.ts` locally, paste token into Val.Town env.
2. **First-run gating**: deploy cron, trigger manually once. Confirm `sync_state` rows for `launched_at` and `cursor_ts` exist; no records written yet.
3. **Real checkin**: do a real Swarm checkin (with a photo). Wait ≤15 min for next cron tick (or trigger manually).
4. **PDS verification**: open `https://pdsls.dev/at://<your-did>/com.barryfrost.checkin` (or `https://atproto-browser.vercel.app/at/<handle>/com.barryfrost.checkin`) — confirm record exists with embedded location and photo blob.
5. **Idempotency**: trigger cron again immediately. Confirm no duplicate record (check PDS list, check SQLite has only one row for that fsq_id).
6. **DB inspection**: Val.Town admin → SQLite → `SELECT * FROM seen_checkins ORDER BY fsq_created_at DESC LIMIT 5`.
7. **Failure replay** (optional): manually delete the just-written PDS record, then `DELETE FROM seen_checkins WHERE fsq_id = '…'`, trigger cron — confirm it re-creates cleanly.

## Teething issues (encountered during setup)

- **FSQ token exchange uses GET, not POST**: Foursquare's `/oauth2/access_token` endpoint expects a GET request with query params, not a POST with a JSON body. `bootstrap/fsq-oauth.ts` was fixed accordingly. The `"unsupported_grant_type"` error is the symptom if you accidentally revert this.
- **`vt push` requires prior `vt create`**: The `vt` CLI needs a `.vt` directory (created by `vt create`) before `vt push` works. On a fresh local clone, run `vt create` first to initialise the project, then `vt push`.
- **`BSKY_PDS_URL` env var warning**: Val.Town warns about any `Deno.env.get(...)` reference that isn't set in env vars, even when the code has a fallback default. Suppress by adding `BSKY_PDS_URL` = `https://bsky.social` to Val.Town env vars. Functionally harmless either way.
- **`vt push` pushes everything including `.git/`**: Val.Town supports a `.vtignore` (works like `.gitignore`) to exclude files. Created `.vtignore` to limit pushes to runtime files only: `cron.ts`, `lib/`, `deno.json`, `README.md`. Excluded: `.git`, `.gitignore`, `.claude`, `PLAN.md`, `CLAUDE.md`, `bootstrap`, `lexicons`. Note: `.vtignore` does **not** support trailing slashes for directories — use bare names (`.git` not `.git/`).
- **FSQ `afterTimestamp` param is broken**: The original cron used `afterTimestamp` + `sort=oldestfirst` to filter server-side. The API returns `count: 1318, items: []` — non-zero count but empty items. Switched to fetching the 50 most recent checkins (default newest-first, no filter params) and filtering locally against the `cursor_ts` launch gate. Dedup via `seen_checkins` PRIMARY KEY handles idempotency. The `cursor_ts` value is now a fixed launch gate (never advanced), not a sliding cursor.

## Out of scope (v1)

- Edits / deletes from Swarm (you'll manage manually).
- Shout text, venue categories (easy to add to lexicon later — additive change, won't break existing records).
- Push API webhook (revisit if 15-min latency feels too slow).
- Publishing the lexicon doc itself to your PDS as `com.atproto.lexicon.schema` (nice-to-have, doesn't affect record validity).
- ~~Backfill of historical checkins~~ — implemented; see `bootstrap/backfill.ts`.
