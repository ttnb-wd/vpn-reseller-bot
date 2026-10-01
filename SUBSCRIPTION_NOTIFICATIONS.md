# Metro Secure notifications and dynamic Outline credentials

## Audit and customer migration

Before this change, the backend provisioned real Outline keys, stored their static
`ss://` URLs on orders/subscriptions, and delivered those static credentials through
the bot and the short-lived HTTPS setup page. No `ssconf://` delivery or dynamic
config route existed. This is a source-code audit; production rows were not queried
or changed during implementation.

New paid customers now get one stable `ssconf://` credential through a durable bot
delivery attempt. Provisioning still creates/reuses the real Outline key according
to the existing payment recovery rules. The underlying static credential remains
stored internally to construct the active tunnel configuration.

Existing active customers receive a one-time Myanmar migration message through the
existing worker scans. The backend generates one encrypted token referencing the
same existing Outline credential. It does not create a second Outline key. Customer
steps:

1. Update Outline Client to a release supporting YAML configuration (v1.15.0+).
2. Open the bot's migration message and select the Myanmar Connect button, or copy
   the included `ssconf://` key and import it into Outline.
3. Import once, then connect using the newly imported entry. Keep the old entry
   until the new connection has been confirmed working; it can then be removed
   locally by the customer.

No migration-confirmation handler revokes the old static credential. Both imported
entries share the same server credential and quota. They remain subject to normal
expiry/quota enforcement. Static entries cannot display dynamic Myanmar errors.
Routine `/start`, My VPN, Setup/Connect, Copy Key, and renewal calls do not rotate
the token or provision duplicate keys. Renewals preserve the dynamic URL. If the
underlying Outline key is confirmed missing, existing idempotent replacement
recovery remains available; the dynamic URL still points at the current stored key.

Dynamic subscriptions are blocked with a zero Outline allowance at expiry, rather
than deleting their Outline key. This retains the credential for paid renewal and
keeps the same imported entry usable. The expiry worker repeats the block on later
scans and checks for concurrent renewals before leaving the key blocked. Existing
static-only expiry enforcement continues using deletion until a token is issued.

