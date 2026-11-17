import { isValidDateString } from "@/lib/time";
import { apiRoute } from "@/server/http";
import { companySchedule, SCHEDULE_VIEWS, todayIn, type ScheduleView } from "@/server/services/company-schedule";

/** The company schedule (schedule.global): ?view=day|week|month&date=&technicianId=&visitType=&statusId= */
export const GET = apiRoute(async ({ req, user }) => {
  const sp = new URL(req.url).searchParams;
  const view = (SCHEDULE_VIEWS as readonly string[]).includes(sp.get("view") ?? "") ? (sp.get("view") as ScheduleView) : "day";
  const date = sp.get("date") && isValidDateString(sp.get("date")!) ? sp.get("date")! : todayIn(user);
  return companySchedule(user, { view, date, technicianId: sp.get("technicianId"), visitType: sp.get("visitType"), statusId: sp.get("statusId") });
});
