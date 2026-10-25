/**
 * Map-link handling. A Sales user can paste any map link (Google Maps, Apple Maps, Waze, ...);
 * it is stored exactly as entered once validated. Only http(s) URLs without embedded credentials
 * are accepted, so a link can never run script (javascript:, data:, ...) when opened.
 */

const KNOWN_MAP_HOSTS = [
  "google.com",
  "maps.google.com",
  "www.google.com",
  "goo.gl",
  "maps.app.goo.gl",
  "g.co",
  "maps.apple.com",
  "waze.com",
  "www.waze.com",
  "ul.waze.com",
  "openstreetmap.org",
  "www.openstreetmap.org",
  "bing.com",
  "www.bing.com",
];

export type MapUrlCheck = { ok: true; url: string; host: string; knownHost: boolean } | { ok: false; error: string };

export function checkMapUrl(raw: string): MapUrlCheck {
  const value = raw.trim();
  if (!value) return { ok: false, error: "Map link is empty." };
  if (value.length > 2048) return { ok: false, error: "Map link is too long." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "Enter a full link starting with https://" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Only http(s) map links are allowed." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Map link must not contain credentials." };
  }
  const host = url.hostname.toLowerCase();
  const knownHost = KNOWN_MAP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  return { ok: true, url: value, host, knownHost };
}

export function isValidLatitude(v: number): boolean {
  return Number.isFinite(v) && v >= -90 && v <= 90;
}

export function isValidLongitude(v: number): boolean {
  return Number.isFinite(v) && v >= -180 && v <= 180;
}

export function coordinatesMapUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/**
 * Tries to read coordinates out of common Google Maps URL formats
 * (".../@30.0444,31.2357,17z", "?q=30.0444,31.2357", "?query=...", "ll=").
 * Short links (maps.app.goo.gl) cannot be resolved without a network call and return null.
 */
export function extractCoordinates(raw: string): { latitude: number; longitude: number } | null {
  const candidates: string[] = [];
  try {
    const url = new URL(raw.trim());
    for (const key of ["q", "query", "ll", "destination", "daddr"]) {
      const v = url.searchParams.get(key);
      if (v) candidates.push(v);
    }
    candidates.push(decodeURIComponent(url.pathname));
  } catch {
    return null;
  }
  for (const c of candidates) {
    const m = c.match(/@?(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/);
    if (m) {
      const latitude = Number(m[1]);
      const longitude = Number(m[2]);
      if (isValidLatitude(latitude) && isValidLongitude(longitude) && (m[1]!.includes(".") || m[2]!.includes("."))) {
        return { latitude, longitude };
      }
    }
  }
  return null;
}

/**
 * The link the "Open Location" button uses: the saved URL when present (unchanged), otherwise a
 * Google Maps link built from saved coordinates, otherwise null (no location added yet).
 */
export function resolveLocationLink(loc: {
  mapUrl?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
}): string | null {
  if (loc.mapUrl) {
    const check = checkMapUrl(loc.mapUrl);
    if (check.ok) return check.url;
  }
  if (loc.latitude != null && loc.longitude != null) {
    const lat = Number(loc.latitude);
    const lng = Number(loc.longitude);
    if (isValidLatitude(lat) && isValidLongitude(lng)) return coordinatesMapUrl(lat, lng);
  }
  return null;
}
