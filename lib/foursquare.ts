const FSQ_API_BASE = "https://api.foursquare.com/v2";

export interface FsqPhoto {
  prefix: string;
  suffix: string;
}

export interface FsqCheckin {
  id: string;
  createdAt: number; // unix seconds
  venue: {
    id: string;
    name: string;
    location?: {
      lat?: number;
      lng?: number;
      formattedAddress?: string[];
    };
    categories?: { name: string }[];
  };
  photos?: {
    count: number;
    items: FsqPhoto[];
  };
}

export async function getCheckins(
  oauthToken: string,
  apiVersion: string,
  offset = 0,
  limit = 50,
): Promise<FsqCheckin[]> {
  const params = new URLSearchParams({
    oauth_token: oauthToken,
    v: apiVersion,
    limit: String(limit),
    offset: String(offset),
  });
  const resp = await fetch(`${FSQ_API_BASE}/users/self/checkins?${params}`);
  if (!resp.ok) {
    throw new Error(`FSQ API error ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  if (data.meta?.code !== 200) {
    throw new Error(`FSQ API returned non-200: ${JSON.stringify(data.meta)}`);
  }
  return (data.response?.checkins?.items ?? []) as FsqCheckin[];
}

export function photoUrl(photo: FsqPhoto, size = "1024x1024"): string {
  return `${photo.prefix}${size}${photo.suffix}`;
}
