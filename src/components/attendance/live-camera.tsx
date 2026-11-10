"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n/client";
import { canvasBlob } from "@/lib/image";

export type CameraState = "starting" | "live" | "denied" | "unavailable";

/**
 * The front camera, live, with a "take photo" button. The picture comes from the video stream at
 * the moment of the press (getUserMedia), never from the gallery, and is shrunk to a small JPEG in
 * the browser (no location metadata: a canvas has none). The stream is stopped when the photo is
 * taken and when the component unmounts.
 */
export function LiveCamera({ onPhoto, photoUrl, onRetake }: { onPhoto: (blob: Blob) => void; photoUrl: string | null; onRetake: () => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>("starting");

  function stop() {
    stream.current?.getTracks().forEach((tr) => tr.stop());
    stream.current = null;
  }

  async function start() {
    stop();
    setState("starting");
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("unavailable");
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 960 } }, audio: false });
      stream.current = s;
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play().catch(() => undefined);
      }
      setState("live");
    } catch (e) {
      setState(e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError") ? "denied" : "unavailable");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening the camera (an external system) reports its state
    if (!photoUrl) void start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoUrl]);

  async function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const side = Math.min(v.videoWidth, v.videoHeight);
    const size = Math.min(720, side);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    // Square crop from the centre; mirrored like the preview, so the person sees what they saw.
    ctx.translate(size, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, size, size);
    const blob = await canvasBlob(canvas, "image/jpeg", 0.82);
    stop();
    onPhoto(blob);
  }

  if (photoUrl) {
    return (
      <div className="space-y-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- a local preview (blob URL) */}
        <img src={photoUrl} alt={t("clock.photoTaken")} className="mx-auto aspect-square w-full max-w-xs rounded-xl border border-line object-cover" />
        <div className="text-center">
          <Button type="button" variant="ghost" size="sm" onClick={onRetake}>
            <RefreshCw className="h-4 w-4" /> {t("clock.retake")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="relative mx-auto aspect-square w-full max-w-xs overflow-hidden rounded-xl border border-line bg-black">
        <video ref={video} playsInline muted className="h-full w-full -scale-x-100 object-cover" aria-label={t("clock.cameraPreview")} />
        {state !== "live" && (
          <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-white" role="status">
            {state === "starting" ? t("clock.cameraStarting") : state === "denied" ? t("clock.cameraDenied") : t("clock.cameraUnavailable")}
          </p>
        )}
      </div>
      <div className="flex justify-center gap-2">
        {state === "live" ? (
          <Button type="button" onClick={() => void capture()}>
            <Camera className="h-4 w-4" /> {t("clock.takePhoto")}
          </Button>
        ) : (
          state !== "starting" && (
            <Button type="button" variant="outline" onClick={() => void start()}>
              <RefreshCw className="h-4 w-4" /> {t("clock.tryCamera")}
            </Button>
          )
        )}
      </div>
    </div>
  );
}
