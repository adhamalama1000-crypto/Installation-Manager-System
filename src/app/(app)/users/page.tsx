import type { Metadata } from "next";
import { UsersManager } from "@/components/users/users-manager";
import { PageHeader } from "@/components/ui/misc";
import { getI18n } from "@/i18n/server";
import { requirePagePermission } from "@/server/auth/session";
import { listUsers } from "@/server/services/users";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("users.title") };
}

export default async function UsersPage() {
  const user = await requirePagePermission("users.manage");
  const users = await listUsers(user);
  const { t } = await getI18n();
  return (
    <>
      <PageHeader title={t("users.title")} description={t("users.desc")} />
      <UsersManager users={users} currentUserId={user.id} />
    </>
  );
}
