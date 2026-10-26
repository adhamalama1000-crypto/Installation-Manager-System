import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Arabic, Poppins } from "next/font/google";
import { Toaster } from "sonner";
import { I18nProvider } from "@/i18n/client";
import { getI18n } from "@/i18n/server";
import "./globals.css";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-poppins",
  display: "swap",
});

/** Arabic text; Latin characters inside Arabic text still use Poppins (listed first). */
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-arabic",
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  const name = t("app.name");
  return {
    title: { default: name, template: `%s · ${name}` },
    description: t("app.tagline"),
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
  const { locale, dir, tz } = await getI18n();
  return (
    <html lang={locale} dir={dir} className={`${poppins.variable} ${plexArabic.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-bg text-fg antialiased">
        <I18nProvider locale={locale} tz={tz}>
          {children}
        </I18nProvider>
        <Toaster position={dir === "rtl" ? "top-left" : "top-right"} dir={dir} richColors closeButton toastOptions={{ className: "font-sans" }} />
      </body>
    </html>
  );
}
