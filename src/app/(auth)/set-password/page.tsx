import type { Metadata } from "next";
import { SetPasswordForm } from "./set-password-form";
import { Alert } from "@/components/ui/misc";

export const metadata: Metadata = { title: "Set password" };

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) {
    return <Alert tone="danger" title="Missing link">Open the full link you received from your administrator.</Alert>;
  }
  return <SetPasswordForm token={token} />;
}
