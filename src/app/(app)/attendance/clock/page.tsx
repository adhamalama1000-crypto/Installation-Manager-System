import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/misc";
import { ClockPanel } from "@/components/attendance/clock-panel";
import { getT } from "@/i18n/server";
import { requireUser } from "@/server/auth/session";
import { canClock, clockState } from "@/server/services/attendance";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("clock.title") };
}

export default async function ClockPage() {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  if (!canClock(user)) redirect("/access-denied");
  const state = await clockState(user);
  return (
    <>
      <PageHeader title={t("clock.title")} />
      <div className="max-w-3xl">
        <ClockPanel state={state} tz={user.settings.timezone} />
      </div>
    </>
  );
}
