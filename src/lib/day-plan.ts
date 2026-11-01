/**
 * WhatsApp texts for the day plan (Aura: خطة اليوم). Pure functions so the browser and tests share
 * them. Nothing is sent automatically: the links open WhatsApp with the text filled in.
 */
import type { T } from "@/i18n/translator";
import { money } from "./constants";

/** Numbers without a country code are Egyptian (the company is in Cairo): 010… → 2010…. */
const DEFAULT_COUNTRY_CODE = "20";

/** Digits for wa.me: "+20 100 123 4567" and "0100 123 4567" both become "201001234567". */
export function whatsappNumber(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.startsWith("0")) return DEFAULT_COUNTRY_CODE + digits.slice(1);
  return digits;
}

/** A wa.me link; without a number WhatsApp asks who to send it to. */
export function whatsappLink(phone: string | null | undefined, text: string): string {
  return `https://wa.me/${whatsappNumber(phone)}?text=${encodeURIComponent(text)}`;
}

export type PlanVisit = {
  code: string;
  time: string;
  what: string;
  customerName: string;
  customerPhone: string | null;
  address: string;
  mapLink: string | null;
  equipment: string | null;
  notes: string | null;
  toCollect: number | null;
  withOthers: string[];
};

/** Texts are in the sender's language (`t`). */
export function technicianMessage(t: T, name: string, dayLabel: string, visits: PlanVisit[]): string {
  const lines = [t("dayPlanText.greeting", { name: name.split(" ")[0] }), t("dayPlanText.yourVisits", { day: dayLabel }), ""];
  visits.forEach((v, i) => {
    lines.push(`${i + 1}) ⏰ ${v.time} · ${v.what}`);
    lines.push(`👤 ${v.customerName}${v.customerPhone ? ` · 📞 ${v.customerPhone}` : ""}`);
    if (v.address) lines.push(`📍 ${v.address}`);
    if (v.mapLink) lines.push(`🗺️ ${v.mapLink}`);
    if (v.equipment) lines.push(`🔧 ${v.equipment}`);
    if (v.toCollect) lines.push(t("dayPlanText.toCollect", { amount: money(v.toCollect, t.locale) }));
    if (v.notes) lines.push(`📝 ${v.notes}`);
    if (v.withOthers.length) lines.push(t("dayPlanText.with", { names: v.withOthers.join(t.locale === "ar" ? "، " : ", ") }));
    lines.push(`#${v.code}`, "");
  });
  lines.push(t("dayPlanText.confirm"));
  return lines.join("\n");
}

export function customerReminder(t: T, customerName: string, dayLabel: string, time: string, what: string, company: string): string {
  return [
    t("dayPlanText.hello", { name: customerName }),
    t("dayPlanText.reminder", { company, what: t.locale === "en" ? what.toLowerCase() : what, day: dayLabel, time }),
    t("dayPlanText.siteReady"),
    t("dayPlanText.reply"),
  ].join("\n");
}
