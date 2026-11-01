import { apiRoute } from "@/server/http";
import { carWarning } from "@/server/services/car";

/** ?date&time&lat&lng&exclude: a warning for the booking form when the car is asked for. */
export const GET = apiRoute(async ({ req, user }) => {
  const q = new URL(req.url).searchParams;
  return carWarning(user, { date: q.get("date"), time: q.get("time"), lat: q.get("lat"), lng: q.get("lng"), area: q.get("area"), exclude: q.get("exclude") });
});
