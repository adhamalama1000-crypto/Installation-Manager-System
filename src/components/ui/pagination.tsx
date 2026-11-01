import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getT } from "@/i18n/server";
import { cn } from "@/lib/utils";

export async function Pagination({
  page,
  pageCount,
  total,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  const t = await getT();
  const btn = "inline-flex h-8 items-center gap-1 rounded-md border border-line px-2.5 text-sm text-fg hover:bg-surface-muted";
  return (
    <nav className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-fg-muted" aria-label={t("pagination.label")}>
      <span>
        {t("pagination.summary", { results: t("common.results", { count: total }), page, pageCount })}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link className={btn} href={hrefFor(page - 1)} rel="prev">
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" /> {t("common.previous")}
          </Link>
        ) : (
          <span className={cn(btn, "pointer-events-none opacity-40")}>
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" /> {t("common.previous")}
          </span>
        )}
        {page < pageCount ? (
          <Link className={btn} href={hrefFor(page + 1)} rel="next">
            {t("common.next")} <ChevronRight className="h-4 w-4 rtl:rotate-180" />
          </Link>
        ) : (
          <span className={cn(btn, "pointer-events-none opacity-40")}>
            {t("common.next")} <ChevronRight className="h-4 w-4 rtl:rotate-180" />
          </span>
        )}
      </div>
    </nav>
  );
}
