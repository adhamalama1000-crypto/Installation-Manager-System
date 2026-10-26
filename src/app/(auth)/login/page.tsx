import type { Metadata } from "next";
import { getI18n } from "@/i18n/server";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { safeNextPath as safeNext } from "@/lib/safe-redirect";
import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t("auth.signIn") };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getCurrentUser()) redirect(safeNext(next));
  return <LoginForm next={safeNext(next)} />;
}
