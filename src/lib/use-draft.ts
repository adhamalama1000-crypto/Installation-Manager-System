"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Keeps an unsaved form in this browser while it is being typed, so a closed tab, a refresh or a
 * lost connection does not throw the work away. Only the person's own browser holds it
 * (localStorage, one key per form); it is removed when the form is saved or the draft discarded.
 * Storage that is blocked or full is ignored: the form simply works without drafts.
 *
 *   const draft = useDraft("product:new", values, { enabled: !initial });
 *   draft.saved    -> a draft from an earlier visit, offered to the user (restore / discard)
 *   draft.clear()  -> after a successful save
 */
export function useDraft<V>(key: string, values: V, { enabled = true, delayMs = 600 }: { enabled?: boolean; delayMs?: number } = {}) {
  const storageKey = `ims:draft:${key}`;
  const [saved, setSaved] = useState<{ values: V; at: string } | null>(null);
  const skipFirst = useRef(true);

  // A draft left from an earlier visit (read once, after mounting: localStorage is browser-only).
  useEffect(() => {
    if (!enabled) return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reading browser storage once after mount
      if (raw) setSaved(JSON.parse(raw) as { values: V; at: string });
    } catch {
      /* storage unavailable */
    }
  }, [enabled, storageKey]);

  // Save while typing (debounced). The first render is the untouched form: not a draft.
  useEffect(() => {
    if (!enabled) return;
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const timer = setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify({ values, at: new Date().toISOString() }));
      } catch {
        /* storage unavailable or full */
      }
    }, delayMs);
    return () => clearTimeout(timer);
  }, [enabled, storageKey, values, delayMs]);

  const clear = useCallback(() => {
    setSaved(null);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  /** Hides the offer without deleting what is being typed now. */
  const dismiss = useCallback(() => setSaved(null), []);

  return { saved, clear, dismiss };
}

/** Remembers a small, harmless preference (last warehouse, last unit) in this browser. */
export function rememberChoice(key: string, value: string | null) {
  try {
    if (value) window.localStorage.setItem(`ims:pref:${key}`, value);
    else window.localStorage.removeItem(`ims:pref:${key}`);
  } catch {
    /* ignore */
  }
}

export function recallChoice(key: string): string | null {
  try {
    return window.localStorage.getItem(`ims:pref:${key}`);
  } catch {
    return null;
  }
}
