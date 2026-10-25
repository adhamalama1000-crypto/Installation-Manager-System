import Link from "next/link";
import { Search, SlidersHorizontal } from "lucide-react";
import type { StatusDTO } from "@/lib/types";
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS } from "@/lib/constants";
import { buttonClasses } from "@/components/ui/button";

const control =
  "h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg shadow-card focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25";

type Option = { id: string; name: string };

/** GET form - filters live in the URL so they can be bookmarked and shared. */
export function FiltersBar({
  action,
  values,
  statuses,
  sales,
  technicians,
  showLocation,
  showTechnicianFilter,
  searchPlaceholder,
}: {
  action: string;
  values: Record<string, string | undefined>;
  statuses: StatusDTO[];
  sales: Option[];
  technicians: Option[];
  showLocation: boolean;
  showTechnicianFilter: boolean;
  searchPlaceholder: string;
}) {
  const label = "mb-1 block text-xs font-medium text-fg-muted";
  return (
    <form action={action} method="get" className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input name="q" defaultValue={values.q} placeholder={searchPlaceholder} aria-label="Search" className={`${control} pl-9`} />
        </div>
        <div className="flex gap-2">
          <button type="submit" className={buttonClasses("primary", "md")}>
            <SlidersHorizontal className="h-4 w-4" /> Apply
          </button>
          <Link href={action} className={buttonClasses("outline", "md")}>
            Reset
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <div>
          <label className={label} htmlFor="f-status">Status</label>
          <select id="f-status" name="status" defaultValue={values.status ?? ""} className={control}>
            <option value="">All statuses</option>
            {values.status && values.status.includes(",") && <option value={values.status}>Selected group</option>}
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="f-category">Category</label>
          <select id="f-category" name="category" defaultValue={values.category ?? ""} className={control}>
            <option value="">All categories</option>
            {PRODUCT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {PRODUCT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="f-sales">Sales employee</label>
          <select id="f-sales" name="salesId" defaultValue={values.salesId ?? ""} className={control}>
            <option value="">Everyone</option>
            {sales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {showTechnicianFilter && (
          <div>
            <label className={label} htmlFor="f-tech">Technician</label>
            <select id="f-tech" name="technicianId" defaultValue={values.technicianId ?? ""} className={control}>
              <option value="">All technicians</option>
              {technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {showLocation && (
          <div>
            <label className={label} htmlFor="f-area">Area / compound</label>
            <input id="f-area" name="area" defaultValue={values.area} placeholder="e.g. New Cairo" className={control} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={label} htmlFor="f-from">From</label>
            <input id="f-from" type="date" name="from" defaultValue={values.from} className={`${control} px-2`} />
          </div>
          <div>
            <label className={label} htmlFor="f-to">To</label>
            <input id="f-to" type="date" name="to" defaultValue={values.to} className={`${control} px-2`} />
          </div>
        </div>
      </div>
      {values.sort && <input type="hidden" name="sort" value={values.sort} />}
      {values.dir && <input type="hidden" name="dir" value={values.dir} />}
    </form>
  );
}
