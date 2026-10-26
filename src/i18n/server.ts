import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./config";
import { createT, type T } from "./translator";

/** The language of the current request (cookie), Arabic when none was chosen. */
export const getLocale = cache(async (): Promise<Locale> => {
  const value = (await cookies()).get("ims_locale")?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
});

export const getT = cache(async (): Promise<T> => createT(await getLocale()));
