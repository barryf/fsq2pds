/**
 * One-time script to backfill `comment` onto already-synced PDS records whose
 * Foursquare checkin has a shout (user comment) that hasn't been imported yet.
 *
 * - Idempotent: skips records that already have a `comment` field set.
 * - Resumable: safe to re-run after any crash — picks up where it left off.
 * - Best-effort: per-checkin failures are logged to backfill-shouts-failures.log, then skipped.
 *
 * Usage:
 *   FSQ_OAUTH_TOKEN=... FSQ_API_VERSION=20240101 BSKY_HANDLE=... BSKY_APP_PASSWORD=... \
 *   deno task backfill-shouts [--dry-run]
 *
 * --dry-run: prints what would be updated without writing any PDS records.
 */

import { getCheckins } from "../lib/foursquare.ts";
import { clearSession, getSession, listRecords, putRecord } from "../lib/atproto.ts";

const isDryRun = Deno.args.includes("--dry-run");
const FSQ_OAUTH_TOKEN = Deno.env.get("FSQ_OAUTH_TOKEN") ?? "";
const FSQ_API_VERSION = Deno.env.get("FSQ_API_VERSION") ?? "20240101";
const FAILURE_LOG = "backfill-shouts-failures.log";
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

// Step 2: fetch existing PDS records (rkey → { cid, value })
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

// Step 4: build work list — checkins with a shout, a matching PDS record, and no comment yet
let noRecord = 0;
let alreadyHasComment = 0;

const toUpdate = allCheckins
  .filter((c) => {
    const shout = c.shout?.trim();
    if (!shout) return false;
    const record = existing.get(c.id);
    if (!record) {
      noRecord++;
      return false;
    }
    if (record.value.comment) {
      alreadyHasComment++;
      return false;
    }
    return true;
  })
  .sort((a, b) => a.createdAt - b.createdAt);

console.log(`To update: ${toUpdate.length}`);
console.log(`Already has comment: ${alreadyHasComment}`);
if (noRecord > 0) {
  console.log(
    `Shout but no PDS record: ${noRecord}  (run \`deno task backfill\` first to import these checkins)`,
  );
}
console.log();

if (isDryRun) {
  console.log("[DRY RUN] First 10 checkins that would be updated:");
  for (const c of toUpdate.slice(0, 10)) {
    const date = new Date(c.createdAt * 1000).toISOString().slice(0, 10);
    console.log(`  ${c.id}  ${date}  ${c.venue.name}  "${c.shout?.trim()}"`);
  }
  console.log(`\n[DRY RUN] Exiting without writing.`);
  Deno.exit(0);
}

// Step 5: update each record
let updated = 0;
let failed = 0;

for (const checkin of toUpdate) {
  const shout = checkin.shout!.trim();
  const record = existing.get(checkin.id)!;

  try {
    const { uri } = await withRetry(async () => {
      try {
        return await putRecord(
          session,
          "com.barryfrost.checkin",
          checkin.id,
          { ...record.value, comment: shout },
          record.cid,
        );
      } catch (err: unknown) {
        // Re-auth if JWT has expired mid-run
        if (String(err).includes("401") || String(err).includes("ExpiredToken")) {
          clearSession();
          Object.assign(session, await getSession());
          return await putRecord(
            session,
            "com.barryfrost.checkin",
            checkin.id,
            { ...record.value, comment: shout },
            record.cid,
          );
        }
        throw err;
      }
    });

    updated++;
    console.log(`[${updated}/${toUpdate.length}] ${checkin.id}  ${checkin.venue.name}  → ${uri}`);
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
  `\nFinished. Updated: ${updated}  Already had comment: ${alreadyHasComment}  No record: ${noRecord}  Failed: ${failed}`,
);
if (failed > 0) {
  console.log(`Failed checkins logged to: ${FAILURE_LOG}`);
}
