import { LanguageSwitch } from "@/components/layout/language-switch";
import { Logo } from "@/components/layout/logo";
import { getT } from "@/i18n/server";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getT();
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden border-e border-line bg-white p-12 lg:flex">
        <div aria-hidden className="absolute -end-24 -top-24 h-72 w-72 rounded-full bg-[#E55823]/10" />
        <div aria-hidden className="absolute -bottom-32 -start-20 h-80 w-80 rounded-full bg-[#E55823]/[0.07]" />
        <div className="relative flex flex-1 flex-col items-center justify-center gap-10">
          <Logo width={300} priority className="p-0" />
        </div>
        <div className="relative">
          <p className="text-2xl font-semibold text-[#292929]">{t("app.name")}</p>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-[#5f5f5c]">{t("app.tagline")}</p>
        </div>
      </section>
      <section className="relative flex flex-col items-center justify-center px-5 py-10 sm:px-8">
        <LanguageSwitch className="absolute end-4 top-4" />
        <div className="mb-8 mt-8 lg:mt-0 lg:hidden">
          <Logo width={150} priority />
        </div>
        <div className="w-full max-w-sm">{children}</div>
      </section>
    </div>
  );
}
