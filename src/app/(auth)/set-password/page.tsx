import type { Metadata } from "next";
import { getI18n } from "@/i18n/server";
import { SetPasswordForm } from "./set-password-form";
import { Alert } from "@/components/ui/misc";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("auth.setPasswordPage") };
}

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const { t } = await getI18n();
  if (!token) {
    return (
      <Alert tone="danger" title={t("auth.missingLink")}>
        {t("auth.missingLinkText")}
      </Alert>
    );
  }
  return <SetPasswordForm token={token} />;
}
