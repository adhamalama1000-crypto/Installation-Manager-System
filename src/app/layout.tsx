import type { Metadata, Viewport } from "next";
import { Cairo, Poppins } from "next/font/google";
import { Toaster } from "sonner";
import { dirOf } from "@/i18n/config";
import { I18nProvider } from "@/i18n/client";
import { getLocale, getT } from "@/i18n/server";
import "./globals.css";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-poppins",
  display: "swap",
});

// Arabic text (as in the original Aura app); Latin letters and digits keep Poppins.
const cairo = Cairo({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-cairo",
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: { default: t("app.name"), template: `%s · ${t("app.name")}` },
    description: t("app.description"),
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0b" },
  ],
};

// Applies the saved theme before first paint (no flash). Falls back to the OS preference.
const themeScript = `(() => {
  try {
    const t = localStorage.getItem("ims-theme");
    const dark = t === "dark" || ((!t || t === "system") && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch {}
})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const dir = dirOf(locale);
  return (
    <html lang={locale} dir={dir} className={`${poppins.variable} ${cairo.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-bg text-fg antialiased">
        <I18nProvider locale={locale}>
          {children}
          <Toaster position={dir === "rtl" ? "top-left" : "top-right"} dir={dir} richColors closeButton toastOptions={{ className: "font-sans" }} />
        </I18nProvider>
      </body>
    </html>
  );
}
