import { apiRoute } from "@/server/http";
import { listAttachments, uploadAttachment } from "@/server/services/attachments";
import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, readLimitedBody } from "@/server/storage";

export const GET = apiRoute(async ({ user, params }) => listAttachments(user, params.id!));

/** Body: the file's bytes (image/*, or video/* for ?kind=VIDEO); ?kind=AFTER_PHOTO etc. */
export const POST = apiRoute(async ({ req, user, params }) => {
  const kind = new URL(req.url).searchParams.get("kind");
  return { attachment: await uploadAttachment(user, params.id!, kind, await readLimitedBody(req, kind === "VIDEO" ? MAX_VIDEO_BYTES : MAX_UPLOAD_BYTES)) };
});
