import { requirePagePermission } from "@/server/auth/session";

/**
 * Product catalogue: access is checked here, before any loading skeleton streams, so a user without
 * `products.view` gets a real redirect to the access-denied page (pages check finer rights).
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePagePermission("products.view");
  return children;
}
