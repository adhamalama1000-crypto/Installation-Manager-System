"use client";

import { Suspense, useEffect, useState } from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Boxes,
  CalendarDays,
  ClipboardList,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  MessageSquareWarning,
  HeartHandshake,
  Plane,
  Wallet,
  Plus,
  Settings,
  UserCircle,
  Users,
  Contact,
  X,
} from "lucide-react";
import type { Role } from "@prisma/client";
import { useT } from "@/i18n/client";
import type { T } from "@/i18n/translator";
import type { Permission } from "@/lib/permissions";
import { colorOrFallback } from "@/lib/colors";
import { cn, initials } from "@/lib/utils";
import { Logo, LogoMark } from "./logo";
import { NavigationProgress } from "./navigation-progress";
import { LanguageSwitch } from "./language-switch";
import { NotificationsBell } from "./notifications-bell";
import { ThemeToggle } from "./theme-toggle";

type ShellUser = { name: string; email: string; role: Role; color: string | null; permissions: Permission[] };

function navFor(user: ShellUser, t: T) {
  const has = (p: Permission) => user.permissions.includes(p);
  const tech = user.role === "TECHNICIAN";
  const items: { href: string; label: string; icon: typeof LayoutDashboard; show: boolean }[] = [
    { href: "/", label: t("nav.dashboard"), icon: LayoutDashboard, show: has("appointments.view") },
    { href: "/calendar", label: tech ? t("nav.mySchedule") : t("nav.calendar"), icon: CalendarDays, show: has("appointments.view") },
    { href: "/appointments", label: tech ? t("nav.myAppointments") : t("nav.appointments"), icon: ClipboardList, show: has("appointments.view") },
    { href: "/customers", label: t("nav.customers"), icon: Contact, show: has("customers.view") },
    { href: "/day-plan", label: t("nav.dayPlan"), icon: MessageCircle, show: has("appointments.manage") },
    { href: "/complaints", label: t("nav.complaints"), icon: MessageSquareWarning, show: has("complaints.view") },
    { href: "/after-sales", label: t("nav.afterSales"), icon: HeartHandshake, show: has("appointments.manage") || has("quality.grade") },
    { href: "/leaves", label: tech ? t("nav.myLeave") : t("nav.leave"), icon: Plane, show: has("leaves.manage") || has("leaves.request") },
    { href: "/inventory", label: tech ? t("nav.myStock") : t("nav.inventory"), icon: Boxes, show: has("stock.view") },
    { href: "/finance", label: t("nav.finance"), icon: Wallet, show: has("finance.view") },
    { href: "/reports", label: t("nav.reports"), icon: BarChart3, show: has("reports.view") },
    { href: "/users", label: t("nav.users"), icon: Users, show: has("users.manage") },
    { href: "/audit", label: t("nav.audit"), icon: History, show: has("audit.view") },
    { href: "/settings", label: t("nav.settings"), icon: Settings, show: has("settings.manage") },
  ];
  return items.filter((i) => i.show);
}

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/appointments") return pathname === "/appointments" || (pathname.startsWith("/appointments/") && pathname !== "/appointments/new");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Immediate feedback on the clicked link until the next page arrives. */
function PendingDot() {
  const { pending } = useLinkStatus();
  return <span aria-hidden className={cn("ms-auto h-1.5 w-1.5 rounded-full bg-brand transition-opacity", pending ? "animate-pulse opacity-100" : "opacity-0")} />;
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => undefined);
  // Full page load on purpose: drops all client-side state of the signed-out user.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = "/login";
}

