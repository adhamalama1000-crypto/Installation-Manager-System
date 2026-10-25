import { AppShell } from "@/components/layout/app-shell";
import { requireUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <AppShell user={{ name: user.name, email: user.email, role: user.role, color: user.color, permissions: user.permissions }}>
      {children}
    </AppShell>
  );
}
