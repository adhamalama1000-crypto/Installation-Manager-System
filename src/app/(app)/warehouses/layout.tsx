import { requirePagePermission } from "@/server/auth/session";

/**
 * Warehouses, vans and bins: access is checked here, before any loading skeleton streams, so a user without
 * `warehouses.view` gets a real redirect to the access-denied page (pages check finer rights).
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePagePermission("warehouses.view");
  return children;
}
