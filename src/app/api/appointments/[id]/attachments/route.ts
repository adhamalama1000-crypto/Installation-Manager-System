import { apiRoute } from "@/server/http";
import { authorizeAttachmentUpload, listAttachments, uploadAttachment } from "@/server/services/attachments";
import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, readLimitedBody } from "@/server/storage";

export const GET = apiRoute(async ({ user, params }) => listAttachments(user, params.id!));

/**
 * Body: the file's bytes (image/*, or video/* for ?kind=VIDEO); ?kind=AFTER_PHOTO etc.
 * The caller's right to add this kind to this visit is checked before a single byte of the body
 * is read; the body is then read with a size limit, timeouts and a per-process memory budget.
 */
export const POST = apiRoute(async ({ req, user, params }) => {
  const kind = new URL(req.url).searchParams.get("kind");
  try {
    await authorizeAttachmentUpload(user, params.id!, kind);
  } catch (e) {
    // Refused without receiving the file.
    void req.body?.cancel().catch(() => undefined);
    throw e;
  }
  return { attachment: await uploadAttachment(user, params.id!, kind, await readLimitedBody(req, kind === "VIDEO" ? MAX_VIDEO_BYTES : MAX_UPLOAD_BYTES)) };
});
