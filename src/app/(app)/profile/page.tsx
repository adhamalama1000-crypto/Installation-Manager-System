import type { Metadata } from "next";
import { KeyRound, Languages, Palette, UserCircle } from "lucide-react";
import { ChangePasswordForm } from "@/components/profile/change-password";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Ltr } from "@/components/ui/ltr";
import { DefinitionList, PageHeader, SalesTag } from "@/components/ui/misc";
import { getI18n } from "@/i18n/server";
import { requireUser } from "@/server/auth/session";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("prof.title") };
}

export default async function ProfilePage() {
  const user = await requireUser();
  const { t, label } = await getI18n();
  return (
    <>
      <PageHeader title={t("prof.title")} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("prof.account")} icon={<UserCircle className="h-4 w-4" />} />
          <CardBody>
            <DefinitionList
              items={[
                { label: t("prof.name"), value: user.name },
                { label: t("prof.email"), value: <Ltr>{user.email}</Ltr> },
                { label: t("prof.role"), value: label("role", user.role) },
                { label: t("prof.timezone"), value: <Ltr>{user.settings.timezone}</Ltr> },
                ...(user.color ? [{ label: t("prof.color"), value: <SalesTag name={user.color} color={user.color} /> }] : []),
              ]}
            />
            <p className="mt-4 text-xs text-fg-subtle">{t("prof.askAdmin")}</p>
          </CardBody>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title={t("prof.appearance")} icon={<Palette className="h-4 w-4" />} />
            <CardBody className="flex items-center justify-between gap-4">
              <p className="text-sm text-fg-muted">{t("prof.appearanceHint")}</p>
              <ThemeToggle />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t("prof.language")} icon={<Languages className="h-4 w-4" />} />
            <CardBody className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-fg-muted">{t("prof.languageHint")}</p>
              <LanguageSwitcher />
            </CardBody>
          </Card>
        </div>
        <Card className="lg:col-span-2">
          <CardHeader title={t("prof.changePassword")} icon={<KeyRound className="h-4 w-4" />} />
          <CardBody>
            <ChangePasswordForm />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
