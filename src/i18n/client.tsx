"use client";

import { createContext, useContext } from "react";
import type { Locale } from "./config";
import { createT, type T } from "./translator";

const I18nContext = createContext<T>(createT("ar"));

/** Makes the request's language available to client components (dictionaries are bundled). */
export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <I18nContext.Provider value={createT(locale)}>{children}</I18nContext.Provider>;
}

export function useT(): T {
  return useContext(I18nContext);
}
