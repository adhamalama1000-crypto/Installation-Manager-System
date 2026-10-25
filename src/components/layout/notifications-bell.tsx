"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

type Item = { id: string; message: string; appointmentId: string | null; readAt: string | null; createdAt: string };

function ago(iso: string) {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** In-app notifications (assignments, reschedules, cancellations). Polls every 60 seconds. */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ unread: number; items: Item[] }>({ unread: 0, items: [] });
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      setData(await api<{ unread: number; items: Item[] }>("/api/notifications"));
    } catch {
      /* transient errors are ignored; the next poll retries */
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch of external data
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markAll = async () => {
    await api("/api/notifications/read", { method: "POST", body: {} }).catch(() => undefined);
    void load();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-muted hover:text-fg"
        aria-label={`Notifications${data.unread ? ` (${data.unread} unread)` : ""}`}
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" />
        {data.unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-strong px-1 text-[10px] font-semibold text-white">
            {data.unread > 9 ? "9+" : data.unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            {data.unread > 0 && (
              <button type="button" className="text-xs font-medium text-brand-text hover:underline" onClick={markAll}>
                Mark all as read
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {data.items.length === 0 && <li className="px-4 py-8 text-center text-sm text-fg-muted">No notifications yet.</li>}
            {data.items.map((n) => {
              const body = (
                <div className={cn("flex gap-3 px-4 py-3", !n.readAt && "bg-brand-soft/60")}>
                  <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-brand")} aria-hidden />
                  <div className="min-w-0">
                    <p className="text-sm text-fg">{n.message}</p>
                    <p className="mt-0.5 text-xs text-fg-subtle">{ago(n.createdAt)}</p>
                  </div>
                </div>
              );
              return (
                <li key={n.id} className="border-b border-line last:border-0">
                  {n.appointmentId ? (
                    <Link href={`/appointments/${n.appointmentId}`} className="block hover:bg-surface-muted" onClick={() => setOpen(false)}>
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
