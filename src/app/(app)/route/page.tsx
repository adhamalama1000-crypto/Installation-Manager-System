import Link from "next/link";
import type { Metadata } from "next";
import { RouteView } from "@/components/car/route-view";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { PageHeader } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { formatKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import { requirePagePermission } from "@/server/auth/session";
import { getRoute, routeDays } from "@/server/services/car";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.route") };
}

export default async function RoutePage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("route.view"), getT()]);
  const tz = user.settings.timezone;
  const sp = await searchParams;
  const route = await getRoute(user, sp.day);
  const days = routeDays(tz);
  return (
    <>
      <AutoRefresh />
      <PageHeader title={t("car.title")} description={t("car.text")} />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label={t("car.day")}>
        {days.map((d) => (
          <Link
            key={d}
            href={`/route?day=${d}`}
            aria-current={d === route.day ? "page" : undefined}
            className={cn("rounded-full border px-3.5 py-1.5 text-sm font-medium", d === route.day ? "border-brand bg-brand-soft text-fg" : "border-line text-fg-muted hover:bg-surface-muted")}
          >
            {formatKey(d, { weekday: "short", day: "numeric", month: "short" }, t.locale)}
          </Link>
        ))}
      </nav>
      <RouteView route={route} tz={tz} />
    </>
  );
}
