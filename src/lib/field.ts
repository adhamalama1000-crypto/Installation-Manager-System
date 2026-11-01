/**
 * Field-work rules from Aura (Code.gs checkin_, etaMin_, attendance_, api_stats), as pure
 * functions shared by the server and the browser.
 */

export type Geo = { lat: number; lng: number };

/** Reasons a technician can give for a problem at a visit; the first four are the customer's fault (Aura CLIENT_FAULT). */
export const PROBLEM_REASONS = ["customerAbsent", "customerLate", "siteNotReady", "customerPostponed", "missingParts"] as const;
export type ProblemReason = (typeof PROBLEM_REASONS)[number];
export const CLIENT_FAULT: readonly ProblemReason[] = ["customerAbsent", "customerLate", "siteNotReady", "customerPostponed"];

/** Check-ins further than this from the company or the customer's pin are flagged. */
export const FAR_FROM_COMPANY_M = 400;
export const FAR_FROM_CUSTOMER_M = 300;

/** Great-circle distance in whole metres. */
export function distanceM(a: Geo, b: Geo): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/**
 * Minutes to drive from `from` to `to` leaving at `hour` (0-23): the straight line × 1.4 at Cairo
 * speeds by time of day, plus 5 minutes to park (Aura etaMin_).
 */
export function etaMinutes(from: Geo, to: Geo, hour: number): number {
  const km = (distanceM(from, to) / 1000) * 1.4;
  const speed = hour < 7 ? 35 : hour < 10 ? 22 : hour < 15 ? 25 : hour < 20 ? 17 : 30;
  return Math.round((km / speed) * 60 + 5);
}

/** "HH:MM" → minutes after midnight. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

/** The order of the visit stages a technician records (DONE and START also come with the outcome). */
export const VISIT_STAGES = ["PICKUP", "READY", "DEPART", "ARRIVE", "START", "DONE"] as const;

export type PointsInput = {
  /** Visits the technician arrived at, and how many of those within 15 minutes of the start. */
  arrived: number;
  onTime: number;
  ratingAvg: number | null;
  gradeAvg: number | null;
  done: number;
  revisits: number;
  complaints: number;
  lateDays: number;
  absences: number;
};

/**
 * Monthly points (Aura api_stats): up to 40 for punctuality, 30 from customer ratings, 20 from the
 * quality grade and 10 for finished visits; minus 5 per revisit, 10 per complaint, 2 per late day
 * and 5 per absence; never below zero.
 */
export function monthlyPoints(p: PointsInput): number {
  let pts = 0;
  if (p.arrived) pts += Math.round((40 * p.onTime) / p.arrived);
  if (p.ratingAvg !== null) pts += Math.round((30 * p.ratingAvg) / 5);
  if (p.gradeAvg !== null) pts += Math.round((20 * p.gradeAvg) / 5);
  pts += Math.min(10, p.done);
  pts -= 5 * p.revisits + 10 * p.complaints + 2 * p.lateDays + 5 * p.absences;
  return Math.max(0, pts);
}
