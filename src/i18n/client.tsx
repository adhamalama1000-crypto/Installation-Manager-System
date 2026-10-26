"use client";

import { createContext, useContext, useMemo } from "react";
import { dirOf, type Locale } from "./config";
import { createFormatter } from "./format";
import { translate, translateMessage, type MessageKey, type Params } from "./translate";

const I18nContext = createContext<{ locale: Locale; tz: string }>({ locale: "en", tz: "UTC" });

export function I18nProvider({ locale, tz, children }: { locale: Locale; tz: string; children: React.ReactNode }) {
  const value = useMemo(() => ({ locale, tz }), [locale, tz]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Translation and formatting in client components. */
export function useI18n() {
  const { locale, tz } = useContext(I18nContext);
  return useMemo(
    () => ({
      locale,
      tz,
      dir: dirOf(locale),
      t: (key: MessageKey, params?: Params) => translate(locale, key, params, tz),
      /** Translates a message descriptor from the server or a validation schema; other text unchanged. */
      tm: (text: string | null | undefined) => translateMessage(text, locale, tz),
      f: createFormatter(locale, tz),
    }),
    [locale, tz],
  );
}

export type ClientI18n = ReturnType<typeof useI18n>;
