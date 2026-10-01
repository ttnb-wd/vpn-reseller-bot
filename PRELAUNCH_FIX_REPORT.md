# Metro Secure pre-launch fixes

Validated on 1 October 2026. H1–H7 and the supplied payment-proof race are resolved in the working tree. No deployment, commit, push, production database write, or production migration was performed. External traffic during verification was limited to the npm dependency audit.

1. **H1 — customer provisioning serialization.** `src/coordination.js` uses PostgreSQL session advisory locks in namespace 1297302355, with customer ID as the second key. A dedicated connection holds each lock until approval/renewal/recovery/usage/expiry work finishes. The ORM uses its existing connections while the coordinating connection remains held. Approval acquires this lock before claiming an order or reading its subscription. Unfinished customer provisioning prevents a different order from creating another key. Persisted entitlement targets and fixed Outline IDs make retries deterministic. Partial cancelled activation also reconciles the earlier order's remote identity. Renewals keep the same existing key and retain both concurrently purchased extensions. Existing subscription ownership is checked before granting allowance.

2. **H2 — atomic payment transitions.** Approval claims, rejection and cancellation use conditional `updateAll` operations with `PENDING_PAYMENT` in the WHERE clause. They check returned row counts and reload state when the transition loses. Approval completion is conditional on both `PROCESSING` and the claim's `processingAt` value. Recovery uses the same timestamp fence under the customer lock. Checkpoint writes are also fenced. A stale reject/cancel/completion cannot overwrite a newer approval claim.

3. **H3 — coordinated Outline writes.** Approval, renewal, quota enforcement, usage sync and expiry share the customer advisory lock. Usage scans reload each subscription after acquiring the lock and only reduce remote allowance; they never restore a positive limit from a stale scan. New keys remain blocked until their subscription is persisted. Renewal only grants the increased allowance after the entitlement is renewed in PostgreSQL. `src/entitlement-write.js` reloads entitlement before and after positive writes and compensates with zero allowance when expiry, quota or revocation becomes effective during the remote request. Remote wrappers check connection/lease ownership before and after provider calls. Expiry restoration uses the same reconciliation helper. Exact-day expiry, usage timestamps and quota latching regressions pass.

4. **H4 — login attempt reservation.** Admin login synchronously reserves both IP and normalized-email budgets before awaiting bcrypt. Both have five attempts per 15-minute window, and bcrypt concurrency is capped at five per process. Missing emails receive the same bcrypt work, messages and limiting behavior as the configured account. Success resets the applicable budgets. Tests verify parallel failures, the subsequent 429, identical nonexistent-account behavior and correct login after cooldown. Session signing, cookies, CSRF and origin checks remain intact.

5. **H5 — verified external database TLS.** Production external URLs normalize to `sslmode=verify-full`; weak modes and `require&uselibpqcompat=true` fail validation. Query host overrides cannot escape the internal-host policy. The unverified TLS exception is limited to the existing exact Render internal-host pattern. Reset tooling verifies external certificates independently of NODE_ENV. No global TLS-verification override is set. Existing external require URLs without weak compatibility normalize safely. No credentials were printed.

6. **H6 — singleton ownership.** Polling and workers start only after obtaining PostgreSQL advisory lock `(1297302355, 0)` on a dedicated connection. A random UUID identifies the owner in safe logs. Heartbeat queries run every 10 seconds. PostgreSQL `idle_session_timeout=60000ms` expires abandoned sessions after 60 seconds without heartbeat; crashed/closed sessions also release their locks. A second owner fails closed before polling or worker startup. Connection loss stops ownership, marks the bot unhealthy and initiates shutdown. Graceful release destroys the owning connection. This design requires PostgreSQL 14 or later and a connection endpoint that preserves session ownership; transaction-pooling endpoints are unsuitable. Disposable PostgreSQL tests verify actual exclusion, renewal beyond the expiry window, expiration/takeover and release.

7. **H7 — bounded shutdown.** SIGINT/SIGTERM share an idempotent lifecycle. It marks stopping, rejects new HTTP/bot callback work, stops polling first, clears recovery/usage/expiry/notification scheduling, closes SSE clients, drains tracked bot handlers and Mini App callbacks, waits for active workers, releases singleton ownership, closes HTTP and database resources, then exits. Handler and worker drain budgets are 10 seconds each inside a 30-second overall deadline. Other cleanup steps have individual limits so hung work cannot prevent lease release/DB cleanup. Tests exercise active approval completion, prevention of new approval, timer cancellation, polling stop, SSE cleanup, duplicate signals and never-resolving handlers. Startup failure also drains resources already acquired.

8. **Related MEDIUM/operational fixes.** Telegram proof writes now atomically require customer ownership, pending status, no existing proof and no Mini App reservation. Mini App retains its durable reservation/CAS and uncertain-delivery checkpoint. Both channels share a per-customer six-per-minute upload budget. Existing proofs cannot be overwritten and uncertain delivery is not automatically resent. SSE now permits three streams per customer, 500 globally, a 15-minute lifetime, retained heartbeats, immediate cleanup/reconnect on backpressure, bounded session tokens and explicit close-all. `/live` reports liveness; `/ready` and `/` require validated environment, DB availability, singleton ownership and successful bot startup. Readiness DB checks have a two-second deadline and expose no dependency details. All requested production environment names are validated at startup, with existing admin, Outline and connect validators enforcing their formats.

9. **Files changed/added.**

