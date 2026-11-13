# fsq2pds

Syncs your Foursquare/Swarm checkins to your ATProto PDS as `com.barryfrost.checkin` records. Runs as a Cloudflare Worker on a 15-minute Cron Trigger, with state in D1. Fits in the Workers free plan.

## Setup

### 1. Create a Foursquare developer app

1. Go to https://foursquare.com/developers/ and create a new app.
2. Add `http://localhost:8765/callback` as an allowed Redirect URI.
3. Note your **Client ID** and **Client Secret**.

### 2. Mint your OAuth token (one-time, local)

```sh
FSQ_CLIENT_ID=<id> FSQ_CLIENT_SECRET=<secret> deno task bootstrap
```

A browser window will open. Log in and approve. The token is printed to your terminal — it doesn't expire.

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

1. **First run**: wait for the cron (or trigger it from the dashboard: Workers → fsq2pds → Settings → Trigger Events). It sets the sync cursor to now and exits. Check `npm run tail` or Workers Logs for `First run: launch cursor set to ...`.
2. **Check in on Swarm.**
3. **Wait up to 15 minutes**, then look for `Synced <id> (<venue>) → at://...` in the logs.
4. **View your records** at:
   ```
   https://pdsls.dev/at://<your-did>/com.barryfrost.checkin
   ```

To test locally: `npm run dev`, then `curl "http://localhost:8787/__scheduled"`. Put secrets in `.dev.vars` (gitignored), and run `npx wrangler d1 migrations apply fsq2pds --local` first.

## Migrating from Val Town

Val Town is shutting down. To move an existing deployment without losing the sync cursor:

1. Run the commands in step 4 above, but **deploy with the `[triggers]` block commented out** so nothing runs yet.
2. **Pause the Val Town cron** (remove its cron trigger).
3. Export state: add `scripts/valtown-export.ts` to the Val Town project as an HTTP val (it must share the fsq2pds val's SQLite), open its URL, and save the output as `valtown-export.sql`.
4. Import it: `npx wrangler d1 execute fsq2pds --remote --file=valtown-export.sql`. Check it with `npx wrangler d1 execute fsq2pds --remote --command "SELECT * FROM sync_state"`.
5. Uncomment `[triggers]` and `npm run deploy`. Check in on Swarm and confirm a `Synced …` log line.
6. Once runs are clean, delete the Val Town vals.

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

- **Only new checkins** are synced. Nothing before the first run is imported. Use `deno task backfill` to import historical checkins, and `deno task backfill-shouts` to add `comment` to already-synced records whose shout predates that feature.
- **Photos**: fetched at FSQ's `1024x1024` size. Skipped if >1MB or unreachable.
- **Edits/deletes**: not synced. Records are write-once. Delete PDS records manually if needed. (`backfill-shouts` is a one-time exception that patches `comment` onto existing records.)
- **If a run fails mid-way**, the cursor stays at the last successful checkin. The next run replays cleanly — duplicate protection is handled by the `seen_checkins` table, and a checkin already present on the PDS (but missing from D1) is adopted rather than re-created.
- **Per-run cap**: the free Workers plan allows 50 outbound requests per run. Each checkin costs 2 + 2 per photo, so a large backlog is spread across several runs.
