"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useI18n } from "@/i18n/client";

/** The in-app page a click on this element would navigate to, or null. */
function internalTarget(e: MouseEvent): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a[href]");
  if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return null;
  const url = new URL(a.href, window.location.href);
  if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return null;
  const target = url.pathname + url.search;
  return target === window.location.pathname + window.location.search ? null : target;
}

/**
 * A thin bar at the top of the window from the moment an in-app link is clicked until the new page
 * is shown, so a navigation that waits for the server never looks like a frozen screen. The
 * current page stays visible meanwhile, and the new one appears as soon as it is ready.
 */
export function NavigationProgress() {
  const { t } = useI18n();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [active, setActive] = useState(false);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (internalTarget(e)) setActive(true);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // The route changed: the new page is on screen.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to the router's location
  useEffect(() => setActive(false), [pathname, search]);

  // Never leave the bar running (e.g. a navigation that was cancelled).
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setActive(false), 15_000);
    return () => clearTimeout(t);
  }, [active]);

  if (!active) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5" data-nav-progress="active">
      <div className="nav-progress h-full bg-brand" />
      <span className="sr-only" role="status">
        {t("nav.loadingPage")}
      </span>
    </div>
  );
}
