export const DEFAULT_PDS_URL = "https://bsky.social";

export interface BskyConfig {
  handle: string;
  appPassword: string;
  pdsUrl?: string;
}

export interface Session {
  accessJwt: string;
  did: string;
  pdsUrl: string;
}

/**
 * Creates a fresh PDS session. No caching: callers hold the returned Session
 * and call this again if they need to re-authenticate.
 */
export async function getSession(config: BskyConfig): Promise<Session> {
  if (!config.handle || !config.appPassword) {
    throw new Error("Bluesky handle and app password are required");
  }
  const pdsUrl = config.pdsUrl || DEFAULT_PDS_URL;
  const resp = await fetch(`${pdsUrl}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: config.handle, password: config.appPassword }),
  });
  if (!resp.ok) {
    throw new Error(`createSession failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json() as { accessJwt: string; did: string };
  return { accessJwt: data.accessJwt, did: data.did, pdsUrl };
}

export async function uploadBlob(
  session: Session,
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
): Promise<object> {
  const resp = await fetch(`${session.pdsUrl}/xrpc/com.atproto.repo.uploadBlob`, {
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
  const data = await resp.json() as { blob: object };
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
    const resp = await fetch(`${session.pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`, {
      headers: { authorization: `Bearer ${session.accessJwt}` },
    });
    if (!resp.ok) {
      throw new Error(`listRecords failed (${resp.status}): ${await resp.text()}`);
    }
    const data = await resp.json() as { cursor?: string; records?: { uri: string; cid: string; value: Record<string, unknown> }[] };
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
  const resp = await fetch(`${session.pdsUrl}/xrpc/com.atproto.repo.createRecord`, {
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
  const data = await resp.json() as CreateRecordResult;
  return { uri: data.uri, cid: data.cid };
}

export async function putRecord(
  session: Session,
  collection: string,
  rkey: string,
  record: object,
  swapRecord?: string,
): Promise<CreateRecordResult> {
  const resp = await fetch(`${session.pdsUrl}/xrpc/com.atproto.repo.putRecord`, {
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
  const data = await resp.json() as CreateRecordResult;
  return { uri: data.uri, cid: data.cid };
}

/**
 * Fetches a single record, or returns null if it doesn't exist.
 */
export async function getRecord(
  session: Session,
  collection: string,
  rkey: string,
): Promise<CreateRecordResult | null> {
  const params = new URLSearchParams({ repo: session.did, collection, rkey });
  const resp = await fetch(`${session.pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`, {
    headers: { authorization: `Bearer ${session.accessJwt}` },
  });
  if (resp.ok) {
    const data = await resp.json() as { uri: string; cid: string };
    return { uri: data.uri, cid: data.cid };
  }
  const body = await resp.text();
  // The PDS reports a missing record as 400 RecordNotFound (some return 404)
  if (resp.status === 404 || body.includes("RecordNotFound")) return null;
  throw new Error(`getRecord failed (${resp.status}): ${body}`);
}
