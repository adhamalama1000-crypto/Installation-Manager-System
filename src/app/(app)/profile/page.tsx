import { KeyRound, Palette, UserCircle } from "lucide-react";
import { ChangePasswordForm } from "@/components/profile/change-password";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DefinitionList, PageHeader, SalesTag } from "@/components/ui/misc";
import { ROLE_LABELS } from "@/lib/constants";
import { requireUser } from "@/server/auth/session";

export const metadata = { title: "My profile" };

export default async function ProfilePage() {
  const user = await requireUser();
  return (
    <>
      <PageHeader title="My profile" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Account" icon={<UserCircle className="h-4 w-4" />} />
          <CardBody>
            <DefinitionList
              items={[
                { label: "Name", value: user.name },
                { label: "Email", value: user.email },
                { label: "Role", value: ROLE_LABELS[user.role] },
                { label: "Timezone", value: user.settings.timezone },
                ...(user.color ? [{ label: "Calendar colour", value: <SalesTag name={user.color} color={user.color} /> }] : []),
              ]}
            />
            <p className="mt-4 text-xs text-fg-subtle">Ask an administrator to change your name, email or role.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Appearance" icon={<Palette className="h-4 w-4" />} />
          <CardBody className="flex items-center justify-between gap-4">
            <p className="text-sm text-fg-muted">Light, dark, or follow your device setting.</p>
            <ThemeToggle />
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Change password" icon={<KeyRound className="h-4 w-4" />} />
          <CardBody>
            <ChangePasswordForm />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
