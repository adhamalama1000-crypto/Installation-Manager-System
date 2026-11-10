"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ImagePlus, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { useT } from "@/i18n/client";
import { api, ApiError, apiUpload } from "@/lib/api-client";
import { preparePhoto } from "@/lib/image";

/** Product photos: add (shrunk in the browser first), put one first, remove. */
export function ProductImages({ productId, productName, images, manage, max = 8 }: { productId: string; productName: string; images: { id: string; url: string }[]; manage: boolean; max?: number }) {
  const t = useT();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    let added = 0;
    try {
      for (const f of Array.from(files).slice(0, Math.max(0, max - images.length))) {
        const blob = await preparePhoto(f).catch(() => null);
        if (!blob) {
          toast.error(t("attachments.errors.read"));
          continue;
        }
        await apiUpload(`/api/products/${productId}/images`, blob);
        added++;
      }
      if (added) toast.success(t("productImages.added", { count: added }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.couldNotSave"));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
      router.refresh();
    }
  }
  async function act(fn: () => Promise<unknown>, done?: string) {
    try {
      await fn();
      if (done) toast.success(done);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("common.couldNotSave"));
    }
  }

  return (
    <Card>
      <CardHeader
        title={t("productImages.title")}
        actions={
          manage && images.length < max ? (
            <>
              <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" aria-label={t("productImages.add")} onChange={(e) => void add(e.target.files)} />
              <Button type="button" size="sm" variant="outline" loading={busy} onClick={() => input.current?.click()}>
                <ImagePlus className="h-4 w-4" /> {t("productImages.add")}
              </Button>
            </>
          ) : undefined
        }
      />
      {images.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-fg-muted">{t("productImages.none")}</p>
      ) : (
        <ul className="grid grid-cols-3 gap-3 px-5 pb-5 sm:grid-cols-4">
          {images.map((img, i) => (
            <li key={img.id} className="group relative overflow-hidden rounded-lg border border-line bg-surface-muted">
              {/* eslint-disable-next-line @next/next/no-img-element -- private, permission-checked file */}
              <img src={img.url} alt={t("productImages.alt", { product: productName })} className="aspect-square w-full object-cover" loading="lazy" />
              {manage && (
                <div className="absolute inset-x-0 bottom-0 flex justify-between bg-black/50 p-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  {i > 0 ? (
                    <button type="button" className="rounded p-1 text-white hover:bg-white/20" aria-label={t("productImages.makeFirst")} title={t("productImages.makeFirst")} onClick={() => void act(() => api(`/api/product-images/${img.id}/first`, { method: "POST", body: {} }))}>
                      <Star className="h-4 w-4" />
                    </button>
                  ) : (
                    <span />
                  )}
                  <button type="button" className="rounded p-1 text-white hover:bg-white/20" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => void act(() => api(`/api/product-images/${img.id}`, { method: "DELETE" }), t("productImages.removed"))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
