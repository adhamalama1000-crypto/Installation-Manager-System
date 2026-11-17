import Link from "next/link";
import type { Metadata } from "next";
import { RoleEditor } from "@/components/users/role-editor";
import { BackArrow, PageHeader } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { ROLES } from "@/lib/constants";
import { PERMISSIONS, roleDefaults } from "@/lib/permissions";
import { scopesFor } from "@/lib/permission-registry";
import { requirePagePermission } from "@/server/auth/session";
import { assignable } from "@/server/services/access-control";
import { getAccessRole } from "@/server/services/access-roles";
import type { Role } from "@prisma/client";
import { loadOr404 } from "../../../appointments/[id]/load";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("accessRoles.title") };
}

/** Create (id "new", optionally ?base=ROLE) or edit a custom role (Admin). */
export default async function RoleEditPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ base?: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("users.manage"), getT()]);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  let role;
  if (id === "new") {
    const base = (ROLES as string[]).includes(sp.base ?? "") && sp.base !== "ADMIN" ? (sp.base as Role) : "SALES";
    const defaults = roleDefaults({ role: base }, user.settings);
    role = {
      id: null,
      name: "",
      nameAr: null,
      description: null,
      baseRole: base,
      isActive: true,
      version: 1,
      permissions: PERMISSIONS.filter((p) => defaults.has(p)),
      scopes: scopesFor({ role: base, permissions: defaults }, null),
      baseDefaults: PERMISSIONS.filter((p) => defaults.has(p)),
      baseScopes: scopesFor({ role: base, permissions: defaults }, null),
      assignable: PERMISSIONS.filter((p) => assignable(base, p)),
      members: [],
    };
  } else {
    role = await loadOr404(() => getAccessRole(user, id));
  }
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/users/roles" className="hover:text-fg">
            <BackArrow /> {t("accessRoles.back")}
          </Link>
        }
        title={role.id ? t("accessRoles.editTitle", { name: role.name }) : t("accessRoles.add")}
        description={t("accessRoles.editText")}
      />
      <RoleEditor key={`${role.id}|${role.version}|${role.baseRole}`} role={role} />
    </>
  );
}
