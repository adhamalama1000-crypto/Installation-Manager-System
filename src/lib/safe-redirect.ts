/**
 * Only allows same-site relative paths after login. Rejects protocol-relative URLs ("//x"),
 * backslash tricks ("/\x", which browsers treat as "//x"), control characters and API paths.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || next.length > 500) return "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\\]/.test(next)) return "/";
  if (next.startsWith("/api")) return "/";
  return next;
}
