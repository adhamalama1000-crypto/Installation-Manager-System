import { NextResponse } from "next/server";
import { apiRoute } from "@/server/http";
import { authorizeProductImageUpload, listProductImages, uploadProductImage } from "@/server/services/product-images";
import { authorizeThenRead, MAX_UPLOAD_BYTES } from "@/server/storage";

export const GET = apiRoute(async ({ user, params }) => ({ images: await listProductImages(user, params.id!) }));

/** Body: the image bytes (JPEG, PNG or WebP; the type is read from the bytes). The caller's right is checked before the body is read. */
export const POST = apiRoute(async ({ req, user, params }) => {
  const bytes = await authorizeThenRead(req, user.id, MAX_UPLOAD_BYTES, () => authorizeProductImageUpload(user, params.id!));
  return NextResponse.json({ image: await uploadProductImage(user, params.id!, bytes) }, { status: 201 });
});
