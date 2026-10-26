/**
 * Messages are declared in pairs, English next to Arabic, so a translation can never be missing:
 * TypeScript refuses an entry without both languages. Plural entries use the Intl plural
 * categories of each language (Arabic has zero/one/two/few/many/other) and the `count` parameter.
 */
export type PluralForms = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };
export type Entry = string | PluralForms;
export type MessagePair = { en: Entry; ar: Entry };

export function defineMessages<const T extends Record<string, MessagePair>>(messages: T): T {
  return messages;
}
