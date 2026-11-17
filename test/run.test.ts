// End-to-end tests for the sync loop: the real run() against an in-memory
// SQLite (via node:sqlite) shaped like D1, with the real migration applied,
// and a stubbed fetch standing in for Foursquare and the PDS.
//
// Run with `npm test` (Node 22.18+ runs this .ts file directly).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { run } from "../lib/run.ts";

let sql: DatabaseSync;
let fsqItems: unknown[];
let pds: Map<string, { uri: string; cid: string; value: Record<string, unknown> }>;
let calls: string[];
let failRkeys: Set<string>;

// Minimal D1Database: prepare().bind().first()/all()/run()
function fakeD1() {
  return {
    prepare(query: string) {
      let args: (string | number | null)[] = [];
      const stmt = {
        bind(...a: (string | number | null)[]) {
          args = a;
          return stmt;
        },
        async first() {
          return sql.prepare(query).get(...args) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...args) };
        },
        async run() {
          sql.prepare(query).run(...args);
          return {};
        },
      };
      return stmt;
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.host === "api.foursquare.com") {
      return json({ meta: { code: 200 }, response: { checkins: { items: fsqItems } } });
    }
    if (url.host === "photos.example") {
      return new Response(new Uint8Array(10), { headers: { "content-type": "image/jpeg" } });
    }
    const method = url.pathname.split("/").at(-1);
    if (method === "com.atproto.server.createSession") {
      return json({ accessJwt: "jwt", did: "did:plc:test" });
    }
    if (method === "com.atproto.repo.getRecord") {
      const r = pds.get(url.searchParams.get("rkey")!);
      return r ? json(r) : json({ error: "RecordNotFound" }, 400);
    }
    if (method === "com.atproto.repo.uploadBlob") {
      return json({ blob: { $type: "blob", size: 10 } });
    }
    if (method === "com.atproto.repo.createRecord") {
      const body = JSON.parse(String(init?.body));
      if (failRkeys.has(body.rkey)) return json({ error: "InternalServerError" }, 500);
      if (pds.has(body.rkey)) return json({ error: "InvalidRequest" }, 400);
      const r = {
        uri: `at://did:plc:test/${body.collection}/${body.rkey}`,
        cid: `cid-${body.rkey}`,
        value: body.record,
      };
      pds.set(body.rkey, r);
      return json(r);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

const env = () =>
  ({
    DB: fakeD1(),
    FSQ_OAUTH_TOKEN: "t",
    BSKY_HANDLE: "h",
    BSKY_APP_PASSWORD: "p",
  }) as unknown as Parameters<typeof run>[0];

const state = (key: string) =>
  (sql.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as { value: string } | undefined)
    ?.value;
const seenCount = () => (sql.prepare("SELECT count(*) AS n FROM seen_checkins").get() as { n: number }).n;

const checkin = (id: string, createdAt: number, photos = 0) => ({
  id,
  createdAt,
  venue: { id: `v-${id}`, name: `Venue ${id}` },
  photos: {
    count: photos,
    items: Array.from({ length: photos }, () => ({ prefix: "https://photos.example/", suffix: "/p.jpg" })),
  },
});
// FSQ returns newest-first by checkin date
const page = (...items: ReturnType<typeof checkin>[]) =>
  items.sort((a, b) => b.createdAt - a.createdAt);

const LAUNCH = 1_000_000;

beforeEach(() => {
  sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  fsqItems = [];
  pds = new Map();
  calls = [];
  failRkeys = new Set();
  stubFetch();
  console.log = () => {};
  console.error = () => {};
});

const launched = () => {
  sql.prepare("INSERT INTO sync_state (key, value) VALUES ('launched_at', ?), ('cursor_ts', ?)")
    .run(String(LAUNCH), String(LAUNCH));
};

test("first run records launched_at and writes nothing", async () => {
  fsqItems = page(checkin("a", 5));
  await run(env());
  assert.ok(Number(state("launched_at")) > 0);
  assert.equal(pds.size, 0);
  assert.equal(calls.filter((c) => c.includes("foursquare") || c.includes("xrpc")).length, 0);
});

test("syncs new checkins oldest-first, with photos, and skips pre-launch ones", async () => {
  launched();
  fsqItems = page(checkin("old", LAUNCH - 10), checkin("a", LAUNCH + 10), checkin("b", LAUNCH + 20, 1));
  await run(env());
  assert.deepEqual([...pds.keys()], ["a", "b"]);
  assert.equal((pds.get("b")!.value.photos as unknown[]).length, 1);
  assert.equal(seenCount(), 2);
  assert.equal(Number(state("cursor_ts")), LAUNCH + 20);
});

test("a run with nothing new makes one FSQ call and never logs in to the PDS", async () => {
  launched();
  fsqItems = page(checkin("a", LAUNCH + 10));
  await run(env());
  calls = [];
  await run(env());
  assert.deepEqual(calls, ["/v2/users/self/checkins"]);
});

test("picks up a checkin added later with an earlier date (Swarm timeline)", async () => {
  launched();
  fsqItems = page(checkin("monday", LAUNCH + 200));
  await run(env());
  assert.equal(Number(state("cursor_ts")), LAUNCH + 200);

  // Added afterwards, dated before the newest synced checkin
  fsqItems = page(checkin("monday", LAUNCH + 200), checkin("sunday", LAUNCH + 100));
  await run(env());
  assert.ok(pds.has("sunday"), "backdated checkin synced");
  assert.equal(seenCount(), 2);
  assert.equal(Number(state("cursor_ts")), LAUNCH + 200, "cursor_ts never moves backwards");
});

test("adopts a record already on the PDS instead of failing on the rkey", async () => {
  launched();
  pds.set("c", { uri: "at://did:plc:test/com.barryfrost.checkin/c", cid: "cid-pre", value: {} });
  fsqItems = page(checkin("c", LAUNCH + 30));
  await run(env());
  const row = sql.prepare("SELECT pds_cid FROM seen_checkins WHERE fsq_id = 'c'").get() as { pds_cid: string };
  assert.equal(row.pds_cid, "cid-pre");
  assert.ok(!calls.includes("/xrpc/com.atproto.repo.createRecord"));
});

test("one failing checkin doesn't block the others, and is retried next run", async () => {
  launched();
  failRkeys.add("bad");
  fsqItems = page(checkin("bad", LAUNCH + 10), checkin("good", LAUNCH + 20));
  await run(env());
  assert.ok(pds.has("good"));
  assert.ok(!pds.has("bad"));
  assert.equal(seenCount(), 1);

  failRkeys.clear();
  await run(env());
  assert.ok(pds.has("bad"));
  assert.equal(seenCount(), 2);
});

test("spreads a large backlog across runs within the subrequest budget", async () => {
  launched();
  fsqItems = page(...Array.from({ length: 12 }, (_, i) => checkin(`d${i}`, LAUNCH + 100 + i, 2)));
  let runs = 0;
  while (pds.size < 12 && runs < 6) {
    calls = [];
    await run(env());
    runs++;
    assert.ok(calls.length <= 50, `run ${runs} used ${calls.length} subrequests`);
  }
  assert.equal(pds.size, 12);
  assert.ok(runs > 1, "needed more than one run");
});
