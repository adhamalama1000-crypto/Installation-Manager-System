"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useT } from "@/i18n/client";
import { canvasBlob } from "@/lib/image";

/** A box the customer signs in with a finger, mouse or pen; saved as a PNG (dark ink on white). */
export function SignaturePad({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (png: Blob) => Promise<void> }) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Sized once the dialog is open, to the box's real width (sharp on high-density screens).
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const c = canvasRef.current;
      if (!c) return;
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      c.width = Math.round(c.clientWidth * ratio);
      c.height = Math.round(c.clientHeight * ratio);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.lineWidth = 2.5 * ratio;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#111827";
      setEmpty(true);
      setError(null);
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * c.width) / r.width, y: ((e.clientY - r.top) * c.height) / r.height };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = e.currentTarget.getContext("2d")!;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y + 0.1);
    ctx.stroke();
    setEmpty(false);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d")!;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function clear() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    setEmpty(true);
  }

  async function save() {
    const c = canvasRef.current;
    if (!c) return;
    if (empty) {
      setError(t("attachments.signEmpty"));
      return;
    }
    setBusy(true);
    try {
      await onSave(await canvasBlob(c, "image/png"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("attachments.signTitle")}
      description={t("attachments.signText")}
      footer={
        <>
          <Button variant="ghost" onClick={clear} disabled={busy}>
            {t("attachments.clear")}
          </Button>
          <Button onClick={save} loading={busy}>
            {t("attachments.saveSignature")}
          </Button>
        </>
      }
    >
      <canvas
        ref={canvasRef}
        aria-label={t("attachments.signTitle")}
        className="h-52 w-full touch-none rounded-lg border border-line-strong bg-white"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={() => (drawing.current = false)}
        onPointerCancel={() => (drawing.current = false)}
      />
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Dialog>
  );
}
