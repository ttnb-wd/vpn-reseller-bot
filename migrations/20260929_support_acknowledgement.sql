DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'supportTicket'
      AND column_name = 'acknowledgedAt'
  ) THEN
    ALTER TABLE "public"."supportTicket"
      ADD COLUMN "acknowledgedAt" timestamptz;
    -- Older open conversations have already received acknowledgements.
    UPDATE "public"."supportTicket"
      SET "acknowledgedAt" = now()
      WHERE "status" = 'OPEN';
  END IF;
END
$migration$;
