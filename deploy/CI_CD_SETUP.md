# Metro VPN Render Free deployment

Target the existing Render Free Node service, with the existing authoritative Aiven
database and DigitalOcean Outline server. No database restore/migration, key rotation,
subscription reset, paid service or DigitalOcean application deployment is part of this path.

## Approval boundary

Preparing source and isolated tests does not authorize production configuration,
service stops/restarts, routing/DNS changes or automatic deployment activation.
Use the private cutover checklist and obtain explicit approval first.

## Existing Render service configuration

- Repository branch: main. Native Node runtime, version pinned with NODE_VERSION.
- Build: npm ci --omit=dev --ignore-scripts --no-audit --no-fund.
- Start: node src/bot.js. No schema command or lifecycle install hook.
- Provider health path: /live. Readiness/monitoring path: /ready.
- Preserve existing credentials. Required names: BOT_TOKEN, ADMIN_TELEGRAM_ID,
  DATABASE_URL, OUTLINE_API_URL, OUTLINE_API_CERT_SHA256, CONNECT_TOKEN_SECRET,
  ADMIN_EMAIL, ADMIN_PASSWORD_HASH, ADMIN_SESSION_SECRET, NODE_ENV, PUBLIC_BASE_URL.
- Preserve NODE_OPTIONS heap limit. Render supplies PORT and RENDER; do not copy
  the VPS's RENDER=false, PORT override or mounted CA pathname.
- Upload the existing Aiven public CA as a protected secret file aiven-ca.pem;
  configure NODE_EXTRA_CA_CERTS=/etc/secrets/aiven-ca.pem. TLS remains verify-full.
- Canonical public origin: https://vpn-reseller-bot-1.onrender.com.
  LEGACY_PUBLIC_HOSTNAME enables compatibility for an explicitly approved old hostname.

## CI gate

GitHub Actions verifies source/history secrets, workflow syntax, unchanged schema,
disconnected application tests and a secret-free production-image smoke. It has no
deployment job, SSH key, production secret, registry push or deploy-hook invocation.
After approved migration and successful CI, use Render's **After CI Checks Pass**
auto-deploy mode on main. Never use On Commit. Keep Off during preparation and initial
supervised deployment. Render's built-in gate supports this without an API/deploy-hook token.
Unconditional verify and render-candidate jobs must both finish successfully.

The former DigitalOcean receiver, SSH client and recovery fixtures remain historical
recovery assets. The workflow no longer invokes them. Keep old activation variables
false; disable the host recovery path and bot restart policy in the approved cutover.

## Ownership, restarts and rollback

The database advisory owner gates polling and workers. A new Render instance serves
/live in standby and does not poll until it owns the lock. Use /live for Render's
rolling-deploy health check; using /ready could leave the incumbent holding the lock.
Render may retain the incumbent for about 60 seconds before SIGTERM; APIs/admin on
the new instance can return 503 until ownership transfers. Never start an extra poller.

Expiry scans run immediately on activation against stored expiry dates; processing
order recovery and durable notification state survive restarts. Quotas remain enforced
by Outline while the application is unavailable. Expiry processing can be delayed
while Free hosting is down; monitoring is not a 24/7 guarantee or extra free hours.

On critical failure stop/suspend Render polling first, verify zero advisory owners,
restore previous routing if changed, then restart the retained DigitalOcean image
with its preserved configuration. Never restore an old database snapshot.

For DNS-free compatibility, retain Caddy only for the exact Google verification file,
old dynamic-link proxy paths and canonical browser redirects. Apply this reverse
direction only after Render is running the full application; leaving the old Render
forwarder in place would loop. A strictly Outline-only VPS requires recovered DNS
control and a verified Render custom domain before Caddy can be retired.

## Monitoring and cost limits

Reuse the existing UptimeRobot monitor, targeting the Render /ready URL. Recommend
a ten-minute interval if its current free controls support it. No paid upgrade.
Render Free can sleep after 15 idle minutes, restart, exhaust shared monthly hours or
other included limits. Pings do not guarantee continuous operation or extend allowances.
Keep provider spending limits and usage visible before activation.

Chrome's deceptive-site classification remains a separate unresolved security issue.

References: https://render.com/docs/free and https://render.com/docs/deploys.
