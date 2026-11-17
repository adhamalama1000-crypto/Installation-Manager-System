import Link from "next/link";
import type { Metadata } from "next";
import { History, Plus } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { BackArrow, Badge, PageHeader } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { requirePagePermission } from "@/server/auth/session";
import { listAccessRoles } from "@/server/services/access-roles";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("accessRoles.title") };
}

/** Built-in roles (their defaults) and the Admin's custom roles. */
export default async function RolesPage() {
  const [user, t] = await Promise.all([requirePagePermission("users.manage"), getT()]);
  const roles = await listAccessRoles(user);
  const name = (x: { name: string; nameAr: string | null }) => (t.locale === "ar" && x.nameAr ? x.nameAr : x.name);
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/users" className="hover:text-fg">
            <BackArrow /> {t("access.back")}
          </Link>
        }
        title={t("accessRoles.title")}
        description={t("accessRoles.text")}
        actions={
          <>
            <ButtonLink href="/audit?module=users" variant="outline">
              <History className="h-4 w-4" /> {t("accessRoles.history")}
            </ButtonLink>
            <ButtonLink href="/users/roles/new">
              <Plus className="h-4 w-4" /> {t("accessRoles.add")}
            </ButtonLink>
          </>
        }
      />
      <div className="space-y-6">
        <Card className="overflow-hidden">
          <CardHeader title={t("accessRoles.customTitle")} description={t("accessRoles.customText")} />
          {roles.custom.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-fg-muted">{t("accessRoles.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm" aria-label={t("accessRoles.customTitle")}>
                <thead className="bg-surface-muted/60 text-xs text-fg-muted">
                  <tr>
                    <th className="px-4 py-2 text-start font-medium">{t("accessRoles.name")}</th>
                    <th className="px-4 py-2 text-start font-medium">{t("accessRoles.baseRole")}</th>
                    <th className="px-4 py-2 text-start font-medium">{t("accessRoles.permissions")}</th>
                    <th className="px-4 py-2 text-start font-medium">{t("accessRoles.people")}</th>
                    <th className="px-4 py-2 text-start font-medium">{t("accessRoles.status")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {roles.custom.map((r) => (
                    <tr key={r.id} data-role={r.name}>
                      <td className="px-4 py-2.5">
                        <Link href={`/users/roles/${r.id}`} className="font-medium text-brand-text hover:underline" dir="auto">
                          {name(r)}
                        </Link>
                        {r.description && (
                          <p className="text-xs text-fg-muted" dir="auto">
                            {r.description}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2.5">{t.dyn(`enums.role.${r.baseRole}`, undefined, r.baseRole)}</td>
                      <td className="px-4 py-2.5 tabular-nums">{r.permissions.length}</td>
                      <td className="px-4 py-2.5 tabular-nums">{r.people}</td>
                      <td className="px-4 py-2.5">{r.isActive ? <Badge>{t("common.active")}</Badge> : <Badge className="bg-surface-muted">{t("common.inactive")}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title={t("accessRoles.builtInTitle")} description={t("accessRoles.builtInText")} />
          <ul className="divide-y divide-line">
            {roles.builtIn.map((r) => (
              <li key={r.role} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between" data-builtin-role={r.role}>
                <div className="min-w-0">
                  <p className="font-medium">{t.dyn(`enums.role.${r.role}`, undefined, r.role)}</p>
                  <p className="text-xs text-fg-muted">{t.dyn(`users.roleHelp.${r.role}`, undefined, "")}</p>
                  <p className="mt-1 text-xs text-fg-subtle">
                    {t("accessRoles.builtInCounts", { permissions: r.permissions.length, people: r.people })}
                  </p>
                </div>
                {r.role !== "ADMIN" && (
                  <ButtonLink href={`/users/roles/new?base=${r.role}`} variant="outline" size="sm">
                    <Plus className="h-3.5 w-3.5" /> {t("accessRoles.fromBuiltIn")}
                  </ButtonLink>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
