-- Apply explicitly with psql -v ON_ERROR_STOP=1; no customer key replacement or data backfill.
BEGIN;
ALTER TABLE public."subscription"
  ADD COLUMN IF NOT EXISTS "dataUsedBytes" bigint,
  ADD COLUMN IF NOT EXISTS "expiryWarningSentAt" timestamptz(3),
  ADD COLUMN IF NOT EXISTS "lowDataWarningSentAt" timestamptz(3),
  ADD COLUMN IF NOT EXISTS "expiredNoticeSentAt" timestamptz(3),
  ADD COLUMN IF NOT EXISTS "quotaNoticeSentAt" timestamptz(3),
  ADD COLUMN IF NOT EXISTS "migrationNoticeSentAt" timestamptz(3),
  ADD COLUMN IF NOT EXISTS "dynamicTokenHash" text,
  ADD COLUMN IF NOT EXISTS "dynamicTokenEncrypted" text,
  ADD COLUMN IF NOT EXISTS "dynamicDeliveryMode" text NOT NULL DEFAULT 'MIGRATION';
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_dynamicTokenHash_key"
  ON public."subscription" ("dynamicTokenHash");
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.subscription'::regclass
      AND conname = 'subscription_dynamicTokenHash_key' AND contype = 'u'
  ) THEN
    ALTER TABLE public."subscription" ADD CONSTRAINT "subscription_dynamicTokenHash_key"
      UNIQUE USING INDEX "subscription_dynamicTokenHash_key";
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public."subscriptionNotification" (
  id text PRIMARY KEY,
  "subscriptionId" integer NOT NULL,
  cycle text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  "attemptedAt" timestamptz(3) NOT NULL,
  "nextAttemptAt" timestamptz(3),
  "sentAt" timestamptz(3),
  "telegramMessageId" integer,
  CONSTRAINT "subscriptionNotification_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES public."subscription" (id) ON DELETE CASCADE,
  CONSTRAINT "subscriptionNotification_subscriptionId_cycle_kind_key"
    UNIQUE ("subscriptionId", cycle, kind)
);
CREATE INDEX IF NOT EXISTS "subscriptionNotification_subscriptionId_idx_edbe96bf"
  ON public."subscriptionNotification" ("subscriptionId");
COMMIT;
