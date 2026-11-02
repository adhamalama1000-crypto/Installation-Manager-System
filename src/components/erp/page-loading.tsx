import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { getT } from "@/i18n/server";

/** The loading state of the inventory pages: header, filters and a table of placeholder rows. */
export async function InventoryLoading({ rows = 8 }: { rows?: number }) {
  const t = await getT();
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{t("common.loadingPage")}</span>
      <div className="mb-6 space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      </Card>
      <Card className="divide-y divide-line">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </Card>
    </div>
  );
}
