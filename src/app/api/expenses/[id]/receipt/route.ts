import { apiRoute } from "@/server/http";
import { addReceipt, authorizeReceiptUpload, readReceipt } from "@/server/services/expenses";
import { authorizeThenRead, MAX_UPLOAD_BYTES } from "@/server/storage";

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

/** Body: the image bytes. The caller's right to add a receipt to this expense is checked before the body is read. */
export const POST = apiRoute(async ({ req, user, params }) => ({
  expense: await addReceipt(user, params.id!, await authorizeThenRead(req, user.id, MAX_UPLOAD_BYTES, () => authorizeReceiptUpload(user, params.id!))),
}));
