import { redirect } from "next/navigation";
import { hasPermission } from "@/server/access";
import { requireUser } from "@/server/auth/session";

/**
 * Stocktakes are for people who count or approve. Checked here, before any loading skeleton
 * streams, so everyone else gets a real redirect to the access-denied page.
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (!hasPermission(user, "inventory.count") && !hasPermission(user, "inventory.approve")) redirect("/access-denied");
  return children;
}
