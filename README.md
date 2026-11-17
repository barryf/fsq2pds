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

## Migrating from Val Town

Val Town is [winding down](https://docs.val.town/migration). Two deadlines:

- **2026-12-10**: Val Town code becomes read-only. The export file in step 3 must be **created before this date**.
- **2027-01-10**: vals stop running. The Worker must be syncing before this date.

To move an existing deployment without losing the sync cursor:

1. **Secrets.** Prefer fresh credentials over copying the old ones out of Val Town. Create a new Bluesky app password for the Worker, and re-use your saved FSQ token or mint a new one with `npm run bootstrap`. Revoke the Val Town app password once the Worker is verified. (Val Town's [transfer-secrets guide](https://docs.val.town/migration/cloudflare/transfer-secrets) has an encrypted copy flow if you can't recover the values.)
2. Run the commands in step 4 above, but **deploy with the `[triggers]` block commented out** so nothing runs yet. Check the secret names with `npx wrangler secret list`.
3. **Prepare the export (before 2026-12-10).** Add `scripts/valtown-export.ts` to the fsq2pds val as an HTTP file. It must be in the same val, because its SQLite is scoped per val. Then set a Val Town env var `SQLITE_EXPORT_TOKEN` to a random secret (`openssl rand -hex 32`).
4. **Pause the Val Town cron** (remove its cron trigger).
5. **Export** with the token sent from stdin, so it stays out of shell history:
   ```sh
   printf 'Authorization: Bearer %s' "$SQLITE_EXPORT_TOKEN" \
     | curl -fsS -H @- -o valtown-export.sql https://<your-export-endpoint>
   tail -2 valtown-export.sql   # must end with "-- Export complete"; note the row counts
   ```
6. **Import and verify.** The row counts must match the `-- Rows:` line:
   ```sh
   npx wrangler d1 execute fsq2pds --remote --file=valtown-export.sql
   npx wrangler d1 execute fsq2pds --remote --command \
     "SELECT (SELECT count(*) FROM sync_state) AS state, (SELECT count(*) FROM seen_checkins) AS seen, (SELECT value FROM sync_state WHERE key='cursor_ts') AS cursor"
   ```
7. Uncomment `[triggers]` and `npm run deploy`. A deploy doesn't prove the job ran. Wait for a real scheduled run in Workers Logs, then check in on Swarm and confirm a `Synced …` line.
8. Clean up: delete the export file and the `SQLITE_EXPORT_TOKEN` env var on Val Town, delete the local `valtown-export.sql` once you're happy (it's gitignored), revoke the old Bluesky app password, then delete the vals.

If the export isn't possible, seed the cursor by hand with the unix time of your newest synced checkin. Anything already on the PDS is detected and skipped, so erring early is safe:

```sh
npx wrangler d1 execute fsq2pds --remote --command \
  "INSERT INTO sync_state (key, value) VALUES ('cursor_ts', '<unix-seconds>'), ('launched_at', '<unix-seconds>')"
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
