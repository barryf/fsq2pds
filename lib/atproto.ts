const PDS_URL = Deno.env.get("BSKY_PDS_URL") ?? "https://bsky.social";

interface Session {
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
