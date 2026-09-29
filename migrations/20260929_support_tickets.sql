CREATE TABLE IF NOT EXISTS "public"."supportTicket" (
  "id" SERIAL PRIMARY KEY,
  "customerId" integer NOT NULL REFERENCES "public"."customer"("id"),
  "status" text NOT NULL DEFAULT 'OPEN',
  "customerInputActive" boolean NOT NULL DEFAULT true,
  "adminReplySelected" boolean NOT NULL DEFAULT false,
  "adminReplySelectedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "closedAt" timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "support_ticket_one_open_per_customer"
  ON "public"."supportTicket" ("customerId") WHERE "status" = 'OPEN';

CREATE UNIQUE INDEX IF NOT EXISTS "support_ticket_one_admin_reply_target"
  ON "public"."supportTicket" ((true)) WHERE "adminReplySelected" = true;
