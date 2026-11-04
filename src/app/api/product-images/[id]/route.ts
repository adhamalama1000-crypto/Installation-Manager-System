import { apiRoute } from "@/server/http";
import { readProductImage, removeProductImage } from "@/server/services/product-images";

/** The image itself (catalogue readers only). Ids never change content, so the browser may keep it. */
export const GET = apiRoute(async ({ user, params }) => {
  const file = await readProductImage(user, params.id!);
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.byteLength),
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    },
  });
});

export const DELETE = apiRoute(async ({ user, params }) => {
  await removeProductImage(user, params.id!);
  return { ok: true };
});
