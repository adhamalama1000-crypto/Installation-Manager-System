import Image from "next/image";
import { cn } from "@/lib/utils";

/** Pixel size of /brand/logo.png, a straight crop of the supplied OR VIP Tech Solutions artwork. */
const LOGO_W = 1025;
const LOGO_H = 405;
const ALT = "OR VIP Tech Solutions";

/**
 * The supplied OR VIP logo, unmodified (cropped only, never recoloured or redrawn). The artwork
 * carries its own deep-navy background, so it is always shown as a navy plate:
 * - `onDark`  (navigation, dark theme): the plate sits flush, no frame.
 * - `onLight` (white or soft-grey pages): a thin silver ring and a small radius frame the plate,
 *   so it reads as a deliberate brand badge instead of a dark rectangle on a light page.
 */
export function Logo({
  width = 160,
  className,
  priority,
  variant = "onLight",
}: {
  width?: number;
  className?: string;
  priority?: boolean;
  variant?: "onLight" | "onDark";
}) {
  const height = Math.round((width * LOGO_H) / LOGO_W);
  return (
    <span
      className={cn(
        "inline-flex overflow-hidden bg-[#13295a]",
        variant === "onLight" ? "rounded-xl ring-1 ring-[#dce4f2] dark:ring-white/10" : "rounded-lg",
        className,
      )}
    >
      <Image src="/brand/logo.png" alt={ALT} width={width} height={height} priority={priority} className="block h-auto" style={{ width, height: "auto" }} />
    </span>
  );
}

/** The OR VIP globe emblem (the "O" of the logo), for compact places: mobile header, favicons. */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 overflow-hidden rounded-lg bg-[#13295a]", className)} style={{ width: size, height: size }}>
      <Image src="/brand/mark.png" alt="OR VIP" width={size} height={size} />
    </span>
  );
}
