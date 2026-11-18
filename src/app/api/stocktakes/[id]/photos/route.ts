import { NextResponse } from "next/server";
import { apiRoute } from "@/server/http";
import { uploadStocktakePhoto } from "@/server/services/stocktakes";
import { MAX_UPLOAD_BYTES, readLimitedBody } from "@/server/storage";

/** Body: the image bytes; ?lineId= ties it to one line. */
export const POST = apiRoute(async ({ req, user, params }) => {
  const lineId = new URL(req.url).searchParams.get("lineId");
  return NextResponse.json({ photo: await uploadStocktakePhoto(user, params.id!, lineId ? lineId.slice(0, 64) : null, await readLimitedBody(req, MAX_UPLOAD_BYTES)) }, { status: 201 });
});
