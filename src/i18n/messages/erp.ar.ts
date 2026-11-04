import type { Widen } from "../types";
import type { erpEn } from "./erp.en";

/** Arabic texts of the ERP upgrade; the same keys as erp.en.ts. */
export const erpAr: Widen<typeof erpEn> = {
  forms: {
    typeToSearch: "اكتب للبحث…",
    noMatches: "لا توجد نتائج",
    saveAndAddAnother: "حفظ وإضافة آخر",
    duplicate: "نسخ",
    duplicateHint: "يفتح نموذجًا جديدًا مملوءًا من هذا السجل (الأكواد تُترك فارغة وتُولَّد من جديد).",
    copyOf: "نسخة من {name}",
    savedAddAnother: "تم الحفظ. النموذج جاهز للسجل التالي.",
  },
  drafts: {
    found: "لديك مسودة غير محفوظة من {when}.",
    restore: "استرجاع المسودة",
    discard: "تجاهل",
  },
};
