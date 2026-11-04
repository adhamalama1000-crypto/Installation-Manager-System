import { NextResponse } from "next/server";
import { apiRoute } from "@/server/http";
import { listProductImages, uploadProductImage } from "@/server/services/product-images";
import { MAX_UPLOAD_BYTES, readLimitedBody } from "@/server/storage";

export const GET = apiRoute(async ({ user, params }) => ({ images: await listProductImages(user, params.id!) }));

/** Body: the image bytes (JPEG, PNG or WebP; the type is read from the bytes). */
export const POST = apiRoute(async ({ req, user, params }) =>
  NextResponse.json({ image: await uploadProductImage(user, params.id!, await readLimitedBody(req, MAX_UPLOAD_BYTES)) }, { status: 201 }),
);
