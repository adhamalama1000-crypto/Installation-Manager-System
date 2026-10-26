import { defineMessages } from "../define";

/** Labels of database enum values (key = "enum.<type>.<VALUE>"). */
export const enums = defineMessages({
  "enum.role.ADMIN": { en: "Admin", ar: "مسؤول" },
  "enum.role.SALES": { en: "Sales", ar: "مبيعات" },
  "enum.role.TECHNICIAN": { en: "Technician", ar: "فني" },
  "enum.role.VIEWER": { en: "Viewer", ar: "مشاهد" },
  "enum.role.ACCOUNTANT": { en: "Accountant", ar: "محاسب" },
  "enum.role.STORE": { en: "Store keeper", ar: "أمين المخزن" },
  "enum.role.DRIVER": { en: "Driver", ar: "سائق" },

  "enum.stockStatus.IN_STORE": { en: "In store", ar: "في المخزن" },
  "enum.stockStatus.WITH_TECHNICIAN": { en: "With technician", ar: "عهدة مع فني" },
  "enum.stockStatus.INSTALLED": { en: "Installed", ar: "تم تركيبه" },
  "enum.stockStatus.RETURNED": { en: "Returned", ar: "مرتجع" },
  "enum.stockStatus.FAULTY": { en: "Faulty", ar: "تالف" },

  "enum.paymentMethod.CASH": { en: "Cash", ar: "نقدًا" },
  "enum.paymentMethod.INSTAPAY": { en: "InstaPay", ar: "إنستاباي" },
  "enum.paymentMethod.VODAFONE_CASH": { en: "Vodafone Cash", ar: "فودافون كاش" },
  "enum.paymentMethod.BANK_TRANSFER": { en: "Bank transfer", ar: "تحويل بنكي" },

  "enum.custody.HELD": { en: "With technician", ar: "مع الفني" },
  "enum.custody.RECEIVED": { en: "Received", ar: "تم الاستلام" },
  "enum.custody.VOID": { en: "Corrected", ar: "مُصحَّح" },

  "enum.category.SMART_LOCK": { en: "Smart Lock", ar: "قفل ذكي" },
  "enum.category.SMART_HOME": { en: "Smart Home", ar: "منزل ذكي" },
  "enum.category.CCTV": { en: "CCTV", ar: "كاميرات مراقبة" },
  "enum.category.INTERCOM": { en: "Intercom", ar: "إنتركم" },
  "enum.category.OTHER": { en: "Other", ar: "أخرى" },

  "enum.visitType.INSPECTION": { en: "Inspection", ar: "معاينة" },
  "enum.visitType.INSTALLATION": { en: "Installation", ar: "تركيب" },
  "enum.visitType.COMPLETION": { en: "Completion", ar: "استكمال" },
  "enum.visitType.PROGRAMMING": { en: "Programming", ar: "برمجة" },
  "enum.visitType.MAINTENANCE": { en: "Maintenance", ar: "صيانة" },

  "enum.confirmation.PENDING": { en: "Awaiting confirmation", ar: "بانتظار التأكيد" },
  "enum.confirmation.CONFIRMED": { en: "Confirmed by customer", ar: "أكّده العميل" },
  "enum.confirmation.RESCHEDULE_REQUESTED": { en: "Customer asked to reschedule", ar: "طلب العميل تغيير الموعد" },
  "enum.confirmation.UNREACHABLE": { en: "Customer unreachable", ar: "تعذّر التواصل مع العميل" },

  "enum.leaveType.LEAVE": { en: "Leave", ar: "إجازة" },
  "enum.leaveType.SICK": { en: "Sick leave", ar: "إجازة مرضية" },
  "enum.leaveType.ABSENCE": { en: "Absence", ar: "غياب" },

  "enum.leaveStatus.REQUESTED": { en: "Awaiting approval", ar: "بانتظار الموافقة" },
  "enum.leaveStatus.APPROVED": { en: "Approved", ar: "موافق عليها" },
  "enum.leaveStatus.REJECTED": { en: "Rejected", ar: "مرفوضة" },
  "enum.leaveStatus.CANCELLED": { en: "Cancelled", ar: "ملغاة" },

  "enum.statusKind.SCHEDULED": { en: "Scheduled", ar: "مجدول" },
  "enum.statusKind.IN_PROGRESS": { en: "In Progress", ar: "قيد التنفيذ" },
  "enum.statusKind.COMPLETED": { en: "Completed", ar: "تم التنفيذ" },
  "enum.statusKind.POSTPONED": { en: "Postponed / Rescheduled", ar: "مؤجل / أعيدت جدولته" },
  "enum.statusKind.CANCELLED": { en: "Cancelled", ar: "ملغي" },
  "enum.statusKind.UNABLE_TO_COMPLETE": { en: "Unable to Complete", ar: "تعذّر الإكمال" },
  "enum.statusKind.NEEDS_REVISIT": { en: "Needs another visit", ar: "يحتاج زيارة أخرى" },

  "enum.outcome.IN_PROGRESS": { en: "Started", ar: "بدأ العمل" },
  "enum.outcome.COMPLETED": { en: "Done", ar: "تم التنفيذ" },
  "enum.outcome.UNABLE_TO_COMPLETE": { en: "Unable to complete", ar: "تعذّر الإكمال" },
  "enum.outcome.NEEDS_REVISIT": { en: "Needs another visit", ar: "يحتاج زيارة أخرى" },
});
