import { UsersManager } from "@/components/users/users-manager";
import { PageHeader } from "@/components/ui/misc";
import { requirePagePermission } from "@/server/auth/session";
import { listUsers } from "@/server/services/users";
import { getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("nav.users") };
}

export default async function UsersPage() {
  const [user, t] = await Promise.all([requirePagePermission("users.manage"), getT()]);
  const users = await listUsers(user);
  return (
    <>
      <PageHeader title={t("nav.users")} description={t("users.text")} />
      <UsersManager users={users} currentUserId={user.id} />
    </>
  );
}
