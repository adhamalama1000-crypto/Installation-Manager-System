import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Location and the camera are allowed for this site only (never for embedded third parties):
  // technicians check in with the location and clock in with a live-camera photo.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self)" },
];

// Development only: Next.js serves its dev scripts to localhost alone. To open the dev server
// from another address (the machine's network IP or name), list those hostnames, comma
// separated, e.g. ALLOWED_DEV_ORIGINS="192.168.1.20,my-pc.local". Without that, the page loads
// but its scripts are blocked, and signing in only reloads the login page.
const allowedDevOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
  serverExternalPackages: ["bcryptjs"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
