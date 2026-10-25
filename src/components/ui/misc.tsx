import { AlertTriangle, CheckCircle2, Info, Inbox, XCircle } from "lucide-react";
import { chipColors, colorOrFallback } from "@/lib/colors";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-sm text-fg-muted">{breadcrumb}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-fg-muted", className)}
      {...props}
    />
  );
}

/** Status badge: tinted background with a solid dot in the status colour (readable in both themes). */
export function StatusBadge({ name, color, className }: { name: string; color: string; className?: string }) {
  const c = colorOrFallback(color);
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium text-fg", className)}
      style={{ backgroundColor: `${c}1F`, borderColor: `${c}55` }}
    >
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c }} aria-hidden />
      {name}
    </span>
  );
}

/** Sales employee colour marker + name. */
export function SalesTag({ name, color, inactive, className }: { name: string; color: string | null; inactive?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm text-fg", className)}>
      <span className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/20" style={{ backgroundColor: colorOrFallback(color) }} aria-hidden />
      <span className="truncate">{name}</span>
      {inactive && <span className="text-xs text-fg-subtle">(inactive)</span>}
    </span>
  );
}

export function ColorChip({ color, children, className }: { color: string | null; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold", className)} style={chipColors(color)}>
      {children}
    </span>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted text-fg-subtle">{icon ?? <Inbox className="h-6 w-6" />}</div>
      <p className="font-medium text-fg">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-fg-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

const alertStyles = {
  info: { box: "border-info/30 bg-info-soft text-fg", icon: Info, iconClass: "text-info" },
  success: { box: "border-success/30 bg-success-soft text-fg", icon: CheckCircle2, iconClass: "text-success" },
  warning: { box: "border-warning/40 bg-warning-soft text-fg", icon: AlertTriangle, iconClass: "text-warning" },
  danger: { box: "border-danger/30 bg-danger-soft text-fg", icon: XCircle, iconClass: "text-danger" },
};

export function Alert({ tone = "info", title, children, className }: { tone?: keyof typeof alertStyles; title?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  const s = alertStyles[tone];
  const Icon = s.icon;
  return (
    <div role={tone === "danger" || tone === "warning" ? "alert" : "status"} className={cn("flex gap-3 rounded-lg border px-4 py-3 text-sm", s.box, className)}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", s.iconClass)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && "mt-1", "text-fg-muted")}>{children}</div>}
      </div>
    </div>
  );
}

export function DefinitionList({ items, className }: { items: { label: string; value: React.ReactNode; full?: boolean }[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2", className)}>
      {items.map((item) => (
        <div key={item.label} className={cn("min-w-0", item.full && "sm:col-span-2")}>
          <dt className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{item.label}</dt>
          <dd className="mt-1 break-words text-sm text-fg">{item.value ?? <span className="text-fg-subtle">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-muted", className)} />;
}
