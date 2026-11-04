/**
 * English texts of the ERP upgrade (variants, automatic codes, suppliers, sales, analytics,
 * imports, attendance, work evidence, penalties). Spread into en.ts; the Arabic file erp.ar.ts
 * must have the same keys (TypeScript and tests/unit/i18n.test.ts check it).
 */
export const erpEn = {
  forms: {
    typeToSearch: "Type to search…",
    noMatches: "No matches",
    saveAndAddAnother: "Save and add another",
    duplicate: "Duplicate",
    duplicateHint: "Opens a new form filled in from this record (codes are left empty and generated again).",
    copyOf: "Copy of {name}",
    savedAddAnother: "Saved. The form is ready for the next one.",
  },
  drafts: {
    found: "You have an unsaved draft from {when}.",
    restore: "Restore draft",
    discard: "Discard",
  },
};
