import Link from "next/link";
import type { Metadata } from "next";
import { Phone, Radar } from "lucide-react";
import { AutoRefresh } from "@/components/layout/auto-refresh";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import type { T } from "@/i18n/translator";
import { longDate } from "@/lib/format";
import { timeKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import { requirePagePermission } from "@/server/auth/session";
import { liveBoard, type BoardRow, type BoardTone } from "@/server/services/field";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.board") };
}

const tones: Record<BoardTone, string> = {
  red: "border-s-danger",
  yellow: "border-s-warning",
  green: "border-s-success",
  grey: "border-s-line-strong",
};
const dots: Record<BoardTone, string> = { red: "bg-danger", yellow: "bg-warning", green: "bg-success", grey: "bg-line-strong" };

function stateText(r: BoardRow, t: T, tz: string): string {
  const at = (iso: string | null) => (iso ? timeKey(iso, tz) : "");
  const where = r.current ? [r.current.customerName, r.current.area].filter(Boolean).join(" · ") : "";
  switch (r.state) {
    case "leave":
      return r.visits.length ? t("board.leaveWithVisits", { type: t.dyn(`enums.leaveType.${r.leaveType}`), count: r.visits.length }) : t.dyn(`enums.leaveType.${r.leaveType}`);
    case "problem":
      return t("board.problem", { where, reason: t.dyn(`field.reasons.${r.problemReason}`) });
    case "atClient":
      return t(r.visits.some((v) => v.stages.START && !v.closed) ? "board.working" : "board.arrived", { where, time: at(r.since) }) + (r.far ? ` · ${t("board.far")}` : "");
    case "onWay":
      return r.etaAt ? t("board.onWayEta", { where, time: at(r.etaAt) }) : t("board.onWay", { where });
    case "finished":
      return t("board.finished", { count: r.visits.length });
    case "atCompany":
      return t("board.atCompany", { time: at(r.since) }) + (r.companyFar ? ` · ${t("board.far")}` : "");
    case "notYet":
      return t("board.notYet");
    default:
      return t("board.free");
  }
}

export default async function BoardPage() {
  const [user, t] = await Promise.all([requirePagePermission("board.view"), getT()]);
  const tz = user.settings.timezone;
  const board = await liveBoard(user);
  return (
    <>
      <AutoRefresh />
      <PageHeader title={t("board.title")} description={`${longDate(new Date(), tz, t.locale)} · ${t("board.text")}`} />
      {board.rows.length === 0 ? (
        <Card>
          <EmptyState title={t("board.noTechnicians")} icon={<Radar className="h-6 w-6" />} />
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {board.rows.map((r) => (
            <li key={r.technician.id} className={cn("rounded-xl border border-line border-s-4 bg-surface p-4 shadow-card", tones[r.tone])}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 font-semibold text-fg">
                  <span className={cn("h-2.5 w-2.5 rounded-full", dots[r.tone])} aria-hidden />
                  {r.technician.name}
                  <span className="sr-only">{t.dyn(`board.tone.${r.tone}`)}</span>
                </p>
                {r.technician.phone && (
                  <a href={`tel:${r.technician.phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 text-sm text-brand-text hover:underline">
                    <Phone className="h-4 w-4" /> <bdi dir="ltr">{r.technician.phone}</bdi>
                  </a>
                )}
              </div>
              <p className="mt-1 text-sm text-fg">{stateText(r, t, tz)}</p>
              {r.next && r.state !== "onWay" && (
                <p className="mt-0.5 text-xs text-fg-muted">
                  {t("board.next", { time: timeKey(r.next.startsAt, tz), where: [r.next.customerName, r.next.area].filter(Boolean).join(" · ") })}
                </p>
              )}
              {r.visits.length > 0 && (
                <ol className="mt-3 space-y-1.5 border-t border-line pt-3">
                  {r.visits.map((v) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <bdi className="tabular-nums text-fg-muted">{timeKey(v.startsAt, tz)}</bdi>
                      <Link href={`/appointments/${v.id}`} className={cn("font-medium hover:underline", v.closed ? "text-fg-subtle line-through" : "text-fg")}>
                        {v.customerName}
                      </Link>
                      {(["COMPANY", "PICKUP", "READY", "DEPART", "ARRIVE", "START", "PROBLEM", "DONE"] as const)
                        .filter((k) => v.stages[k])
                        .map((k) => (
                          <span key={k} className={cn("rounded-full px-1.5 py-0.5", k === "PROBLEM" ? "bg-danger-soft text-danger" : v.stages[k]!.far ? "bg-warning-soft text-warning" : "bg-surface-muted text-fg-muted")}>
                            {t.dyn(`field.stageShort.${k}`)} <bdi>{timeKey(v.stages[k]!.at, tz)}</bdi>
                          </span>
                        ))}
                    </li>
                  ))}
                </ol>
              )}
              {r.positionAgeMin !== null && r.state === "onWay" && <p className="mt-2 text-[11px] text-fg-subtle">{t("board.positionAge", { minutes: r.positionAgeMin })}</p>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
