import type { Metadata } from "next";
import { getT } from "@/i18n/server";
import { SetPasswordForm } from "./set-password-form";
import { Alert } from "@/components/ui/misc";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("auth.setPasswordTitle") };
}

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) {
    const t = await getT();
    return (
      <Alert tone="danger" title={t("auth.missingLink")}>
        {t("auth.missingLinkText")}
      </Alert>
    );
  }
  return <SetPasswordForm token={token} />;
}
