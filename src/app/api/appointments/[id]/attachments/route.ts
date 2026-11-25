import { apiRoute } from "@/server/http";
import { authorizeAttachmentUpload, listAttachments, uploadAttachment } from "@/server/services/attachments";
import { authorizeThenRead, MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES } from "@/server/storage";

export const GET = apiRoute(async ({ user, params }) => listAttachments(user, params.id!));

/**
 * Body: the file's bytes (image/*, or video/* for ?kind=VIDEO); ?kind=AFTER_PHOTO etc.
 * The caller's right to add this kind to this visit is checked before a single byte of the body
 * is read; the body is then read with a size limit, timeouts and a per-user share of the memory budget.
 */
export const POST = apiRoute(async ({ req, user, params }) => {
  const kind = new URL(req.url).searchParams.get("kind");
  // The upload's reservation lasts until the attachment is stored (or refused), not just the read.
  const attachment = await authorizeThenRead(req, user.id, kind === "VIDEO" ? MAX_VIDEO_BYTES : MAX_UPLOAD_BYTES, () => authorizeAttachmentUpload(user, params.id!, kind), (bytes) => uploadAttachment(user, params.id!, kind, bytes));
  return { attachment };
});
