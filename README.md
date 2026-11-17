# fsq2pds

Syncs your Foursquare/Swarm checkins to your ATProto PDS as `com.barryfrost.checkin` records. Runs as a Cloudflare Worker on a 5-minute Cron Trigger, with state in D1. Fits in the Workers free plan.

## Setup

### 1. Create a Foursquare developer app

1. Go to https://foursquare.com/developers/ and create a new app.
2. Add `http://localhost:8765/callback` as an allowed Redirect URI.
3. Note your **Client ID** and **Client Secret**.

### 2. Mint your OAuth token (one-time, local)

```sh
npm install
FSQ_CLIENT_ID=<id> FSQ_CLIENT_SECRET=<secret> npm run bootstrap
```

Open the printed URL in your browser, log in and approve. The token is printed to your terminal — it doesn't expire.

### 3. Create a Bluesky app password

1. Go to https://bsky.app/settings/app-passwords
2. Create a new app password named `fsq2pds`.

### 4. Deploy to Cloudflare Workers

Requires Node 20+ and a Cloudflare account.

```sh
npm install
npx wrangler login
npx wrangler d1 create fsq2pds          # paste the printed database_id into wrangler.toml
npm run db:migrate                      # creates seen_checkins + sync_state in D1
npx wrangler secret put FSQ_OAUTH_TOKEN
npx wrangler secret put BSKY_HANDLE
npx wrangler secret put BSKY_APP_PASSWORD
npm run deploy
```

`FSQ_API_VERSION` is a plain var in `wrangler.toml`. Set `BSKY_PDS_URL` there too if your PDS isn't `bsky.social`.

### 5. Verify

1. **First run**: wait for the cron (or trigger it from the dashboard: Workers → fsq2pds → Settings → Trigger Events). It records `launched_at` as now and exits. Check `npm run tail` or Workers Logs for `First run: launched_at set to ...`.
2. **Check in on Swarm.**
3. **Wait up to 5 minutes**, then look for `Synced <id> (<venue>) → at://...` in the logs.
4. **View your records** at:
   ```
   https://pdsls.dev/at://<your-did>/com.barryfrost.checkin
   ```

To test locally: `npm run dev`, then `curl "http://localhost:8787/__scheduled"`. Put secrets in `.dev.vars` (gitignored), and run `npx wrangler d1 migrations apply fsq2pds --local` first.

## Migration from Val Town (done 2026-11-17)

fsq2pds ran on Val Town until Val Town [wound down](https://docs.val.town/migration). Val Town code went read-only on 2026-12-10, and vals stopped running on 2027-01-10. The move to Cloudflare was done on 2026-11-17, mostly from a Claude Code session, using Val Town's REST API (with a short-lived API token) and Cloudflare's D1 connector. Only the deploy and secrets were run locally.

What was done, in order:

1. **D1:** created `fsq2pds` (Western Europe) and applied `migrations/0001_init.sql`, then committed its `database_id` to `wrangler.toml`.
2. **Export:** Val Town's API can't query a val's own SQLite (`POST /v1/sqlite/execute` only reaches the account-wide legacy database). So `scripts/valtown-export.ts` was added to the val as an HTTP file over the API (`POST /v2/vals/{id}/files`), protected by a random `SQLITE_EXPORT_TOKEN` set with `POST /v2/vals/{id}/environment_variables/`. The dump was then downloaded with the token sent as a bearer header, and checked to end with `-- Export complete`.
3. **Import and verify:** 2 `sync_state` rows and 84 `seen_checkins` rows were inserted into D1. They were compared against the dump by row count and per-column sums before going further.
4. **Pause Val Town:** `cron.ts` was switched from `interval` to `script` (`PUT /v2/vals/{id}/files?path=cron.ts` with `{"type":"script"}`). This stops it running without deleting the code. A second export confirmed nothing had changed in between.
5. **Deploy (locally):** `wrangler secret put` for the three secrets, using a new Bluesky app password, then `npm run deploy`.
6. **Confirm:** the first scheduled run synced the next unseen checkins, which were checked as new rows in `seen_checkins`. A deploy alone doesn't prove the cron ran.
7. **Clean up:** deleted `export.ts` and `SQLITE_EXPORT_TOKEN` from the val, plus the local dump and token. Revoked the old Bluesky app password and the Val Town API token, and deleted the val.

If D1's state is ever lost, there's no need to restore it from Val Town. Set `launched_at` to the cut-off you want, and the next runs will sync anything in Foursquare's latest 50 that's dated after it. Checkins already on the PDS are detected with `getRecord` and recorded in D1, not created again.

```sh
npx wrangler d1 execute fsq2pds --remote --command \
  "INSERT OR REPLACE INTO sync_state (key, value) VALUES ('launched_at', '<unix-seconds>')"
```

## Record shape

```json
{
  "$type": "com.barryfrost.checkin",
  "createdAt": "2024-06-01T14:30:00.000Z",
  "location": {
    "$type": "community.lexicon.location.fsq",
    "fsq_place_id": "abc123def456",
    "name": "Blue Bottle Coffee",
    "latitude": "37.776",
    "longitude": "-122.418"
  },
  "address": "123 High Street, London, UK",
  "category": "Coffee Shop",
  "comment": "Best flat white in town",
  "photos": [
    {
      "image": {
        "$type": "blob",
        "ref": { "$link": "bafyrei..." },
        "mimeType": "image/jpeg",
        "size": 245678
      }
    }
  ]
}
```

`address`, `category`, `comment`, and `photos` are all optional — omitted when the source checkin has no value for them. The lexicon doc itself is maintained in the `barryfrost-v7` repo, not here.

## Notes

- **Only checkins dated after the first run** are synced. Each run syncs any checkin in Foursquare's latest 50 that it hasn't seen, so a missed checkin added later from Swarm's timeline (with an earlier date) is still picked up. Nothing before the first run is imported. Use `npm run backfill` to import historical checkins, and `npm run backfill-shouts` to add `comment` to already-synced records whose shout predates that feature.
- **Local scripts** (`bootstrap/`) need Node 22.18+, which runs TypeScript directly. Pass flags after `--`, e.g. `npm run backfill -- --dry-run`. They read `FSQ_OAUTH_TOKEN`, `FSQ_API_VERSION`, `BSKY_HANDLE`, `BSKY_APP_PASSWORD` (and optional `BSKY_PDS_URL`) from the shell environment.
- **Photos**: fetched at FSQ's `1024x1024` size. Skipped if >1MB or unreachable.
- **Edits/deletes**: not synced. Records are write-once. Delete PDS records manually if needed. (`backfill-shouts` is a one-time exception that patches `comment` onto existing records.)
- **If a checkin fails to sync**, it's logged and retried on the next run; later checkins aren't held up. Duplicate protection is handled by the `seen_checkins` table, and a checkin already present on the PDS (but missing from D1) is adopted rather than re-created.
- **Per-run cap**: the free Workers plan allows 50 outbound requests per run. Each checkin costs 2 + 2 per photo, so a large backlog is spread across several runs.
