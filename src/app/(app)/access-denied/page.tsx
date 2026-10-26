import type { Metadata } from "next";
import { ShieldOff } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("errors.accessDeniedTitle") };
}

export default async function AccessDeniedPage() {
  const t = await getT();
  return (
    <Card className="mx-auto max-w-xl">
      <EmptyState
        icon={<ShieldOff className="h-6 w-6" />}
        title={t("errors.accessDenied")}
        description={t("errors.accessDeniedText")}
        action={
          <ButtonLink href="/" variant="outline">
            {t("errors.backToDashboard")}
          </ButtonLink>
        }
      />
    </Card>
  );
}
