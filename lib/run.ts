import { getState, setState, hasCheckin, recordCheckin } from "./db.ts";
import { getCheckins } from "./foursquare.ts";
import { getRecord, getSession, type Session } from "./atproto.ts";
import { syncCheckin, CHECKIN_COLLECTION } from "./sync.ts";

export interface Env {
  DB: D1Database;
  FSQ_OAUTH_TOKEN: string;
  FSQ_API_VERSION?: string;
  BSKY_HANDLE: string;
  BSKY_APP_PASSWORD: string;
  BSKY_PDS_URL?: string;
}

// Free-plan Workers get 50 outbound fetches per invocation. Leave headroom for
// the FSQ fetch + createSession, and stop early rather than hit the limit
// mid-checkin. Unprocessed checkins stay after the cursor and run next time.
const SUBREQUEST_BUDGET = 45;

export async function run(env: Env): Promise<void> {
  if (!env.FSQ_OAUTH_TOKEN) {
    console.error("FSQ_OAUTH_TOKEN is not set");
    return;
  }
  const db = env.DB;

  const cursorStr = await getState(db, "cursor_ts");

  // First ever run: record the launch time as our cursor and exit.
  // Sync will begin from this point on the next run.
  if (cursorStr === null) {
    const now = Math.floor(Date.now() / 1000);
    await setState(db, "launched_at", String(now));
    await setState(db, "cursor_ts", String(now));
    console.log(`First run: launch cursor set to ${new Date(now * 1000).toISOString()}`);
    return;
  }

  const cursorTs = parseInt(cursorStr, 10);
  let newCursorTs = cursorTs;

  console.log(`Fetching recent checkins (cursor: ${new Date(cursorTs * 1000).toISOString()})`);

  let checkins;
  try {
    checkins = await getCheckins(env.FSQ_OAUTH_TOKEN, env.FSQ_API_VERSION || "20240101");
  } catch (err) {
    console.error("Failed to fetch checkins from Foursquare:", err);
    return;
  }
  let subrequests = 1;

  // Filter to checkins after our cursor; FSQ returns newest-first
  const newCheckins = checkins.filter((c) => c.createdAt > cursorTs);

  if (newCheckins.length === 0) {
    console.log("No new checkins");
    return;
  }

  // Process oldest-first so records are written in chronological order
  newCheckins.reverse();

  console.log(`Processing ${newCheckins.length} checkin(s)`);

  let session: Session;
  try {
    session = await getSession({
      handle: env.BSKY_HANDLE,
      appPassword: env.BSKY_APP_PASSWORD,
      pdsUrl: env.BSKY_PDS_URL,
    });
  } catch (err) {
    console.error("Failed to authenticate with PDS:", err);
    return;
  }
  subrequests++;

  let processed = 0;
  for (const checkin of newCheckins) {
    if (await hasCheckin(db, checkin.id)) {
      console.log(`Already synced: ${checkin.id}`);
      newCursorTs = Math.max(newCursorTs, checkin.createdAt);
      continue;
    }

    // getRecord + createRecord + (download + upload) per photo
    const cost = 2 + 2 * (checkin.photos?.items?.length ?? 0);
    if (processed > 0 && subrequests + cost > SUBREQUEST_BUDGET) {
      console.log(`Subrequest budget reached after ${processed} checkin(s); rest deferred to next run`);
      break;
    }
    subrequests += cost;
    processed++;

    try {
      // The PDS may already hold this record (e.g. a previous run died between
      // createRecord and recordCheckin, or D1 state was restored from an older
      // export). Adopt it rather than failing on the rkey conflict forever.
      const existing = await getRecord(session, CHECKIN_COLLECTION, checkin.id);
      const { uri, cid } = existing ?? await syncCheckin(session, checkin);
      await recordCheckin(db, checkin.id, checkin.createdAt, uri, cid);
      console.log(
        existing
          ? `Already on PDS, recorded ${checkin.id} (${checkin.venue.name}) → ${uri}`
          : `Synced ${checkin.id} (${checkin.venue.name}) → ${uri}`,
      );
      newCursorTs = Math.max(newCursorTs, checkin.createdAt);
    } catch (err) {
      console.error(`Failed to process checkin ${checkin.id}:`, err);
      // Stop here; seen_checkins dedup ensures next run replays this checkin cleanly
      break;
    }
  }

  if (newCursorTs > cursorTs) {
    await setState(db, "cursor_ts", String(newCursorTs));
    console.log(`Cursor advanced to ${new Date(newCursorTs * 1000).toISOString()}`);
  }
}
