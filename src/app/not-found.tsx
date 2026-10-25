import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-semibold text-brand-text">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="max-w-sm text-sm text-fg-muted">The page or record does not exist, or you do not have access to it.</p>
      <Link href="/" className="mt-2 text-sm font-medium text-brand-text hover:underline">
        Go to dashboard
      </Link>
    </div>
  );
}
