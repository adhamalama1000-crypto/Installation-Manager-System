import Link from "next/link";
import { ChevronDown, Plus } from "lucide-react";
import type { StockDocType, StockReturnKind } from "@prisma/client";
import { buttonClasses } from "@/components/ui/button";
import type { T } from "@/i18n/translator";
import { docTypeLabel } from "./labels";

/** "New document" menu listing the document types this user may prepare (works without script). */
export function NewDocumentMenu({ t, types }: { t: T; types: { type: StockDocType; returnKind: StockReturnKind | null }[] }) {
  if (!types.length) return null;
  return (
    <details className="group relative">
      <summary className={buttonClasses("primary", "md", "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
        <Plus className="h-4 w-4" /> {t("stock.newDocument")} <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
      </summary>
      <ul className="absolute end-0 z-30 mt-1 w-60 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-pop">
        {types.map((d) => (
          <li key={`${d.type}-${d.returnKind ?? ""}`}>
            <Link href={`/stock/documents/new?type=${d.type}${d.returnKind ? `&returnKind=${d.returnKind}` : ""}`} className="block px-4 py-2 text-sm text-fg hover:bg-surface-muted">
              {docTypeLabel(t, d.type, d.returnKind)}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
