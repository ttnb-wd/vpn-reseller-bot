CREATE TABLE IF NOT EXISTS "public"."supportMessage" (
  "id" SERIAL PRIMARY KEY,
  "ticketId" integer NOT NULL REFERENCES "public"."supportTicket"("id") ON DELETE CASCADE,
  "customerId" integer NOT NULL REFERENCES "public"."customer"("id") ON DELETE CASCADE,
  "sender" text NOT NULL,
  "text" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "supportMessage_ticketId_idx_2fe526c3"
  ON "public"."supportMessage" ("ticketId");

CREATE INDEX IF NOT EXISTS "supportMessage_customerId_idx_b2a8a46c"
  ON "public"."supportMessage" ("customerId");
