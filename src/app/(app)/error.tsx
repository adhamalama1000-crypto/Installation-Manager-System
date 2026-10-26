"use client";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/misc";
import { useT } from "@/i18n/client";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Alert tone="danger" title={t("errors.somethingWrong")}>
        {t("errors.pageNotLoaded")}
        {error.digest ? ` ${t("errors.reference", { ref: error.digest })}` : ""}
      </Alert>
      <Button variant="outline" onClick={reset}>
        {t("common.tryAgain")}
      </Button>
    </div>
  );
}
