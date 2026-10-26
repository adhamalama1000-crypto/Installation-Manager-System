"use client";

import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/misc";
import { useI18n } from "@/i18n/client";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Alert tone="danger" title={t("common.somethingWrong")}>
        {t("common.errorBoundaryText")}
        {error.digest ? ` (${error.digest})` : ""}
      </Alert>
      <Button variant="outline" onClick={reset}>
        {t("common.tryAgain")}
      </Button>
    </div>
  );
}
