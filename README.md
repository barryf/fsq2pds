# fsq2pds

Syncs your Foursquare/Swarm checkins to your ATProto PDS as `com.barryfrost.checkin` records. Runs on Val.Town's free tier as a 15-minute cron.

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

### 4. Deploy to Val.Town

1. Install the `vt` CLI: https://docs.val.town/cli/
2. From this directory run `vt push` (or use the Val.Town editor to paste the files).
3. Set these **environment variables** in Val.Town settings:

   | Variable | Value |
   |----------|-------|
   | `FSQ_OAUTH_TOKEN` | Token from step 2 |
   | `FSQ_API_VERSION` | `20240101` |
   | `BSKY_HANDLE` | Your Bluesky handle |
   | `BSKY_APP_PASSWORD` | App password from step 3 |

4. Open `cron.ts` in Val.Town and add a **cron trigger** set to every 15 minutes.

### 5. Verify

1. **Trigger manually** (first run). It will set the sync cursor to now and exit — no records written yet. Check the logs for `First run: launch cursor set to ...`.
2. **Check in on Swarm.**
3. **Trigger again** (or wait up to 15 minutes). Check the logs for `Synced <id> (<venue>) → at://...`.
4. **View your records** at:
   ```
   https://pdsls.dev/at://<your-did>/com.barryfrost.checkin
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

## Notes

- **Only new checkins** are synced. Nothing before the first run is imported.
- **Photos**: fetched at FSQ's `1024x1024` size. Skipped if >1MB or unreachable.
- **Edits/deletes**: not synced. Records are write-once. Delete PDS records manually if needed.
- **If a run fails mid-way**, the cursor stays at the last successful checkin. The next run replays cleanly — duplicate protection is handled by the `seen_checkins` table.
