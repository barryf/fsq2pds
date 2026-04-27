import {
  ensureSchema,
  getState,
  setState,
  hasCheckin,
  recordCheckin,
} from "./lib/db.ts";
import { getCheckins } from "./lib/foursquare.ts";
import { clearSession, getSession } from "./lib/atproto.ts";
import { syncCheckin } from "./lib/sync.ts";

const FSQ_OAUTH_TOKEN = Deno.env.get("FSQ_OAUTH_TOKEN") ?? "";
const FSQ_API_VERSION = Deno.env.get("FSQ_API_VERSION") ?? "20240101";

interface Interval {
  lastRunAt: Date | undefined;
}

export default async function (_interval: Interval): Promise<void> {
  if (!FSQ_OAUTH_TOKEN) {
    console.error("FSQ_OAUTH_TOKEN is not set");
    return;
  }

  await ensureSchema();
  clearSession(); // fresh session each run; avoids stale JWT issues

  const cursorStr = await getState("cursor_ts");

  // First ever run: record the launch time as our cursor and exit.
  // Sync will begin from this point on the next run.
  if (cursorStr === null) {
    const now = Math.floor(Date.now() / 1000);
    await setState("launched_at", String(now));
    await setState("cursor_ts", String(now));
    console.log(`First run: launch cursor set to ${new Date(now * 1000).toISOString()}`);
    return;
  }

  const launchTs = parseInt(cursorStr, 10);

  console.log(`Fetching recent checkins (launch cursor: ${new Date(launchTs * 1000).toISOString()})`);

  let checkins;
  try {
    checkins = await getCheckins(FSQ_OAUTH_TOKEN, FSQ_API_VERSION);
  } catch (err) {
    console.error("Failed to fetch checkins from Foursquare:", err);
    return;
  }

  // Filter to checkins after our launch timestamp; FSQ returns newest-first
  const newCheckins = checkins.filter((c) => c.createdAt > launchTs);

  if (newCheckins.length === 0) {
    console.log("No new checkins");
    return;
  }

  // Process oldest-first so records are written in chronological order
  newCheckins.reverse();

  console.log(`Processing ${newCheckins.length} checkin(s)`);

  let session;
  try {
    session = await getSession();
  } catch (err) {
    console.error("Failed to authenticate with PDS:", err);
    return;
  }

  for (const checkin of newCheckins) {
    if (await hasCheckin(checkin.id)) {
      console.log(`Already synced: ${checkin.id}`);
      continue;
    }

    try {
      const { uri, cid } = await syncCheckin(session, checkin);
      await recordCheckin(checkin.id, checkin.createdAt, uri, cid);
      console.log(`Synced ${checkin.id} (${checkin.venue.name}) → ${uri}`);
    } catch (err) {
      console.error(`Failed to process checkin ${checkin.id}:`, err);
      // Stop here; seen_checkins dedup ensures next run replays this checkin cleanly
      break;
    }
  }
}

