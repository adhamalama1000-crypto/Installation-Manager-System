"use client";

import { useT } from "@/i18n/client";
import type { MessageKey, TParams } from "@/i18n/translator";

/** Translated text for components shared by server and client code (which cannot call useT). */
export function Tr({ k, params }: { k: MessageKey; params?: TParams }) {
  return <>{useT()(k, params)}</>;
}
