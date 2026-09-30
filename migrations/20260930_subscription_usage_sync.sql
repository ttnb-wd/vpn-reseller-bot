ALTER TABLE "public"."subscription"
  ADD COLUMN IF NOT EXISTS "lastUsageSyncedAt" timestamptz;
