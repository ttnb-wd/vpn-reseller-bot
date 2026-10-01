const { Temporal } = require("@js-temporal/polyfill");
const { EXPIRY_INTERVAL_MS } = require("./worker-intervals");

function createExpiryWorker({ client, deleteAccessKey, blockAccessKey, restoreAccessKey,
  isAccessKeyNotFoundError, log = console,
  evaluateNotifications = async () => {},
  now = () => Temporal.Now.instant(), intervalMs = EXPIRY_INTERVAL_MS,
  schedule = setInterval, cancel = clearInterval }) {
  let currentRun;
  let timer;

  async function scan() {
    try {
      const expiredAt = now();
      const subscriptions = await client.public.Subscription
        .where((subscription) => subscription.expiresAt.lte(expiredAt))
        .where((subscription) => subscription.vpnKeyId.isNotNull()).all();
      for (const subscription of subscriptions) {
        try {
          const keyId = subscription.vpnKeyId;
          if (typeof keyId !== "string" || !keyId || keyId.startsWith("mock-")) continue;
          // A stale worker read must not delete a key after a renewal.
          const current = await client.public.Subscription.where({ id: subscription.id }).first();
          if (!current || current.vpnKeyId !== keyId || (current.revokedAt && !current.dynamicTokenHash) ||
              !current.expiresAt ||
              Temporal.Instant.compare(Temporal.Instant.from(current.expiresAt), now()) > 0) continue;
          // Approval may be extending this subscription with the same key.
          // Let the existing PROCESSING recovery finish before revoking it.
          const renewal = await client.public.Order.where({ customerId: current.customerId,
            status: "PROCESSING" }).first();
          if (renewal) {
            // The renewal and deletion must not race. Block traffic while
            // approval or its restart recovery resolves the order.
            await blockAccessKey(keyId);
            const afterBlock = await client.public.Subscription.where({ id: current.id }).first();
            if (afterBlock?.vpnKeyId === keyId && afterBlock.status === "ACTIVE" &&
                afterBlock.expiresAt &&
                Temporal.Instant.compare(Temporal.Instant.from(afterBlock.expiresAt), now()) > 0) {
              await restoreAccessKey(keyId, afterBlock.dataLimitGb);
            }
            continue;
          }
          // Refuse an ambiguous ownership record instead of deleting another customer's key.
          const owners = await client.public.Subscription.where({ vpnKeyId: keyId }).all();
          if (owners.length !== 1 || owners[0].id !== current.id) {
            log.error("Expiry revoke skipped: Outline key ownership is ambiguous.");
            continue;
          }
          try {
            if (current.dynamicTokenHash) {
              await blockAccessKey(keyId);
              const afterBlock = await client.public.Subscription.where({ id: current.id }).first();
              if (afterBlock?.vpnKeyId === keyId && !afterBlock.revokedAt &&
                  afterBlock.status === "ACTIVE" && afterBlock.expiresAt &&
                  Temporal.Instant.compare(Temporal.Instant.from(afterBlock.expiresAt), now()) > 0) {
                await restoreAccessKey(keyId, afterBlock.dataLimitGb);
              }
            }
            else await deleteAccessKey(keyId);
          } catch (error) {
            if (!isAccessKeyNotFoundError(error)) throw error;
          }
          await client.public.Subscription.where({ id: current.id, vpnKeyId: keyId,
            revokedAt: null }).where((row) => row.expiresAt.lte(now()))
            .updateAll({ revokedAt: now() });
        } catch (error) {
          log.error("Expiry revoke failed; it will retry.", {
            status: Number.isInteger(error?.response?.status) ? error.response.status : undefined,
          });
        }
      }
    } catch (error) {
      log.error("Expiry scan failed; it will retry.", {
        status: Number.isInteger(error?.response?.status) ? error.response.status : undefined,
      });
    } finally {
      try { await evaluateNotifications(); }
      catch { log.error("Subscription notification evaluation unavailable; it will retry."); }
    }
  }

  function run() {
    if (currentRun) return currentRun;
    currentRun = scan().finally(() => { currentRun = undefined; });
    return currentRun;
  }

  function start() {
    if (timer) return;
    void run();
    timer = schedule(() => { void run(); }, intervalMs);
  }

  async function stop() {
    cancel(timer);
    timer = undefined;
    if (currentRun) await currentRun;
  }
  return { run, start, stop };
}

module.exports = { createExpiryWorker, EXPIRY_INTERVAL_MS };
