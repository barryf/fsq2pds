import { getState, setState, seenCheckinIds, recordCheckin } from "./db.ts";
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
// mid-checkin. Unprocessed checkins stay unseen and run next time.
const SUBREQUEST_BUDGET = 45;

export async function run(env: Env): Promise<void> {
  if (!env.FSQ_OAUTH_TOKEN) {
    console.error("FSQ_OAUTH_TOKEN is not set");
    return;
  }
  const db = env.DB;

  const launchedStr = await getState(db, "launched_at");

  // First ever run: record the launch time and exit. Only checkins dated after
  // launch are ever synced, so nothing historical is imported by accident.
  if (launchedStr === null) {
    const now = Math.floor(Date.now() / 1000);
    await setState(db, "launched_at", String(now));
    await setState(db, "cursor_ts", String(now));
    console.log(`First run: launched_at set to ${new Date(now * 1000).toISOString()}`);
    return;
  }

  const launchedAt = parseInt(launchedStr, 10);
  const cursorTs = parseInt((await getState(db, "cursor_ts")) ?? launchedStr, 10);

  let checkins;
  try {
    checkins = await getCheckins(env.FSQ_OAUTH_TOKEN, env.FSQ_API_VERSION || "20240101");
  } catch (err) {
    console.error("Failed to fetch checkins from Foursquare:", err);
    return;
  }
  let subrequests = 1;

  // Sync anything in FSQ's latest page that we haven't seen, not just checkins
  // newer than the last one synced: Swarm lets you add a missed checkin later
  // with an earlier date, and it should still be picked up. One D1 query
  // covers the whole page.
  const candidates = checkins.filter((c) => c.createdAt > launchedAt);
  const seen = await seenCheckinIds(db, candidates.map((c) => c.id));
  const unseen = candidates
    .filter((c) => !seen.has(c.id))
    .sort((a, b) => a.createdAt - b.createdAt); // oldest first

  if (unseen.length === 0) {
    console.log(`No new checkins (${checkins.length} fetched)`);
    return;
  }

  console.log(`Processing ${unseen.length} unsynced checkin(s)`);

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

  let newestSynced = cursorTs;
  let processed = 0;
  for (const checkin of unseen) {
    // getRecord + createRecord + (download + upload) per photo
    const cost = 2 + 2 * (checkin.photos?.items?.length ?? 0);
    if (processed > 0 && subrequests + cost > SUBREQUEST_BUDGET) {
      console.log(`Subrequest budget reached after ${processed} checkin(s); rest deferred to next run`);
      break;
    }
    subrequests += cost;
    processed++;

    const when = new Date(checkin.createdAt * 1000).toISOString();
    try {
      // The PDS may already hold this record (e.g. a previous run died between
      // createRecord and recordCheckin, or it was written by bootstrap/backfill).
      // Adopt it rather than failing on the rkey conflict.
      const existing = await getRecord(session, CHECKIN_COLLECTION, checkin.id);
      const { uri, cid } = existing ?? await syncCheckin(session, checkin);
      await recordCheckin(db, checkin.id, checkin.createdAt, uri, cid);
      console.log(
        existing
          ? `Already on PDS, recorded ${checkin.id} (${checkin.venue.name}, ${when}) → ${uri}`
          : `Synced ${checkin.id} (${checkin.venue.name}, ${when}) → ${uri}`,
      );
      newestSynced = Math.max(newestSynced, checkin.createdAt);
    } catch (err) {
      // Carry on: the checkin stays unseen and is retried next run, and one
      // bad checkin can't block the ones after it.
      console.error(`Failed to process checkin ${checkin.id} (${when}):`, err);
    }
  }

  // cursor_ts is informational only now: the newest checkin date synced.
  if (newestSynced > cursorTs) {
    await setState(db, "cursor_ts", String(newestSynced));
  }
}
