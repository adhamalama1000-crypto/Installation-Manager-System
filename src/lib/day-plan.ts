/**
 * WhatsApp texts for the day plan (Aura: خطة اليوم), in Arabic or English. Pure functions so the
 * browser and tests share them. Nothing is sent automatically: the links open WhatsApp with the
 * text filled in, for the user to review and send.
 */
import type { Locale } from "@/i18n/config";
import { createFormatter } from "@/i18n/format";
import { translate } from "@/i18n/translate";

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
  /** The lock / devices wait at the office and must be picked up first. */
  pickupAtOffice?: boolean;
};

export function technicianMessage(name: string, dayLabel: string, visits: PlanVisit[], locale: Locale = "en"): string {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params);
  const f = createFormatter(locale, "UTC");
  const lines = [t("wa.tech.greeting", { name: name.split(" ")[0] ?? name }), t("wa.tech.intro", { day: dayLabel }), ""];
  visits.forEach((v, i) => {
    lines.push(`${i + 1}) ⏰ ${v.time} · ${v.what}`);
    lines.push(`👤 ${v.customerName}${v.customerPhone ? ` · 📞 ${v.customerPhone}` : ""}`);
    if (v.address) lines.push(`📍 ${v.address}`);
    if (v.mapLink) lines.push(`🗺️ ${v.mapLink}`);
    if (v.equipment) lines.push(`🔧 ${v.equipment}`);
    if (v.pickupAtOffice) lines.push(t("wa.tech.pickup"));
    if (v.toCollect) lines.push(t("wa.tech.toCollect", { amount: f.money(v.toCollect) }));
    if (v.notes) lines.push(`📝 ${v.notes}`);
    if (v.withOthers.length) lines.push(t("wa.tech.with", { names: v.withOthers.join(f.sep) }));
    lines.push(`#${v.code}`, "");
  });
  lines.push(t("wa.tech.footer"));
  return lines.join("\n");
}

export function customerReminder(
  customerName: string,
  dayLabel: string,
  time: string,
  what: string,
  company: string,
  locale: Locale = "en",
  kind?: "lock" | "smart",
): string {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params);
  return [
    t("wa.cust.hello", { name: customerName }),
    t("wa.cust.intro", { company, what: locale === "en" ? what.toLowerCase() : what, day: dayLabel, time }),
    t("wa.cust.ready"),
    ...(kind === "lock" ? [t("wa.cust.readyLock")] : kind === "smart" ? [t("wa.cust.readySmart")] : []),
    t("wa.cust.change"),
  ].join("\n");
}
