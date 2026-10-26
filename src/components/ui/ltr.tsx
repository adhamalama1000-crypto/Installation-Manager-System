import { cn } from "@/lib/utils";

/**
 * A Latin value (phone number, appointment code, serial, e-mail, URL, amount) inside text that may
 * be Arabic: isolated and left-to-right so it is never reversed or reordered.
 */
export function Ltr({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={cn("ltr-value", className)}>
      {children}
    </bdi>
  );
}
