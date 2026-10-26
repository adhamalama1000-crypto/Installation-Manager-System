import type { Metadata } from "next";
import { ShieldOff } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { getI18n } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("common.accessDenied") };
}

export default async function AccessDeniedPage() {
  const { t } = await getI18n();
  return (
    <Card className="mx-auto max-w-xl">
      <EmptyState
        icon={<ShieldOff className="h-6 w-6" />}
        title={t("common.accessDeniedTitle")}
        description={t("common.accessDeniedText")}
        action={
          <ButtonLink href="/" variant="outline">
            {t("common.backToDashboard")}
          </ButtonLink>
        }
      />
    </Card>
  );
}
