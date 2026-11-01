/** A message with plural forms, chosen with Intl.PluralRules (Arabic uses all six). */
export type Plural = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string };

/** The English dictionary's shape with every text widened to `string`, so Arabic must have the same keys. */
export type Widen<T> = T extends string ? string : T extends Plural ? Plural : { [K in keyof T]: Widen<T[K]> };
