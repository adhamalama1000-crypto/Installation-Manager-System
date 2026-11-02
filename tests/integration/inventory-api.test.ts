/**
 * The inventory endpoints through the real route handlers: session cookie, permission checks,
 * JSON errors in the reader's language, idempotent create and post, and the CSV export.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as listProductsRoute, POST as createProductRoute } from "@/app/api/products/route";
import { POST as createWarehouseRoute } from "@/app/api/warehouses/route";
import { POST as createDocRoute, GET as listDocsRoute } from "@/app/api/stock-documents/route";
import { POST as postDocRoute } from "@/app/api/stock-documents/[id]/post/route";
import { POST as cancelDocRoute } from "@/app/api/stock-documents/[id]/cancel/route";
import { GET as balancesRoute } from "@/app/api/inventory/balances/route";
import { GET as exportRoute } from "@/app/api/inventory/export/route";
import { POST as createStocktakeRoute } from "@/app/api/stocktakes/route";
import { hashPassword } from "@/server/auth/password";
import { DEFAULT_TIMEZONE } from "@/lib/constants";
import { todayKey } from "@/lib/time";
import { makeUser, prisma, resetDb } from "../helpers";

const BASE = "http://localhost:3000";
const PASSWORD = "Password123";
const noParams = { params: Promise.resolve({}) };
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const day = todayKey(DEFAULT_TIMEZONE);

function req(path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: "localhost:3000", ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

async function signIn(email: string, locale: "en" | "ar" = "en"): Promise<string> {
  const res = await login(req("/api/auth/login", { method: "POST", body: { email, password: PASSWORD } }));
  expect(res.status).toBe(200);
  return `${res.headers.get("set-cookie")!.split(";")[0]!}; ims_locale=${locale}`;
}

let managerCookie: string, storeCookie: string, techCookie: string;
let warehouseId: string, productId: string;

beforeEach(async () => {
  await resetDb();
  const passwordHash = await hashPassword(PASSWORD);
  await makeUser("WAREHOUSE_MANAGER", { email: "manager@test.local", passwordHash });
  await makeUser("STORE", { email: "store@test.local", passwordHash });
  await makeUser("TECHNICIAN", { email: "tech@test.local", passwordHash });
  managerCookie = await signIn("manager@test.local");
  storeCookie = await signIn("store@test.local");
  techCookie = await signIn("tech@test.local");
  const w = await createWarehouseRoute(req("/api/warehouses", { method: "POST", cookie: managerCookie, body: { code: "main", nameEn: "Main", nameAr: "الرئيسي", kind: "WAREHOUSE" } }), noParams);
  expect(w.status).toBe(201);
  warehouseId = (await w.json()).warehouse.id;
  const p = await createProductRoute(req("/api/products", { method: "POST", cookie: managerCookie, body: { sku: "cam-1", nameEn: "Camera", nameAr: "كاميرا", unitId: "unit-pcs", purchaseCost: 900 } }), noParams);
  expect(p.status).toBe(201);
  productId = (await p.json()).product.id;
});

const receipt = (extra: Record<string, unknown> = {}) => ({ type: "RECEIPT", toWarehouseId: warehouseId, documentDate: day, lines: [{ productId, quantity: 3 }], ...extra });

describe("inventory API", () => {
  it("rejects anonymous calls and answers validation errors in the reader's language", async () => {
    expect((await listProductsRoute(req("/api/products"), noParams)).status).toBe(401);
    const dup = await createProductRoute(req("/api/products", { method: "POST", cookie: managerCookie, body: { sku: "CAM-1", nameEn: "Other", nameAr: "أخرى", unitId: "unit-pcs" } }), noParams);
    expect(dup.status).toBe(422);
    expect((await dup.json()).error.fieldErrors.sku).toBe("This SKU is already used by another product.");
    const arabic = await createProductRoute(
      req("/api/products", { method: "POST", cookie: managerCookie.replace("ims_locale=en", "ims_locale=ar"), body: { sku: "CAM-1", nameEn: "Other", nameAr: "أخرى", unitId: "unit-pcs" } }),
      noParams,
    );
    expect((await arabic.json()).error.fieldErrors.sku).toBe("هذا الكود مستخدم لصنف آخر.");
  });

  it("creates and posts a receipt once, however often the request is sent, and reverses it on request", async () => {
    const body = receipt({ clientRequestId: "api-req-0001", post: true });
    const first = await createDocRoute(req("/api/stock-documents", { method: "POST", cookie: storeCookie, body }), noParams);
    expect(first.status).toBe(201);
    const { document } = await first.json();
    const again = await createDocRoute(req("/api/stock-documents", { method: "POST", cookie: storeCookie, body }), noParams);
    expect((await again.json()).document.id).toBe(document.id);
    const repost = await postDocRoute(req(`/api/stock-documents/${document.id}/post`, { method: "POST", cookie: storeCookie, body: {} }), idParams(document.id));
    expect(repost.status).toBe(200);
    expect(await prisma.inventoryMovement.count()).toBe(1);

    const balances = await balancesRoute(req("/api/inventory/balances?view=location", { cookie: storeCookie }), noParams);
    const rows = (await balances.json()).rows;
    expect(rows.map((r: { sku: string; quantity: number; value: number | null }) => [r.sku, r.quantity, r.value])).toEqual([["CAM-1", 3, null]]);

    // The store keeper cannot reverse a posted document; the manager can, with a reason.
    const denied = await cancelDocRoute(req(`/api/stock-documents/${document.id}/cancel`, { method: "POST", cookie: storeCookie, body: { reason: "x" } }), idParams(document.id));
    expect(denied.status).toBe(403);
    const reversed = await cancelDocRoute(req(`/api/stock-documents/${document.id}/cancel`, { method: "POST", cookie: managerCookie, body: { reason: "Duplicate invoice" } }), idParams(document.id));
    expect(reversed.status).toBe(200);
    expect((await reversed.json()).document.status).toBe("CANCELLED");
  });

  it("refuses an issue beyond the stock with a clear 422, and keeps technicians out of stock movements", async () => {
    await createDocRoute(req("/api/stock-documents", { method: "POST", cookie: storeCookie, body: receipt({ post: true }) }), noParams);
    const short = await createDocRoute(
      req("/api/stock-documents", { method: "POST", cookie: storeCookie, body: { type: "ISSUE", fromWarehouseId: warehouseId, documentDate: day, post: true, lines: [{ productId, quantity: 5 }] } }),
      noParams,
    );
    expect(short.status).toBe(422);
    const err = (await short.json()).error;
    expect(err.message).toBe("Not enough CAM-1 Camera at MAIN: 3 available, 5 needed.");
    expect(err.fieldErrors["lines.0.quantity"]).toBe(err.message);

    const tech = await createDocRoute(req("/api/stock-documents", { method: "POST", cookie: techCookie, body: receipt() }), noParams);
    expect(tech.status).toBe(403);
    expect((await createStocktakeRoute(req("/api/stocktakes", { method: "POST", cookie: techCookie, body: { warehouseId } }), noParams)).status).toBe(403);
    // The technician has no vehicle, so they see no documents at all.
    expect((await (await listDocsRoute(req("/api/stock-documents", { cookie: techCookie }), noParams)).json()).total).toBe(0);
  });

  it("exports the ledger as CSV for report readers only", async () => {
    await createDocRoute(req("/api/stock-documents", { method: "POST", cookie: storeCookie, body: receipt({ post: true }) }), noParams);
    expect((await exportRoute(req("/api/inventory/export?kind=ledger", { cookie: storeCookie }), noParams)).status).toBe(403);
    const csv = await exportRoute(req("/api/inventory/export?kind=ledger", { cookie: managerCookie }), noParams);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    const [header, row] = text.replace(/^﻿/, "").trim().split("\r\n");
    expect(header).toContain("Movement");
    expect(row).toContain("Goods receipt");
    expect(row).toContain("CAM-1");
    const balances = await exportRoute(req("/api/inventory/export?kind=balances", { cookie: managerCookie }), noParams);
    expect(await balances.text()).toContain("2700");
  });
});
