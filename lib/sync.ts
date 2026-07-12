import { type FsqCheckin } from "./foursquare.ts";
import { fetchPhoto } from "./photos.ts";
import { uploadBlob, createRecord, type Session } from "./atproto.ts";

export interface SyncResult {
  uri: string;
  cid: string;
  photosUploaded: number;
}

export async function syncCheckin(
  session: Session,
  checkin: FsqCheckin,
): Promise<SyncResult> {
  const location: Record<string, string> = {
    "$type": "community.lexicon.location.fsq",
    fsq_place_id: checkin.venue.id,
    name: checkin.venue.name,
  };
  if (checkin.venue.location?.lat != null && checkin.venue.location?.lng != null) {
    location.latitude = String(checkin.venue.location.lat);
    location.longitude = String(checkin.venue.location.lng);
  }

  const formattedAddress = checkin.venue.location?.formattedAddress;
  const address = formattedAddress?.length ? formattedAddress.join(", ") : undefined;
  const category = checkin.venue.categories?.[0]?.name;
  const comment = checkin.shout?.trim();

  const photos: object[] = [];
  for (const photo of checkin.photos?.items ?? []) {
    const fetched = await fetchPhoto(photo);
    if (!fetched) continue;
    try {
      const blobRef = await uploadBlob(session, fetched.bytes, fetched.mimeType);
      photos.push({ image: blobRef });
    } catch (err) {
      console.warn(`Photo upload failed for checkin ${checkin.id}:`, err);
    }
  }

  const record: Record<string, unknown> = {
    "$type": "com.barryfrost.checkin",
    createdAt: new Date(checkin.createdAt * 1000).toISOString(),
    location,
    ...(address && { address }),
    ...(category && { category }),
    ...(comment && { comment }),
  };
  if (photos.length > 0) {
    record.photos = photos;
  }

  const { uri, cid } = await createRecord(
    session,
    "com.barryfrost.checkin",
    checkin.id,
    record,
  );

  return { uri, cid, photosUploaded: photos.length };
}
