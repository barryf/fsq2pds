/**
 * One-time script to publish the com.barryfrost.checkin lexicon to your PDS.
 *
 * Stores the lexicon at:
 *   at://<your-did>/com.atproto.lexicon.schema/com.barryfrost.checkin
 *
 * Uses putRecord (upsert) so it's safe to re-run if the lexicon is updated.
 *
 * Usage:
 *   BSKY_HANDLE=<handle> BSKY_APP_PASSWORD=<password> deno run --allow-env --allow-net --allow-read bootstrap/publish-lexicon.ts
 */

import lexicon from "../lexicons/com.barryfrost.checkin.json" with { type: "json" };

const PDS_URL = Deno.env.get("BSKY_PDS_URL") ?? "https://bsky.social";
const handle = Deno.env.get("BSKY_HANDLE");
const password = Deno.env.get("BSKY_APP_PASSWORD");

if (!handle || !password) {
  console.error("BSKY_HANDLE and BSKY_APP_PASSWORD must be set.");
  Deno.exit(1);
}

// Authenticate
const sessionResp = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ identifier: handle, password }),
});
if (!sessionResp.ok) {
  console.error(`Auth failed (${sessionResp.status}):`, await sessionResp.text());
  Deno.exit(1);
}
const { accessJwt, did } = await sessionResp.json();

// Publish lexicon using putRecord (upsert — safe to re-run)
const record = { "$type": "com.atproto.lexicon.schema", ...lexicon };
const putResp = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.putRecord`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": `Bearer ${accessJwt}`,
  },
  body: JSON.stringify({
    repo: did,
    collection: "com.atproto.lexicon.schema",
    rkey: lexicon.id,
    record,
  }),
});
if (!putResp.ok) {
  console.error(`putRecord failed (${putResp.status}):`, await putResp.text());
  Deno.exit(1);
}
const result = await putResp.json();
console.log(`Published: ${result.uri}`);
