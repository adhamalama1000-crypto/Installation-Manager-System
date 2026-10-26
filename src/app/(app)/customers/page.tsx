import Link from "next/link";
import { Search } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { shortDate } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/session";
import { listCustomers } from "@/server/services/customers";

export const metadata = { title: "Customers" };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const user = await requirePagePermission("customers.view");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const result = await listCustomers(user, { q: sp.q, page });
  const tz = user.settings.timezone;
  const showPhone = user.permissions.includes("customers.contact");
  const showArea = user.permissions.includes("location.view");
  const th = "px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-fg-subtle";
  return (
    <>
      <PageHeader title="Customers" description="Every customer with their installation sites and appointment history." />
      <Card className="mb-4 p-4">
        <form method="get" className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <input
              name="q"
              defaultValue={sp.q}
              aria-label="Search customers"
              placeholder={`Search by name${showPhone ? ", phone" : ""}${showArea ? ", area or compound" : ""}`}
              className="h-10 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm shadow-card focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25"
            />
          </div>
          <button className={buttonClasses("primary")}>Search</button>
        </form>
      </Card>
      <Card className="overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState title="No customers found" description={sp.q ? "Try a different search." : "Customers are created automatically when you book an appointment."} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="border-b border-line bg-surface-muted/60">
                  <tr>
                    <th className={th}>Customer</th>
                    {showPhone && <th className={th}>Phone</th>}
                    {showArea && <th className={th}>Area</th>}
                    <th className={th}>Sites</th>
                    <th className={th}>Appointments</th>
                    <th className={th}>Latest appointment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.rows.map((c) => (
                    <tr key={c.id} className="hover:bg-surface-muted/60">
                      <td className="px-4 py-3">
                        <Link href={`/customers/${c.id}`} prefetch={false} className="font-medium text-fg hover:text-brand-text hover:underline">
                          {c.name}
                        </Link>
                      </td>
                      {showPhone && <td className="whitespace-nowrap px-4 py-3 text-fg-muted">{c.phone}</td>}
                      {showArea && <td className="px-4 py-3 text-fg-muted">{c.area ?? "—"}</td>}
                      <td className="px-4 py-3 tabular-nums">{c.locations}</td>
                      <td className="px-4 py-3 tabular-nums">{c.appointments}</td>
                      <td className="px-4 py-3 text-fg-muted">{c.lastAppointment ? shortDate(c.lastAppointment, tz) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={result.page}
              pageCount={result.pageCount}
              total={result.total}
              hrefFor={(p) => `/customers?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), page: String(p) })}`}
            />
          </>
        )}
      </Card>
    </>
  );
}
