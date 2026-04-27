/**
 * One-time script to backfill all historical Foursquare/Swarm checkins to the PDS.
 *
 * - Idempotent: queries existing PDS records first, skips already-imported checkins.
 * - Resumable: safe to re-run after any crash — picks up where it left off.
 * - Best-effort: per-checkin failures are logged to backfill-failures.log, then skipped.
 *
 * Usage:
 *   FSQ_OAUTH_TOKEN=... FSQ_API_VERSION=20240101 BSKY_HANDLE=... BSKY_APP_PASSWORD=... \
 *   deno task backfill [--dry-run]
 *
 * --dry-run: prints what would be synced without writing any PDS records.
 */

import { getCheckins } from "../lib/foursquare.ts";
import { clearSession, getSession, listRecords } from "../lib/atproto.ts";
import { syncCheckin } from "../lib/sync.ts";

const isDryRun = Deno.args.includes("--dry-run");
const FSQ_OAUTH_TOKEN = Deno.env.get("FSQ_OAUTH_TOKEN") ?? "";
const FSQ_API_VERSION = Deno.env.get("FSQ_API_VERSION") ?? "20240101";
const FAILURE_LOG = "backfill-failures.log";
const PAGE_SIZE = 250;
const CHECKIN_THROTTLE_MS = 500;
const PAGE_THROTTLE_MS = 1_000;

if (!FSQ_OAUTH_TOKEN) {
  console.error("FSQ_OAUTH_TOKEN is required.");
  Deno.exit(1);
}

if (isDryRun) console.log("[DRY RUN] No records will be written.\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (attempt === retries) throw err;
      const delay = 2_000 * Math.pow(2, attempt);
      console.warn(`  Retry ${attempt + 1}/${retries} in ${delay / 1000}s… (${err})`);
      await sleep(delay);
    }
  }
  throw new Error("unreachable");
}

async function appendFailure(entry: object): Promise<void> {
  await Deno.writeTextFile(FAILURE_LOG, JSON.stringify(entry) + "\n", { append: true });
}

// Step 1: authenticate
const session = await getSession();
console.log(`Authenticated as ${session.did}\n`);

// Step 2: build skip-set from existing PDS records
console.log("Fetching existing PDS records…");
const existing = await listRecords(session, "com.barryfrost.checkin");
console.log(`${existing.size} already imported\n`);

// Step 3: paginate all FSQ checkins (newest-first default)
console.log("Fetching all Foursquare checkins…");
const allCheckins = [];
let offset = 0;

while (true) {
  const page = await withRetry(() =>
    getCheckins(FSQ_OAUTH_TOKEN, FSQ_API_VERSION, offset, PAGE_SIZE)
  );
  allCheckins.push(...page);
  console.log(`  offset=${offset}: got ${page.length} (total so far: ${allCheckins.length})`);
  if (page.length < PAGE_SIZE) break;
  offset += PAGE_SIZE;
  await sleep(PAGE_THROTTLE_MS);
}

console.log(`\nTotal from FSQ: ${allCheckins.length}`);

// Step 4: filter already-imported, sort oldest-first
const toSync = allCheckins
  .filter((c) => !existing.has(c.id))
  .sort((a, b) => a.createdAt - b.createdAt);

const alreadyPresent = allCheckins.length - toSync.length;
console.log(`To sync: ${toSync.length}  |  Already present: ${alreadyPresent}\n`);

if (isDryRun) {
  console.log("[DRY RUN] First 10 checkins that would be synced:");
  for (const c of toSync.slice(0, 10)) {
    const date = new Date(c.createdAt * 1000).toISOString().slice(0, 10);
    const photos = c.photos?.count ?? 0;
    console.log(`  ${c.id}  ${date}  ${c.venue.name}  (${photos} photo${photos !== 1 ? "s" : ""})`);
  }
  console.log(`\n[DRY RUN] Exiting without writing.`);
  Deno.exit(0);
}

// Step 5: sync each checkin
let synced = 0;
let failed = 0;

for (const checkin of toSync) {
  try {
    const { uri, photosUploaded } = await withRetry(async () => {
      try {
        return await syncCheckin(session, checkin);
      } catch (err: unknown) {
        // Re-auth if JWT has expired mid-run
        if (String(err).includes("401") || String(err).includes("ExpiredToken")) {
          clearSession();
          Object.assign(session, await getSession());
          return await syncCheckin(session, checkin);
        }
        throw err;
      }
    });

    synced++;
    const photoLabel = photosUploaded > 0 ? ` +${photosUploaded} photo${photosUploaded !== 1 ? "s" : ""}` : "";
    console.log(`[${synced}/${toSync.length}] ${checkin.id}  ${checkin.venue.name}${photoLabel}  → ${uri}`);
  } catch (err) {
    failed++;
    console.error(`  FAILED ${checkin.id} (${checkin.venue.name}): ${err}`);
    await appendFailure({
      fsq_id: checkin.id,
      venue: checkin.venue.name,
      createdAt: checkin.createdAt,
      error: String(err),
    });
  }

  await sleep(CHECKIN_THROTTLE_MS);
}

console.log(
  `\nFinished. Synced: ${synced}  Already present: ${alreadyPresent}  Failed: ${failed}`,
);
if (failed > 0) {
  console.log(`Failed checkins logged to: ${FAILURE_LOG}`);
}
