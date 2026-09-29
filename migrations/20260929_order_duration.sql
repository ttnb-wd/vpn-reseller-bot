ALTER TABLE "public"."order"
  ADD COLUMN IF NOT EXISTS "totalDurationDays" integer;
