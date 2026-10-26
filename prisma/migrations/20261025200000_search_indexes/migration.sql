-- Performance: indexes for the text searches (appointments, customers, audit log) and the
-- customer list order. Purely additive: no table, column or data is changed.
--
-- "contains" searches are ILIKE '%term%', which a B-tree index cannot serve, so every search
-- scanned the whole table. Trigram (pg_trgm) GIN indexes serve them for terms of 3+ characters.
-- pg_trgm is a standard "trusted" contrib extension (PostgreSQL 13+), available on managed
-- providers; the database owner can enable it.
--
-- Index builds briefly block writes to the table being indexed (seconds for tables of this size).
-- To roll back, drop the indexes (the extension can stay):
--   DROP INDEX "audit_logs_summary_trgm_idx", "customer_locations_area_trgm_idx",
--     "customer_locations_building_trgm_idx", "customer_locations_streetAddress_trgm_idx",
--     "customers_updatedAt_idx", "customers_name_trgm_idx", "customers_phoneDigits_trgm_idx",
--     "customers_secondaryPhoneDigits_trgm_idx";
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261025200000_search_indexes';

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "audit_logs_summary_trgm_idx" ON "audit_logs" USING GIN ("summary" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "customer_locations_area_trgm_idx" ON "customer_locations" USING GIN ("area" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "customer_locations_building_trgm_idx" ON "customer_locations" USING GIN ("building" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "customer_locations_streetAddress_trgm_idx" ON "customer_locations" USING GIN ("streetAddress" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "customers_updatedAt_idx" ON "customers"("updatedAt");

-- CreateIndex
CREATE INDEX "customers_name_trgm_idx" ON "customers" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "customers_phoneDigits_trgm_idx" ON "customers" USING GIN ("phoneDigits" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "customers_secondaryPhoneDigits_trgm_idx" ON "customers" USING GIN ("secondaryPhoneDigits" gin_trgm_ops);