- `scripts/check-outline-ownership.cjs`
- `scripts/prepare-disposable-schema.cjs`
- `src/admin-auth.js`
- `src/admin-auth.test.cjs`
- `src/bot.js`
- `src/coordination-postgres.test.cjs`
- `src/coordination.js`
- `src/coordination.test.cjs`
- `src/customer-ui.test.cjs`
- `src/db.js`
- `src/db.test.cjs`
- `src/entitlement-write.js`
- `src/entitlement-write.test.cjs`
- `src/expiry-worker.js`
- `src/expiry-worker.test.cjs`
- `src/lifecycle.js`
- `src/lifecycle.test.cjs`
- `src/notification-postgres.test.cjs`
- `src/prelaunch-audit.test.cjs`
- `src/reset-db-connection.js`
- `src/reset-db-connection.test.cjs`
- `src/startup-health.js`
- `src/startup-health.test.cjs`
- `src/subscription-notifications.js`
- `src/support-events.js`
- `src/support-events.test.cjs`
- `PRELAUNCH_FIX_REPORT.md`

`src/prelaunch-audit.test.cjs` was already untracked when work began; it was retained and extended. Its first-activation race barrier moved before lock acquisition, because requiring both participants to enter the serialized subscription section would deadlock a correct implementation. Existing outage injections now target atomic completion's `updateAll` API.

10. **Schema changes.** None. Advisory locks do not require a table or contract change. Existing unique `Subscription.customerId` and customer/order indexes support the locking design. Existing real-key ownership is checked at mutation boundaries. No unique vpnKeyId constraint was added without evidence about historical duplicates. Worker/history performance indexes remain a possible follow-up at scale rather than a correctness prerequisite.

11. **Migration filename.** None required or created.

12. **Contract storageHash.** Existing artifacts remain unchanged; regeneration was unnecessary because storage did not change:

`7f712038faa2924154da6e9599cffffd0ab60f126c4e0d8a2990c5525160514e`

13. **Tests.** Final full run: **241 passed, 0 failed, 0 skipped**. All six originally failing HIGH audit regressions pass. Every changed/new JS/CJS file (26 files) passed `node --check`. `git diff --check` passed.

14. **PostgreSQL integration.** **12 tests passed, 0 failed, 0 skipped**, included in the full total. The existing notification/dynamic-key integration and new locking/atomic-state integration used a freshly initialized PostgreSQL 18 instance bound to `127.0.0.1:55439`, database `metro_disposable`. Its schema was generated from the current contract by `scripts/prepare-disposable-schema.cjs`. Tests disallow production fallback and routing overrides. The temporary server was stopped after verification. All real mutation was confined to this disposable database. No production duplicate detection was run.

15. **Production dependency audit.** `npm audit --omit=dev`: **found 0 vulnerabilities**. Registry access required escalation after the sandbox request failed.

16. **Launch blocker status.** The supplied H1–H7 blockers are resolved and their tested concurrency/lifecycle contracts pass. This verifies the working tree; production rollout and production data inspection were intentionally excluded.

17. **Remaining MEDIUM/LOW items and operational prerequisites.** No other MEDIUM/LOW audit inventory was provided, so this report does not claim that unrelated audit findings were resolved. Historical production duplicate ownership remains unverified. A read-only detector is available and intentionally does not print keys or customer identities. Confirm PostgreSQL 14+ and session-preserving connectivity before using the singleton design. Use `/ready` for deployment readiness. A competing process exits without acquiring the lease; rollout orchestration must permit the incumbent to release ownership before the replacement can become ready. Future worker/history indexes may be useful as data volume grows. Existing test-only synthetic key-delivery log messages and an Express promise-handler deprecation warning do not represent failed tests.

18. **Production migration commands.** None are needed for this change. Do not run a production migration for these fixes. Optional read-only ownership inspection, in a separately configured trusted environment:

```powershell
$env:NODE_ENV = 'production'
node .\scripts\check-outline-ownership.cjs
```

This command only reports duplicate groups and affected subscription counts. It does not repair data or add constraints. It was not run against production.

19. **Exact optional Git commands.** These commands were not run. They create a review branch, stage the current changes, commit, and push only when you choose to do so:

```powershell
git switch -c codex/fix-prelaunch-blockers
git add -- scripts/check-outline-ownership.cjs scripts/prepare-disposable-schema.cjs src/admin-auth.js src/admin-auth.test.cjs src/bot.js src/coordination-postgres.test.cjs src/coordination.js src/coordination.test.cjs src/customer-ui.test.cjs src/db.js src/db.test.cjs src/entitlement-write.js src/entitlement-write.test.cjs src/expiry-worker.js src/expiry-worker.test.cjs src/lifecycle.js src/lifecycle.test.cjs src/notification-postgres.test.cjs src/prelaunch-audit.test.cjs src/reset-db-connection.js src/reset-db-connection.test.cjs src/startup-health.js src/startup-health.test.cjs src/subscription-notifications.js src/support-events.js src/support-events.test.cjs PRELAUNCH_FIX_REPORT.md
git commit -m "Fix Metro Secure pre-launch race and lifecycle blockers"
git push -u origin codex/fix-prelaunch-blockers
```

Verification command used with the disposable local instance:

```powershell
$env:NOTIFICATION_TEST_DATABASE_URL = 'postgres://metro_test@127.0.0.1:55439/metro_disposable?sslmode=disable'
node --test .\src\*.test.cjs
npm audit --omit=dev
git diff --check
```
