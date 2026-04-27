import { photoUrl, type FsqPhoto } from "./foursquare.ts";

const MAX_PHOTO_BYTES = 1_000_000;

export interface FetchedPhoto {
  bytes: Uint8Array;
  mimeType: string;
}

export async function fetchPhoto(photo: FsqPhoto): Promise<FetchedPhoto | null> {
  const url = photoUrl(photo);
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`Photo fetch failed (${resp.status}): ${url}`);
      return null;
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength > MAX_PHOTO_BYTES) {
      console.warn(`Photo too large (${bytes.byteLength} bytes), skipping: ${url}`);
      return null;
    }
    const mimeType = resp.headers.get("content-type")?.split(";")[0].trim() ?? "image/jpeg";
    return { bytes, mimeType };
  } catch (err) {
    console.warn(`Photo fetch error for ${url}:`, err);
    return null;
  }
}
