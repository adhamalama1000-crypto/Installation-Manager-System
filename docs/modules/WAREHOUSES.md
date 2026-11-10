# Warehouses

## 1. Module purpose

Define where stock is kept: the company's stores and showrooms, each technician's vehicle, and the
bins / shelves inside them, with each place's negative-stock policy.

## 2. How users operate it

*Warehouses* (`/warehouses`) lists stores and vehicles with their stock value and any open
stocktake. *New warehouse*: code, English and Arabic names, kind (*Warehouse* or *Vehicle*), the
technician for a vehicle, address, "allow negative stock", active. A warehouse page
(`/warehouses/[id]`) shows its stock and bins; bins are added and edited there (code, name, active).

## 3. Available features

Warehouses and vehicles; one vehicle per technician; bins with unique codes per warehouse; stock
also allowed without a bin; negative-stock policy per warehouse (off by default); deactivation only
when empty; stock value per warehouse (for people who may see costs); technicians limited to their
vehicle.

## 4. Roles and permissions

`warehouses.view` (Admin, Accountant, Store keeper, Warehouse manager; grantable to Viewers),
`warehouses.manage` (Admin, Warehouse manager). Technicians see their own vehicle through
`inventory.view` (vehicle scope).

## 5. Business rules

- Codes unique; never deleted (deactivated when empty).
- Only a vehicle belongs to a technician (CHECK), one vehicle per technician (unique index); no
  vehicles are created automatically.
- Negative stock never for serial-tracked products, whatever the policy.
- A warehouse with an open stocktake is frozen.

## 6. Database models and relationships

`warehouses` (code, names, kind `WAREHOUSE` / `VEHICLE`, technicianId → users, allowNegative,
isActive), `warehouse_bins` (warehouseId, code, names, isActive); referenced by `stock_balances`,
`inventory_movements`, `stock_documents`, `stocktakes`, `sales_invoices`.

## 7. API routes

`GET/POST /api/warehouses`, `GET/PATCH /api/warehouses/[id]`, `POST /api/warehouses/[id]/bins`,
`PATCH /api/warehouses/[id]/bins/[binId]`.

## 8. Services and important logic

`src/server/services/inventory-warehouses.ts`; `warehouseScopeSql` / document scope in
`inventory-common.ts` and `inventory-stock.ts` (vehicle scoping); UI
`src/components/erp/warehouse-forms.tsx`, pages `src/app/(app)/warehouses/*`.

## 9. Validation rules

Code: capitals, digits and `-`, unique; names required; a vehicle needs an active technician without
another vehicle; bin code unique in its warehouse.

## 10. Error handling

422 with field messages (duplicate code, technician already has a vehicle, warehouse still holds
stock when deactivating); 403 without `warehouses.manage`.

## 11. Tests

`tests/integration/inventory.test.ts` (warehouses and vehicles, bins, deactivation only when empty,
negative policy, vehicle scoping), `tests/integration/inventory-api.test.ts`, `e2e/inventory.spec.ts`.

## 12. Current limitations

No address-based routing between warehouses; no bin capacity; one level of bins.

## 13. Future improvements

Bin capacities and put-away suggestions; warehouse-level managers (permission per warehouse).