Official format and supported client versions:
[Outline dynamic access keys](https://developer.getoutline.org/vpn/management/dynamic-access-keys/)
and [TunnelConfig reference](https://github.com/OutlineFoundation/outline-apps/blob/master/client/config.md).

## Thresholds and worker behavior

The existing usage and expiry timers each invoke the shared notification evaluator.
There is no additional timer. Concurrent local calls share one promise; PostgreSQL
row locks and a unique attempt identity prevent duplicate sends across processes.
Scans page 100 subscriptions at a time and isolate errors per delivery/customer.
Notification failures do not bypass quota or expiry enforcement. Telegram requests
are canceled after 15 seconds to bound a stuck delivery.

* Expiry warning: `0 < expiresAt - now <= 24 hours`.
* Low-data warning: `0 < allowanceBytes - dataUsedBytes <= 1,073,741,824`.
  This uses the existing 1024^3 GB unit, safe integer allowance conversion, and
  PostgreSQL bigint usage bytes from the Outline metrics response. Display rounding
  never controls the threshold. Existing subscriptions without a raw byte sample
  wait for a successful usage sync; no approximation/backfill is performed.
* Expired notice: actual expiry has passed, including expiry-worker revocation.
* Quota notice: effective subscription state is `DATA_LIMIT_REACHED`; the existing
  quota latch is preserved if the rolling Outline counter later decreases.

Expiry takes precedence when expiry and quota are both reached. An order in
`PROCESSING` suppresses claims while entitlement recovery finishes. A real paid
renewal resets the four entitlement timestamps only if its exact expiry target
was not already applied. It preserves the dynamic token and migration timestamp.

## Durable delivery and the exactly-once limitation

Each attempt is unique by `(subscriptionId, cycle, kind)`. Entitlement cycles use
the exact PostgreSQL expiry timestamp, including microseconds. The one-time dynamic
delivery uses the fixed cycle `delivery:v1`. A subscription row is locked while
eligibility is rechecked and the attempt is inserted; `DISPATCHING` is committed
before any Telegram call.

* Explicit Telegram Bot API rejection: mark `FAILED`, schedule retry using
  `retry_after` when available, leave the sent timestamp null.
* Telegram returns a message ID: persist `SENT`, message ID, and the corresponding
  subscription sent timestamp atomically. Database receipt writes are retried up
  to three times without sending the Telegram message again. The timestamp update
  checks the entitlement cycle so a delayed receipt cannot mark a renewed cycle.
* Timeout, lost response, process crash, or unrecoverable receipt write failure:
  leave `DISPATCHING` for review. Never automatically reclaim/re-send it. Existing
  scans log a safe count when attempts older than five minutes need review.

Telegram `sendMessage` has no caller-supplied idempotency key and cannot participate
in a PostgreSQL transaction. Therefore guaranteed delivery and guaranteed no
duplicates through every crash are not simultaneously achievable. This design
prioritizes the requested no-duplicate behavior. An uncertain attempt may represent
a delivered message or an undelivered message, and needs operator reconciliation.
It is not falsely recorded as sent.

Safe review query (no Telegram IDs, URLs, or tokens):

```sql
SELECT id, kind, cycle, status, "attemptedAt", "sentAt", "telegramMessageId"
FROM public."subscriptionNotification"
WHERE status = 'DISPATCHING'
  AND "attemptedAt" < now() - interval '5 minutes'
ORDER BY "attemptedAt";
```

Only after confirming the message was not delivered, an authorized operator can
explicitly change that specific attempt to `FAILED` and set `nextAttemptAt` to now.
If delivery is confirmed, reconcile its receipt and sent timestamp for its original
cycle instead. Never mass-reset attempts on restart/redeploy. No automated
production reconciliation or mutation was run for this task.

## Dynamic endpoint and security

`GET /vpn/config/:token` requires the bearer token, with no admin session.
Tokens are 32 cryptographically random bytes (43 base64url characters), independent
of database/customer identifiers. Only their SHA-256 hash is indexed. The token is
stored separately under AES-256-GCM authenticated encryption, using a domain-specific
HKDF key derived from the existing `CONNECT_TOKEN_SECRET`.

Preserve `CONNECT_TOKEN_SECRET` across restarts and Render redeploys. Replacing it
without an explicit token re-encryption/reissue procedure prevents decrypting
existing delivery URLs. No automatic rotation is implemented. Token rotation must
be an explicit authenticated maintenance action with deliberate customer delivery.

Active responses contain official YAML `transport` with TCP/UDP Shadowsocks
configuration decoded from the existing static key. Expired/quota responses contain
only the exact requested Myanmar `error.message` and `error.details`. GET never
creates Outline keys, initializes tokens, or calls the Outline management API.

Responses use `application/yaml`, `private, no-store, max-age=0`, and
`Referrer-Policy: no-referrer`. Production rejects HTTP without redirecting the
credential. The existing trusted Render TLS proxy policy is reused. Unknown tokens
return an empty 404. Requests are capped at 60/IP/minute and 3,000/process/minute,
including invalid-token requests before database lookup. The bounded per-IP limiter
is process-local; multi-instance deployments should also apply an ingress limit.

Do not enable vendor payload debugging or access logs containing full config URLs.
Configure proxy/APM logs to record the route template rather than the token path.
Application diagnostic paths use fixed messages and safe metadata; diagnostics also
redact `ssconf://` URLs and `/vpn/config/` token paths. The config returns only the
data-plane credentials required by Outline, never management URLs, certificate
fingerprints, Telegram IDs, or database IDs.

Outline shows these messages when it fetches the dynamic config; this is not a push
into an already connected client. Enforcement blocks expired/exhausted connections
regardless of client refresh timing. The HTTPS config host must remain reachable
without relying on the VPN connection itself.

Mini App customer UI remains English; the existing layout is preserved. New bot
notifications and Outline failure reasons are Myanmar.

## Schema and production commands

Migration: `migrations/20261001_subscription_notifications_dynamic_keys.sql`.
It adds these subscription columns without replacing keys or backfilling usage:

* `dataUsedBytes`: nullable bigint.
* `expiryWarningSentAt`, `lowDataWarningSentAt`, `expiredNoticeSentAt`,
  `quotaNoticeSentAt`, `migrationNoticeSentAt`: nullable timestamptz(3).
* `dynamicTokenHash`: nullable text with a unique constraint.
* `dynamicTokenEncrypted`: nullable text.
* `dynamicDeliveryMode`: text, default `MIGRATION`; new purchases use `NEW`.

New table `subscriptionNotification`: text `id` primary key, `subscriptionId`
foreign key with delete cascade, text `cycle/kind/status`, `attemptedAt`,
`nextAttemptAt`, `sentAt` (timestamptz(3)), and optional integer `telegramMessageId`.
It has a unique `(subscriptionId, cycle, kind)` constraint and a subscription index.
The existing reset helper includes this dependent table in its explicit truncate
list. No reset was executed.

Generated storage contract hash:
`7f712038faa2924154da6e9599cffffd0ab60f126c4e0d8a2990c5525160514e`.
The source, emitted JSON/types, and matching snapshot are included. Existing
repository migrations use explicit SQL plus Prisma signing, so this migration
follows that convention rather than introducing an incomplete migration graph.

With the intended database already selected in `DATABASE_URL`, run these explicitly
from the repository root in PowerShell before starting the new application release.
Stop at any nonzero exit; do not sign a schema that fails verification.

```powershell
npx prisma contract emit
if ($LASTEXITCODE -ne 0) { throw 'Contract emission failed' }
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' --dbname "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f .\migrations\20261001_subscription_notifications_dynamic_keys.sql
if ($LASTEXITCODE -ne 0) { throw 'Migration failed' }
npx prisma db verify --schema-only
if ($LASTEXITCODE -ne 0) { throw 'Schema verification failed' }
npx prisma db sign --no-advance-ref
if ($LASTEXITCODE -ne 0) { throw 'Database signing failed' }
npx prisma db verify
if ($LASTEXITCODE -ne 0) { throw 'Full verification failed' }
```

On a Render shell with `psql` installed, the equivalent commands are:

```sh
npx prisma contract emit &&
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/20261001_subscription_notifications_dynamic_keys.sql &&
npx prisma db verify --schema-only &&
npx prisma db sign --no-advance-ref &&
npx prisma db verify
```

No production commands were executed. Preserve the configured public HTTPS base URL
and encryption secret when releasing the application. The first enabled worker scan
will deliver eligible notifications and active-customer migration messages.

## Verification and changed files

188 unit/regression tests passed. The disposable PostgreSQL integration suite also
passed (its parent test and five subtests). This includes real transaction concurrency, exact timestamp receipts,
PostgreSQL bigint/Prisma round trips, concurrent token CAS, stable renewal URLs, and
dynamic expiry blocking. The SQL migration, schema-only verification, signing, and
full verification passed against a disposable local PostgreSQL 18 instance bootstrapped
from the previous committed contract. Production PostgreSQL and live Outline/Telegram
services were not used. Actual installed Outline clients were not exercised.

All changed/new JS/CJS files passed `node --check`. The requested
`node --test .\src\*.test.cjs` and `git diff --check` passed. Without an explicit
`NOTIFICATION_TEST_DATABASE_URL`, the optional local database integration test skips;
it rejects non-loopback hosts and the normal database port to avoid production use.

Changed implementation: `src/bot.js`, `src/expiry-worker.js`,
`src/safe-diagnostics.js`, `src/production-reset.js`.
New implementation: `src/dynamic-config.js`, `src/subscription-notifications.js`,
`src/notification-store.js`.
Tests: `src/customer-ui.test.cjs`, `src/expiry-worker.test.cjs`,
`src/dynamic-config.test.cjs`, `src/subscription-notifications.test.cjs`,
`src/notification-store.test.cjs`, `src/notification-postgres.test.cjs`, and
`src/notification-test-fixture.cjs`.
Schema: `prisma/contract.prisma`, `prisma/contract.json`, `prisma/contract.d.ts`,
the migration above, and the matching contract snapshot under `migrations/snapshots`.
Documentation: this file.

## Optional git commands (not executed)

These commands create a review branch and stage only this implementation; they do
not stage unrelated local changes. No commit, push, or deployment was performed.

```powershell
git switch -c codex/subscription-notifications
git add -- SUBSCRIPTION_NOTIFICATIONS.md prisma/contract.prisma prisma/contract.json prisma/contract.d.ts migrations/20261001_subscription_notifications_dynamic_keys.sql migrations/snapshots/7f712038faa2924154da6e9599cffffd0ab60f126c4e0d8a2990c5525160514e src/bot.js src/expiry-worker.js src/safe-diagnostics.js src/production-reset.js src/dynamic-config.js src/subscription-notifications.js src/notification-store.js src/customer-ui.test.cjs src/expiry-worker.test.cjs src/dynamic-config.test.cjs src/subscription-notifications.test.cjs src/notification-store.test.cjs src/notification-postgres.test.cjs src/notification-test-fixture.cjs
git diff --cached --check
git commit -m "Add durable Myanmar subscription notices and dynamic Outline delivery"
git push -u origin codex/subscription-notifications
```
