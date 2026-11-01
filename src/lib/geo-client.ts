"use client";

export type GeoReading = { geo: { lat: number; lng: number; acc: number } | null; error: "denied" | "unavailable" | null };

/**
 * The phone's current position from the browser (the user is asked the first time). Never
 * invented: without permission, a secure page (HTTPS) or a fix within the timeout, `geo` is null.
 */
export function currentPosition(timeoutMs = 12_000): Promise<GeoReading> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve({ geo: null, error: "unavailable" });
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ geo: { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }, error: null }),
      (e) => resolve({ geo: null, error: e.code === e.PERMISSION_DENIED ? "denied" : "unavailable" }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    ),
  );
}
