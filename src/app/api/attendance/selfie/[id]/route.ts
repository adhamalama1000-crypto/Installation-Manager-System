import { apiRoute } from "@/server/http";
import { readSelfie } from "@/server/services/attendance";

/** The photo of a clock-in / out: the person and attendance managers only. */
export const GET = apiRoute(async ({ user, params }) => {
  const file = await readSelfie(user, params.id!);
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.byteLength),
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    },
  });
});
