"use client";

/**
 * Shrinks a photo in the browser before upload: at most `maxSide` pixels on the long side,
 * re-encoded as JPEG. Re-encoding also drops the photo's metadata (EXIF, including where it was
 * taken). Throws when the browser cannot decode the file (e.g. HEIC on some desktop browsers).
 */
export async function preparePhoto(file: Blob, maxSide = 1600, quality = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas");
    // Transparent PNG areas would turn black in JPEG.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvasBlob(canvas, "image/jpeg", quality);
  } finally {
    bitmap.close();
  }
}

export function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Encoding failed"))), type, quality));
}
