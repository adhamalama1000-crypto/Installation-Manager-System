import type { Metadata } from "next";
import { KeyRound, Palette, UserCircle } from "lucide-react";
import { ChangePasswordForm } from "@/components/profile/change-password";
import { LanguageSwitch } from "@/components/layout/language-switch";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DefinitionList, PageHeader, SalesTag } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { requireUser } from "@/server/auth/session";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("profile.title") };
}

export default async function ProfilePage() {
  const [user, t] = await Promise.all([requireUser(), getT()]);
  return (
    <>
      <PageHeader title={t("profile.title")} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("profile.account")} icon={<UserCircle className="h-4 w-4" />} />
          <CardBody>
            <DefinitionList
              items={[
                { label: t("common.name"), value: user.name },
                { label: t("common.email"), value: <bdi dir="ltr">{user.email}</bdi> },
                { label: t("common.role"), value: t.dyn(`enums.role.${user.role}`) },
                { label: t("profile.timezone"), value: <bdi dir="ltr">{user.settings.timezone}</bdi> },
                ...(user.color ? [{ label: t("profile.colour"), value: <SalesTag name={user.color} color={user.color} /> }] : []),
              ]}
            />
            <p className="mt-4 text-xs text-fg-subtle">{t("profile.askAdmin")}</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t("profile.appearance")} icon={<Palette className="h-4 w-4" />} />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-fg-muted">{t("profile.languageText")}</p>
              <LanguageSwitch />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-fg-muted">{t("profile.themeText")}</p>
              <ThemeToggle />
            </div>
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title={t("profile.changePassword")} icon={<KeyRound className="h-4 w-4" />} />
          <CardBody>
            <ChangePasswordForm />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
