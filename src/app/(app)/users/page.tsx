import { UsersManager } from "@/components/users/users-manager";
import { PageHeader } from "@/components/ui/misc";
import { requirePagePermission } from "@/server/auth/session";
import { listUsers } from "@/server/services/users";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  const user = await requirePagePermission("users.manage");
  const users = await listUsers(user);
  return (
    <>
      <PageHeader title="Users" description="Create accounts, assign roles and colours, and control what viewers can see." />
      <UsersManager users={users} currentUserId={user.id} />
    </>
  );
}
