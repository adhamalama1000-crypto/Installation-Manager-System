import { apiRoute } from "@/server/http";
import { locateAttachment, readAttachment, removeAttachment } from "@/server/services/attachments";
import { parseRange, streamStoredFile } from "@/server/storage";

const CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

/**
 * The file itself, only for readers who may see it. Ids never change content, so the browser may
 * keep it. Videos are streamed and answer range requests (players fetch them in parts, and Safari
 * plays nothing without them).
 */
export const GET = apiRoute(async ({ req, user, params }) => {
  const id = params.id!;
  const base = { "Cache-Control": "private, max-age=31536000, immutable", "Content-Disposition": "inline", "Content-Security-Policy": CSP };
  const located = await locateAttachment(user, id);
  if (located.contentType.startsWith("video/")) {
    const { storageKey, contentType, size } = located;
    const range = parseRange(req.headers.get("range"), size);
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    return new Response(streamStoredFile(storageKey, start, end), {
      status: range ? 206 : 200,
      headers: {
        ...base,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      },
    });
  }
  const file = await readAttachment(user, id);
  return new Response(new Uint8Array(file.bytes), {
    headers: { ...base, "Content-Type": file.contentType, "Content-Length": String(file.bytes.byteLength) },
  });
});

export const DELETE = apiRoute(async ({ user, params }) => {
  await removeAttachment(user, params.id!);
  return { ok: true };
});
