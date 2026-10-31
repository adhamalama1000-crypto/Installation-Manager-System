import { describe, expect, it } from "vitest";
import { localeFromCookieHeader, dirOf } from "@/i18n/config";
import { ar } from "@/i18n/messages/ar";
import { en } from "@/i18n/messages/en";
import { createT, msg } from "@/i18n/translator";
import { CONFIRMATIONS, LEAVE_TYPES, PAYMENT_METHODS, PRODUCT_CATEGORIES, ROLES, STATUS_KINDS, STOCK_STATUSES, VISIT_TYPES, money } from "@/lib/constants";
import { VIEWER_GRANTABLE } from "@/lib/permissions";
import { fmt, formatKey } from "@/lib/time";

type Tree = { [k: string]: string | Tree };

/** Every leaf as "path" -> text (plural forms as "path#form"). */
function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(path, v);
    else if ("other" in v && typeof v.other === "string") for (const [form, text] of Object.entries(v)) out.set(`${path}#${form}`, text as string);
    else for (const [p, text] of leaves(v, path)) out.set(p, text);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("dictionaries", () => {
  const enLeaves = leaves(en as unknown as Tree);
  const arLeaves = leaves(ar as unknown as Tree);
  const base = (p: string) => p.split("#")[0]!;

  it("have the same messages in both languages", () => {
    expect([...new Set([...arLeaves.keys()].map(base))].sort()).toEqual([...new Set([...enLeaves.keys()].map(base))].sort());
  });

  it("use the same placeholders in both languages", () => {
    const enByKey = new Map<string, Set<string>>();
    for (const [p, text] of enLeaves) for (const name of placeholders(text)) (enByKey.get(base(p)) ?? enByKey.set(base(p), new Set()).get(base(p))!).add(name!);
    for (const [p, text] of arLeaves) {
      const allowed = enByKey.get(base(p)) ?? new Set();
      for (const name of placeholders(text)) expect(allowed.has(name!), `${p} uses {${name}}`).toBe(true);
    }
  });

  it("name every stored enum value", () => {
    const groups: [string, readonly string[]][] = [
      ["enums.role", ROLES],
      ["enums.statusKind", STATUS_KINDS],
      ["enums.productCategory", PRODUCT_CATEGORIES],
      ["enums.visitType", VISIT_TYPES],
      ["enums.confirmation", CONFIRMATIONS],
      ["enums.paymentMethod", PAYMENT_METHODS],
      ["enums.leaveType", LEAVE_TYPES],
      ["enums.stockStatus", STOCK_STATUSES],
    ];
    for (const t of [createT("ar"), createT("en")]) {
      for (const [prefix, values] of groups) for (const v of values) expect(t.dyn(`${prefix}.${v}`, undefined, "MISSING")).not.toBe("MISSING");
      for (const p of VIEWER_GRANTABLE) expect(t.dyn(`permissions.${p}.label`, undefined, "MISSING")).not.toBe("MISSING");
    }
  });
});

describe("translator", () => {
  const ar = createT("ar");
  const en = createT("en");

  it("picks Arabic plural forms", () => {
    expect(ar("common.visits", { count: 0 })).toBe(ar("common.visits", { count: 0 }));
    expect(ar("dashboard.appointmentsCount", { count: 1 })).toBe("موعد واحد");
    expect(ar("dashboard.appointmentsCount", { count: 2 })).toBe("موعدان");
    expect(ar("dashboard.appointmentsCount", { count: 5 })).toBe("5 مواعيد");
    expect(ar("dashboard.appointmentsCount", { count: 15 })).toBe("15 موعدًا");
    expect(en("dashboard.appointmentsCount", { count: 1 })).toBe("1 appointment");
    expect(en("dashboard.appointmentsCount", { count: 3 })).toBe("3 appointments");
  });

  it("translates encoded messages, nested messages and Arabic variants of names", () => {
    const text = msg("validation.required", { field: "@fields.customerName" });
    expect(en.msg(text)).toBe("Customer name is required");
    expect(ar.msg(text)).toBe("اسم العميل مطلوب");
    const status = msg("notify.statusChanged", { code: "APT-000001", status: "Completed", statusAr: "تم التنفيذ" });
    expect(en.msg(status)).toBe("APT-000001 status changed to Completed");
    expect(ar.msg(status)).toBe("حالة APT-000001 أصبحت تم التنفيذ");
    // Plain text (customer data, old rows) is shown as it is; so is a name that starts with "@".
    expect(ar.msg("Customer asked to call first")).toBe("Customer asked to call first");
    expect(en("audit.cancelledWithNote", { code: "X", note: "@home" })).toBe("Cancelled X: @home");
    // Several messages, one per line.
    expect(en.msg(`${msg("stockErrors.markedFaulty", { serial: "A1" })}\n${msg("stockErrors.notYoursStore", { serial: "B2" })}`)).toBe(
      "A1 is marked faulty - talk to the store.\nB2 is not in your custody (in the store).",
    );
  });
});

describe("locale settings", () => {
  it("defaults to Arabic, right to left", () => {
    expect(localeFromCookieHeader(null)).toBe("ar");
    expect(localeFromCookieHeader("a=1; ims_locale=en")).toBe("en");
    expect(localeFromCookieHeader("ims_locale=fr")).toBe("ar");
    expect(dirOf("ar")).toBe("rtl");
    expect(dirOf("en")).toBe("ltr");
  });

  it("formats dates and money in Arabic with Western digits", () => {
    expect(fmt("2030-03-10T08:00:00Z", "Africa/Cairo", "EEEE d MMMM yyyy", "ar")).toBe("الأحد 10 مارس 2030");
    expect(formatKey("2030-03-10", { weekday: "long", day: "numeric", month: "long" }, "ar")).toBe("الأحد، 10 مارس");
    expect(money(1250.5, "ar")).toBe("1,250.50 ج.م");
    expect(money(3000, "en")).toBe("3,000 EGP");
  });
});
