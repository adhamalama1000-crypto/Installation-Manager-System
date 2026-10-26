import Link from "next/link";
import { getT } from "@/i18n/server";

export default async function NotFound() {
  const t = await getT();
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-semibold text-brand-text">404</p>
      <h1 className="text-2xl font-semibold">{t("errors.notFoundTitle")}</h1>
      <p className="max-w-sm text-sm text-fg-muted">{t("errors.notFoundText")}</p>
      <Link href="/" className="mt-2 text-sm font-medium text-brand-text hover:underline">
        {t("errors.goToDashboard")}
      </Link>
    </div>
  );
}
