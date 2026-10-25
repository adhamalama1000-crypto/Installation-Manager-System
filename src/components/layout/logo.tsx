import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * The supplied company logo, unmodified. It has a white background, so in dark mode it sits on a
 * white tile instead of being recoloured.
 */
export function Logo({ width = 120, className, priority }: { width?: number; className?: string; priority?: boolean }) {
  const height = Math.round((width * 842) / 1062);
  return (
    <span className={cn("inline-flex rounded-xl bg-white p-2 dark:ring-1 dark:ring-white/10", className)}>
      <Image src="/brand/logo.png" alt="aura. Smart Home Systems" width={width} height={height} priority={priority} className="h-auto" style={{ width, height: "auto" }} />
    </span>
  );
}

export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex overflow-hidden rounded-lg bg-white", className)} style={{ width: size, height: size }}>
      <Image src="/brand/mark.png" alt="aura." width={size} height={size} />
    </span>
  );
}
