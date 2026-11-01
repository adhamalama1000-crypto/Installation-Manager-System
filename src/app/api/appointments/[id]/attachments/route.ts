import { apiRoute } from "@/server/http";
import { listAttachments, uploadAttachment } from "@/server/services/attachments";
import { MAX_UPLOAD_BYTES, readLimitedBody } from "@/server/storage";

export const GET = apiRoute(async ({ user, params }) => listAttachments(user, params.id!));

/** Body: the image bytes (Content-Type image/*); ?kind=AFTER_PHOTO etc. */
export const POST = apiRoute(async ({ req, user, params }) => ({
  attachment: await uploadAttachment(user, params.id!, new URL(req.url).searchParams.get("kind"), await readLimitedBody(req, MAX_UPLOAD_BYTES)),
}));
