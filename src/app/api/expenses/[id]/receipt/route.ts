import { apiRoute } from "@/server/http";
import { addReceipt, readReceipt } from "@/server/services/expenses";
import { MAX_UPLOAD_BYTES, readLimitedBody } from "@/server/storage";

/** The receipt photo, only for its owner and the accountant. */
export const GET = apiRoute(async ({ user, params }) => {
  const file = await readReceipt(user, params.id!);
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

/** Body: the image bytes. */
export const POST = apiRoute(async ({ req, user, params }) => ({ expense: await addReceipt(user, params.id!, await readLimitedBody(req, MAX_UPLOAD_BYTES)) }));
