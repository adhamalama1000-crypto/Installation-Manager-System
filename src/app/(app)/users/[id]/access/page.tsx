import Link from "next/link";
import type { Metadata } from "next";
import { PermissionEditor } from "@/components/users/permission-editor";
import { BackArrow, Badge, PageHeader } from "@/components/ui/misc";
import { getT } from "@/i18n/server";
import { requirePagePermission } from "@/server/auth/session";
import { getUserAccess } from "@/server/services/access-control";
import { loadOr404 } from "../../../appointments/[id]/load";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())("access.link") };
}

/** One person's permissions, data scopes and team (Admin). */
export default async function UserAccessPage({ params }: { params: Promise<{ id: string }> }) {
  const [user, t] = await Promise.all([requirePagePermission("users.manage"), getT()]);
  const { id } = await params;
  const access = await loadOr404(() => getUserAccess(user, id));
  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/users" className="hover:text-fg">
            <BackArrow /> {t("access.back")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {t("access.title", { name: access.user.name })}
            <Badge className="text-sm">{t.dyn(`enums.role.${access.user.role}`, undefined, access.user.role)}</Badge>
            {!access.user.isActive && <Badge>{t("common.inactive")}</Badge>}
          </span>
        }
        description={t("access.text")}
      />
      {/* Re-mounted after every save so it starts from what the server stored. */}
      <PermissionEditor key={`${access.effective.join(",")}|${JSON.stringify(access.scopes)}|${access.user.teamId}`} {...access} />
    </>
  );
}
