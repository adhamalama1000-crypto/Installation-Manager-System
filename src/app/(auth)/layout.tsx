import { Logo } from "@/components/layout/logo";
import { APP_NAME } from "@/lib/constants";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-white p-12 lg:flex">
        <div aria-hidden className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[#E55823]/10" />
        <div aria-hidden className="absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-[#E55823]/[0.07]" />
        <div className="relative flex flex-1 flex-col items-center justify-center gap-10">
          <Logo width={300} priority className="p-0" />
        </div>
        <div className="relative">
          <p className="text-2xl font-semibold text-[#292929]">{APP_NAME}</p>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-[#5f5f5c]">
            Book installations, coordinate technicians and keep every customer visit on schedule.
          </p>
        </div>
      </section>
      <section className="flex flex-col items-center justify-center px-5 py-10 sm:px-8">
        <div className="mb-8 lg:hidden">
          <Logo width={150} priority />
        </div>
        <div className="w-full max-w-sm">{children}</div>
      </section>
    </div>
  );
}
