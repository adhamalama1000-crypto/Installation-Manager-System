import { requirePagePermission } from "@/server/auth/session";

/**
 * Stock on hand, documents and the ledger: access is checked here, before any loading skeleton streams, so a user without
 * `inventory.view` gets a real redirect to the access-denied page (pages check finer rights).
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePagePermission("inventory.view");
  return children;
}