function SidebarContent({ user, onNavigate }: { user: ShellUser; onNavigate?: () => void }) {
  const t = useT();
  const pathname = usePathname();
  const nav = navFor(user, t);
  const canCreate = user.permissions.includes("appointments.manage");
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col items-start gap-3 px-5 pb-4 pt-5">
        <Link href="/" onClick={onNavigate} aria-label={t("nav.goToDashboard")}>
          <Logo width={104} priority />
        </Link>
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-fg-subtle">{t("app.name")}</p>
      </div>
      {canCreate && (
        <div className="px-4 pb-3">
          <Link
            href="/appointments/new"
            onClick={onNavigate}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-brand-strong text-sm font-medium text-white shadow-card hover:bg-brand-stronger"
          >
            <Plus className="h-4 w-4" /> {t("nav.newAppointment")}
          </Link>
        </div>
      )}
      <nav className="flex-1 overflow-y-auto px-3 py-2" aria-label={t("nav.main")}>
        <ul className="space-y-0.5">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    active ? "bg-brand-soft text-brand-text" : "text-fg-muted hover:bg-surface-muted hover:text-fg",
                  )}
                >
                  {active && <span className="absolute inset-y-1.5 start-0 w-1 rounded-e-full bg-brand" aria-hidden />}
                  <Icon className="h-[18px] w-[18px] shrink-0" />
                  {label}
                  <PendingDot />
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="border-t border-line p-4">
        <Link href="/profile" onClick={onNavigate} className="flex items-center gap-3 rounded-lg p-1.5 hover:bg-surface-muted">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
            style={{ backgroundColor: user.role === "SALES" || user.color ? colorOrFallback(user.color) : "#292929" }}
            aria-hidden
          >
            {initials(user.name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-fg">{user.name}</span>
            <span className="block truncate text-xs text-fg-subtle">{t.dyn(`enums.role.${user.role}`)}</span>
          </span>
          <UserCircle className="ms-auto h-4 w-4 text-fg-subtle" aria-hidden />
        </Link>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <ThemeToggle />
          <LanguageSwitch />
        </div>
        <button type="button" onClick={logout} className="mt-2 flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-fg-muted hover:bg-surface-muted hover:text-fg">
          <LogOut className="h-4 w-4 rtl:-scale-x-100" /> {t("auth.signOut")}
        </button>
      </div>
    </div>
  );
}

export function AppShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // eslint-disable-next-line react-hooks/set-state-in-effect -- close the mobile drawer after navigation
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="min-h-dvh lg:ps-64">
      <Suspense fallback={null}>
        <NavigationProgress />
      </Suspense>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-64 border-e border-line bg-surface lg:block">
        <SidebarContent user={user} />
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={t("nav.navigation")}>
          <button type="button" className="absolute inset-0 bg-black/40" aria-label={t("nav.closeNavigation")} onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 start-0 w-72 max-w-[85vw] border-e border-line bg-surface shadow-pop">
            <button type="button" onClick={() => setOpen(false)} className="absolute end-3 top-3 rounded-md p-1.5 text-fg-subtle hover:bg-surface-muted" aria-label={t("nav.closeNavigation")}>
              <X className="h-5 w-5" />
            </button>
            <SidebarContent user={user} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur sm:px-6 lg:px-8">
        <button type="button" onClick={() => setOpen(true)} className="-ms-1 rounded-lg p-2 text-fg-muted hover:bg-surface-muted lg:hidden" aria-label={t("nav.openNavigation")}>
          <Menu className="h-5 w-5" />
        </button>
        <Link href="/" className="flex items-center gap-2 lg:hidden">
          <LogoMark size={28} />
          <span className="text-sm font-semibold">{t("app.short")}</span>
        </Link>
        <div className="ms-auto flex items-center gap-2">
          {user.permissions.includes("appointments.manage") && (
            <Link
              href="/appointments/new"
              className="hidden h-9 items-center gap-1.5 rounded-lg bg-brand-strong px-3 text-sm font-medium text-white hover:bg-brand-stronger sm:flex lg:hidden"
            >
              <Plus className="h-4 w-4" /> {t("nav.newShort")}
            </Link>
          )}
          <NotificationsBell />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
    </div>
  );
}
