import { ShieldCheck } from "lucide-react";
import { LanguageSwitch } from "@/components/layout/language-switch";
import { Logo } from "@/components/layout/logo";
import { getT } from "@/i18n/server";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getT();
  return (
    <div className="grid min-h-dvh grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel: Deep Navy, the logo on its own navy plate, one thin Electric Blue rule. */}
      <section className="relative hidden flex-col justify-between overflow-hidden bg-nav p-12 text-nav-fg lg:flex">
        <div className="flex flex-1 flex-col items-center justify-center">
          <Logo width={420} priority variant="onDark" className="shadow-[0_0_0_1px_rgb(220_228_242/0.08)]" />
        </div>
        <div>
          <span aria-hidden className="mb-5 block h-0.5 w-12 rounded-full bg-accent" />
          <p className="text-2xl font-semibold text-white">{t("app.name")}</p>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-nav-muted">{t("app.tagline")}</p>
          <p className="mt-6 flex items-center gap-2 text-xs text-nav-muted">
            <ShieldCheck className="h-4 w-4 text-accent" aria-hidden /> {"OR VIP Tech Solutions"}
          </p>
        </div>
      </section>
      <section className="relative flex flex-col items-center justify-center bg-bg px-5 py-10 sm:px-8">
        <LanguageSwitch className="absolute end-4 top-4" />
        <div className="mb-8 mt-8 lg:mt-0 lg:hidden">
          <Logo width={220} priority />
        </div>
        <div className="w-full max-w-sm">{children}</div>
      </section>
    </div>
  );
}
