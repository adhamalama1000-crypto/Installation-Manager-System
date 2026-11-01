import { apiRoute } from "@/server/http";
import { readAttachment, removeAttachment } from "@/server/services/attachments";

/** The file itself, only for readers who may see it. Ids never change content, so the browser may keep it. */
export const GET = apiRoute(async ({ user, params }) => {
  const file = await readAttachment(user, params.id!);
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
  await removeAttachment(user, params.id!);
  return { ok: true };
});
