import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight, MessageCircle, Phone, UserX } from "lucide-react";
import { CopyButton } from "@/components/day-plan/copy-button";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Ltr } from "@/components/ui/ltr";
import { Badge, EmptyState, PageHeader, StatusBadge } from "@/components/ui/misc";
import { LOCALES, LOCALE_NAMES, isLocale } from "@/i18n/config";
import { getI18n, type ServerI18n } from "@/i18n/server";
import { addDaysToKey, isValidDateString, todayKey } from "@/lib/time";
import { requirePagePermission } from "@/server/auth/session";
import { dayPlan, type DayPlanVisit } from "@/server/services/day-plan";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("plan.title") };
}

function VisitRow({ v, i18n }: { v: DayPlanVisit; i18n: ServerI18n }) {
  const { t, label, sn } = i18n;
  return (
    <li className="space-y-1 px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Ltr className="font-medium tabular-nums text-fg">{v.time}</Ltr>
        <Link href={`/appointments/${v.id}`} prefetch={false} className="font-mono text-brand-text hover:underline">
          <Ltr>{v.code}</Ltr>
        </Link>
        <StatusBadge name={sn(v.status)} color={v.status.color} />
        <Badge className={cn(!v.confirmed && "border-warning/40 bg-warning-soft text-fg")}>{label("confirmation", v.confirmation)}</Badge>
      </div>
      <p className="text-fg">
        {v.customerName} <span className="text-fg-muted">· {v.what}</span>
      </p>
      {v.address && <p className="text-fg-muted">{v.address}</p>}
      {v.reminderLink && (
        <a href={v.reminderLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline">
          <MessageCircle className="h-3.5 w-3.5" /> {t("plan.remind", { name: v.customerName.split(" ")[0] ?? v.customerName })}
        </a>
      )}
    </li>
  );
}

export default async function DayPlanPage({ searchParams }: { searchParams: Promise<{ date?: string; lang?: string }> }) {
  const user = await requirePagePermission("appointments.manage");
  const sp = await searchParams;
  const i18n = await getI18n();
  const { t } = i18n;
  const tz = user.settings.timezone;
  const date = sp.date && isValidDateString(sp.date) ? sp.date : addDaysToKey(todayKey(tz), 1);
  // Messages default to the reader's language; the technician may prefer the other one.
  const lang = isLocale(sp.lang) ? sp.lang : i18n.locale;
  const plan = await dayPlan(user, date, lang);
  const href = (d: string) => `/day-plan?date=${d}${sp.lang ? `&lang=${lang}` : ""}`;

  return (
    <>
      <PageHeader
        title={t("plan.title")}
        description={t("plan.desc")}
        actions={
          <>
            <Link href={href(addDaysToKey(date, -1))} className={buttonClasses("outline", "sm")} aria-label={t("plan.previousDay")}>
              <ChevronLeft className="h-4 w-4 rtl:-scale-x-100" />
            </Link>
            <form method="get" className="flex flex-wrap items-center gap-2">
              <input type="date" name="date" defaultValue={date} aria-label={t("plan.day")} className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg" />
              <select name="lang" defaultValue={lang} aria-label={t("plan.messageLanguage")} className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm text-fg">
                {LOCALES.map((l) => (
                  <option key={l} value={l} lang={l}>
                    {LOCALE_NAMES[l]}
                  </option>
                ))}
              </select>
              <button className={buttonClasses("outline", "sm")}>{t("plan.show")}</button>
            </form>
            <Link href={href(addDaysToKey(date, 1))} className={buttonClasses("outline", "sm")} aria-label={t("plan.nextDay")}>
              <ChevronRight className="h-4 w-4 rtl:-scale-x-100" />
            </Link>
          </>
        }
      />
      <h2 className="mb-4 text-lg font-semibold text-fg">
        {i18n.f.day(date, { weekday: "long", day: "numeric", month: "long" })} · {t("common.visitsCount", { count: plan.visits })}
      </h2>

      {plan.visits === 0 && (
        <Card>
          <EmptyState title={t("plan.empty")} description={t("plan.emptyHint")} />
        </Card>
      )}

      {plan.unassigned.length > 0 && (
        <Card className="mb-6 border-warning/50">
          <CardHeader title={t("plan.unassigned")} description={t("plan.unassignedHint")} icon={<UserX className="h-4 w-4" />} />
          <ul className="divide-y divide-line">
            {plan.unassigned.map((v) => (
              <VisitRow key={v.id} v={v} i18n={i18n} />
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {plan.technicians.map((tech) => (
          <Card key={tech.id} className="overflow-hidden" data-testid="day-plan-technician">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-fg">{tech.name}</p>
                <p className="text-xs text-fg-muted">
                  {t("common.visitsCount", { count: tech.visits.length })}
                  {tech.phone ? (
                    <>
                      {" · "}
                      <a href={`tel:${tech.phone.replace(/[^\d+]/g, "")}`} className="inline-flex items-center gap-1 hover:underline">
                        <Phone className="h-3 w-3" /> <Ltr>{tech.phone}</Ltr>
                      </a>
                    </>
                  ) : (
                    t("plan.noPhone")
                  )}
                </p>
              </div>
              <a href={tech.link} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "sm")}>
                <MessageCircle className="h-3.5 w-3.5" /> {t("plan.whatsapp")}
              </a>
              <CopyButton text={tech.message} />
            </div>
            <ul className="divide-y divide-line">
              {tech.visits.map((v) => (
                <VisitRow key={v.id} v={v} i18n={i18n} />
              ))}
            </ul>
            <details className="border-t border-line px-5 py-3">
              <summary className="cursor-pointer text-sm font-medium text-fg-muted">{t("plan.preview")}</summary>
              <pre dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-fg">
                {tech.message}
              </pre>
            </details>
          </Card>
        ))}
      </div>
    </>
  );
}
