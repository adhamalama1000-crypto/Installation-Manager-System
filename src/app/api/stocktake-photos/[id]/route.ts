import { apiRoute } from "@/server/http";
import { readStocktakePhoto, removeStocktakePhoto } from "@/server/services/stocktakes";

/** The photo itself (people who count or approve in that warehouse). */
export const GET = apiRoute(async ({ user, params }) => {
  const file = await readStocktakePhoto(user, params.id!);
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
  await removeStocktakePhoto(user, params.id!);
  return { ok: true };
});
