/**
 * WhatsApp texts for the day plan (Aura: خطة اليوم). Pure functions so the browser and tests share
 * them. Nothing is sent automatically: the links open WhatsApp with the text filled in.
 */
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

export function technicianMessage(name: string, dayLabel: string, visits: PlanVisit[]): string {
  const lines = [`Good morning ${name.split(" ")[0]} 👋`, `Your visits for ${dayLabel}:`, ""];
  visits.forEach((v, i) => {
    lines.push(`${i + 1}) ⏰ ${v.time} · ${v.what}`);
    lines.push(`👤 ${v.customerName}${v.customerPhone ? ` · 📞 ${v.customerPhone}` : ""}`);
    if (v.address) lines.push(`📍 ${v.address}`);
    if (v.mapLink) lines.push(`🗺️ ${v.mapLink}`);
    if (v.equipment) lines.push(`🔧 ${v.equipment}`);
    if (v.toCollect) lines.push(`💰 To collect: ${money(v.toCollect)}`);
    if (v.notes) lines.push(`📝 ${v.notes}`);
    if (v.withOthers.length) lines.push(`👷 With: ${v.withOthers.join(", ")}`);
    lines.push(`#${v.code}`, "");
  });
  lines.push("Please confirm you received this. Thank you 🙏");
  return lines.join("\n");
}

export function customerReminder(customerName: string, dayLabel: string, time: string, what: string, company: string): string {
  return [
    `Hello ${customerName} 👋`,
    `This is ${company}. A reminder of your ${what.toLowerCase()} visit on ${dayLabel} at ${time}.`,
    "Please make sure someone is at the location and the site is ready (power on, Wi-Fi password at hand).",
    "If you need another time, just reply to this message. Thank you 🙏",
  ].join("\n");
}
