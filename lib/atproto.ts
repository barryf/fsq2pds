const PDS_URL = Deno.env.get("BSKY_PDS_URL") ?? "https://bsky.social";

export interface Session {
  accessJwt: string;
  did: string;
}

// Module-scoped session cache; cleared on each cron invocation via clearSession()
let cachedSession: Session | null = null;

export function clearSession(): void {
  cachedSession = null;
}

export async function getSession(): Promise<Session> {
  if (cachedSession) return cachedSession;
  const handle = Deno.env.get("BSKY_HANDLE");
  const password = Deno.env.get("BSKY_APP_PASSWORD");
  if (!handle || !password) {
    throw new Error("BSKY_HANDLE and BSKY_APP_PASSWORD env vars are required");
  }
  const resp = await fetch(`${PDS_URL}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });
  if (!resp.ok) {
    throw new Error(`createSession failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  cachedSession = { accessJwt: data.accessJwt, did: data.did };
  return cachedSession;
}

export async function uploadBlob(
  session: Session,
  bytes: Uint8Array,
  mimeType: string,
): Promise<object> {
  const resp = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "POST",
    headers: {
      "content-type": mimeType,
      "authorization": `Bearer ${session.accessJwt}`,
    },
    body: bytes,
  });
  if (!resp.ok) {
    throw new Error(`uploadBlob failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.blob;
}

export interface CreateRecordResult {
  uri: string;
  cid: string;
}

export async function listRecords(
  session: Session,
  collection: string,
): Promise<Map<string, { cid: string; value: Record<string, unknown> }>> {
  const records = new Map<string, { cid: string; value: Record<string, unknown> }>();
  let cursor: string | undefined;
  while (true) {
    const params = new URLSearchParams({
      repo: session.did,
      collection,
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const resp = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.listRecords?${params}`, {
      headers: { authorization: `Bearer ${session.accessJwt}` },
    });
    if (!resp.ok) {
      throw new Error(`listRecords failed (${resp.status}): ${await resp.text()}`);
    }
    const data = await resp.json();
    for (const record of data.records ?? []) {
      const rkey = String(record.uri).split("/").at(-1);
      if (rkey) records.set(rkey, { cid: record.cid, value: record.value });
    }
    if (!data.cursor || (data.records?.length ?? 0) === 0) break;
    cursor = data.cursor;
  }
  return records;
}

export async function createRecord(
  session: Session,
  collection: string,
  rkey: string,
  record: object,
): Promise<CreateRecordResult> {
  const resp = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({ repo: session.did, collection, rkey, record }),
  });
  if (!resp.ok) {
    throw new Error(`createRecord failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  return { uri: data.uri, cid: data.cid };
}

export async function putRecord(
  session: Session,
  collection: string,
  rkey: string,
  record: object,
  swapRecord?: string,
): Promise<CreateRecordResult> {
  const resp = await fetch(`${PDS_URL}/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection,
      rkey,
      record,
      ...(swapRecord && { swapRecord }),
    }),
  });
  if (!resp.ok) {
    throw new Error(`putRecord failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  return { uri: data.uri, cid: data.cid };
}
