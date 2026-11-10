"use client";

import { forwardRef, useCallback, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/utils";
import { Input } from "./field";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

/**
 * A password field with a show / hide button inside it.
 *
 * - The button is a real `<button type="button">`, so it never submits the form, and Enter or
 *   Space toggle it from the keyboard. `aria-pressed` tells screen readers the current state and
 *   the icon shows it (an open eye = hidden, press to show; a crossed eye = shown, press to hide).
 * - A mouse or touch press does not take the focus away from the field (mousedown is prevented),
 *   and the caret / selection is put back after the type changes, so typing can simply continue.
 * - The value is a controlled prop of the parent and is never touched here.
 * - The field and its button are laid out left-to-right in both languages: passwords are typed
 *   left to right, and the button must sit on the side the field keeps free for it. (Before, on
 *   the Arabic page the button was drawn on the left while the left-to-right field kept the
 *   right side free, so the icon covered the first characters.)
 */
export const PasswordInput = forwardRef<HTMLInputElement, Props>(function PasswordInput({ className, id, ...props }, ref) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const inner = useRef<HTMLInputElement | null>(null);
  const setRefs = useCallback(
    (el: HTMLInputElement | null) => {
      inner.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  function toggle() {
    const el = inner.current;
    const focused = !!el && document.activeElement === el;
    const start = el?.selectionStart ?? null;
    const end = el?.selectionEnd ?? null;
    setVisible((v) => !v);
    if (el && focused) {
      // After React swaps the type, put the caret back where it was.
      requestAnimationFrame(() => {
        el.focus();
        if (start !== null && end !== null) el.setSelectionRange(start, end);
      });
    }
  }

  const label = visible ? t("auth.hidePassword") : t("auth.showPassword");
  return (
    <div className="relative" dir="ltr">
      <Input
        {...props}
        id={id}
        ref={setRefs}
        type={visible ? "text" : "password"}
        dir="ltr"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn("pe-10", className)}
        data-password-visible={visible ? "true" : "false"}
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        aria-label={label}
        title={label}
        aria-pressed={visible}
        aria-controls={id}
        disabled={props.disabled}
        className="absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-e-lg text-fg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50"
      >
        {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
});
