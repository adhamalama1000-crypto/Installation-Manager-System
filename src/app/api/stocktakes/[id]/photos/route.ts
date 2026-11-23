import { NextResponse } from "next/server";
import { apiRoute } from "@/server/http";
import { authorizeStocktakePhotoUpload, uploadStocktakePhoto } from "@/server/services/stocktakes";
import { authorizeThenRead, MAX_UPLOAD_BYTES } from "@/server/storage";

/** Body: the image bytes; ?lineId= ties it to one line. The caller's right is checked before the body is read. */
export const POST = apiRoute(async ({ req, user, params }) => {
  const raw = new URL(req.url).searchParams.get("lineId");
  const lineId = raw ? raw.slice(0, 64) : null;
  const bytes = await authorizeThenRead(req, user.id, MAX_UPLOAD_BYTES, () => authorizeStocktakePhotoUpload(user, params.id!, lineId));
  return NextResponse.json({ photo: await uploadStocktakePhoto(user, params.id!, lineId, bytes) }, { status: 201 });
});
