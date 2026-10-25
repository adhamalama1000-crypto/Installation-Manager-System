import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function Pagination({
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
  const btn = "inline-flex h-8 items-center gap-1 rounded-md border border-line px-2.5 text-sm text-fg hover:bg-surface-muted";
  return (
    <nav className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-fg-muted" aria-label="Pagination">
      <span>
        {total} result{total === 1 ? "" : "s"} · page {page} of {pageCount}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link className={btn} href={hrefFor(page - 1)} rel="prev">
            <ChevronLeft className="h-4 w-4" /> Previous
          </Link>
        ) : (
          <span className={cn(btn, "pointer-events-none opacity-40")}>
            <ChevronLeft className="h-4 w-4" /> Previous
          </span>
        )}
        {page < pageCount ? (
          <Link className={btn} href={hrefFor(page + 1)} rel="next">
            Next <ChevronRight className="h-4 w-4" />
          </Link>
        ) : (
          <span className={cn(btn, "pointer-events-none opacity-40")}>
            Next <ChevronRight className="h-4 w-4" />
          </span>
        )}
      </div>
    </nav>
  );
}
