# Render singleton handoff

Configure the Render web service **Health Check Path to `/live`**. Keep `/ready`
for operational monitoring. Do not configure Render deployments to wait on
`/ready`: the incumbent owns the PostgreSQL session lock until Render terminates
it, which requires the replacement to pass deployment health checks first.

Startup validates configuration and Outline connectivity, initializes the DB,
constructs read-only dynamic-key helpers, and starts HTTP before attempting the
singleton lock. A busy lock is normal: the replacement stays in STANDBY and
retries every 3–3.499 seconds through one chained timeout. Acquisitions cannot
overlap, including concurrent calls to the coordinator itself.

Once PostgreSQL grants ownership, the replacement verifies the ownership flag,
activates recovery scheduling, expiry/notification evaluation, Telegram handlers,
usage sync and polling exactly once. The successful Telegram startup callback
marks READY. Workers never start before ownership. Logs include a random owner
UUID and lifecycle state to distinguish overlapping instances without host details.

| HTTP route | Standby behavior |
| --- | --- |
| `/live` | 200 while HTTP is functioning; 503 during shutdown |
| `/ready` and `/` | 503 until config, DB, ownership and bot startup are ready |
| `/app/`, `/mini-app/`, JS/CSS/icon assets | Available |
| `/vpn/config/:token`, `/connect/:token` | Read-only, existing authentication/token checks retained |
| `/app/api/*`, `/mini-app/api/*` | Generic 503 with Retry-After: 3 |
| `/admin` and its routes | Generic 503 with Retry-After: 3 |

The customer APIs include process-local Support SSE/session state, rate limits,
Telegram delivery and dynamic-key preparation. Admin login/session state is
process-local. Even API read routes share these active-service dependencies, so
the API gate applies to the entire API surface while allowing static assets.
Callback fencing also prevents a queued API callback from starting after loss.

SIGTERM/SIGINT cancel standby retry, stop polling and scheduling, close SSE,
drain handlers, activation/acquisition and active workers, then release the
advisory-lock session and close HTTP/DB. Cleanup remains bounded by the existing
30-second shutdown deadline. A late acquisition after release/close is discarded
and cannot publish ownership or start a heartbeat. Active connection loss clears
ownership, fences customer locks and remote writes, marks readiness false and
initiates shutdown with status 1. Normal contention never triggers fatal startup.

No schema migration is required. No production data, provisioning, quota,
payment-approval or key lifecycle rules are changed.

Validation used a freshly initialized disposable PostgreSQL 18 database bound to
127.0.0.1:55441, separate from production. The real advisory-lock handoff test
checks standby, delayed takeover, one held singleton lock, no simultaneous role
activity, and exactly one polling/worker activation. Real bot HTTP fixture tests
check health endpoints, API fencing, static files, cancellation and lease loss.

Run syntax checks for changed JS/CJS, `node --test .\src\*.test.cjs`,
`npm audit --omit=dev`, and `git diff --check`. The PostgreSQL integration suites
require an explicit disposable loopback `NOTIFICATION_TEST_DATABASE_URL`; they
never fall back to production DATABASE_URL.

Verified result: 252 tests passed, 0 failed, 0 skipped, including PostgreSQL
takeover and the existing H1–H7 regression coverage. Changed/new JS/CJS syntax
checks and `git diff --check` passed. `npm audit --omit=dev` reported 0
vulnerabilities. No deployment, commit or push was performed.

After removing the disposable database, a final shutdown-budget refinement
combined handler and startup draining under the same existing 10-second budget,
preserving cleanup time within the 30-second deadline. The final non-DB rerun
passed 239 tests with 0 failures; its 2 disposable PostgreSQL suites were skipped
because the test server had already been stopped and removed. The earlier
PostgreSQL-enabled run passed all 252 tests, including the real takeover test.
