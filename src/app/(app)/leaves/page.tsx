import { redirect } from "next/navigation";
import { LeavesManager } from "@/components/leaves/leaves-manager";
import { PageHeader } from "@/components/ui/misc";
import { requireUser } from "@/server/auth/session";
import { leaveOverview } from "@/server/services/leaves";
import { activeTechnicians } from "@/server/services/users";

export const metadata = { title: "Leave" };

export default async function LeavesPage() {
  const user = await requireUser();
  const manage = user.permissions.includes("leaves.manage");
  if (!manage && !user.permissions.includes("leaves.request")) redirect("/access-denied");
  const [overview, technicians] = await Promise.all([leaveOverview(user), manage ? activeTechnicians() : Promise.resolve([])]);
  return (
    <>
      <PageHeader
        title={manage ? "Technician leave" : "My leave"}
        description={
          manage
            ? "Approve leave requests and record sick days or absences. Approved leave stops new bookings of that technician on those days."
            : "Ask for leave or a day off. Once an Admin approves it, you will not be booked on those days."
        }
      />
      <LeavesManager overview={overview} technicians={technicians.map((t) => ({ id: t.id, name: t.name }))} manage={manage} timezone={user.settings.timezone} />
    </>
  );
}
