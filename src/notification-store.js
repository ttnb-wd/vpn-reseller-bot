const crypto = require("node:crypto");
const { Pool } = require("pg");
const { prepareDatabaseUrl } = require("./db");
const { FIELDS, eligibleKinds } = require("./subscription-notifications");
const { messagingState } = require("./dynamic-config");

function createNotificationStore({ pool = new Pool({ connectionString: prepareDatabaseUrl(process.env.DATABASE_URL).toString(),
  max: 3, connectionTimeoutMillis: 10000, statement_timeout: 15000 }) } = {}) {
  pool.on("error", () => console.error("Notification database connection unavailable."));
  async function transaction(work) {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const result = await work(connection);
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      try { await connection.query("ROLLBACK"); } catch { /* Connection may already be closed. */ }
      throw error;
    } finally { connection.release(); }
  }
  return {
    async list(after) {
      const result = await pool.query('SELECT * FROM public."subscription" WHERE id > $1 AND status IN (\'ACTIVE\', \'DATA_LIMIT_REACHED\', \'EXPIRED\') ORDER BY id LIMIT 100', [after]);
      return result.rows;
    },
    async claim(id, kind) {
      if (!Object.hasOwn(FIELDS, kind)) throw new Error("Unknown notification kind.");
      return transaction(async (connection) => {
        // Row locking serializes competing workers with paid entitlement updates.
        const result = await connection.query(`SELECT s.*, c."telegramId",
          to_char(s."expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiryCycle"
          FROM public."subscription" s
          JOIN public."customer" c ON c.id = s."customerId" WHERE s.id = $1 FOR UPDATE OF s`, [id]);
        const subscription = result.rows[0];
        if (!subscription || subscription[FIELDS[kind]] || !subscription.expiresAt) return null;
        const processing = await connection.query('SELECT 1 FROM public."order" WHERE "customerId" = $1 AND status = \'PROCESSING\' LIMIT 1', [subscription.customerId]);
        if (processing.rowCount) return null;
        if (kind === "migrationNotice") {
          if (messagingState(subscription) !== "ACTIVE" || !subscription.vpnKey?.startsWith("ss://") ||
              !subscription.vpnKeyId || subscription.vpnKeyId.startsWith("mock-")) return null;
        } else if (!eligibleKinds(subscription).includes(kind)) return null;
        const cycle = kind === "migrationNotice" ? "delivery:v1" : subscription.expiryCycle;
        const attemptId = crypto.randomUUID();
        // Commit DISPATCHING before touching Telegram. Never reclaim abandoned
        // attempts on a timer: their remote outcome cannot be determined safely.
        const inserted = await connection.query(`INSERT INTO public."subscriptionNotification"
          (id, "subscriptionId", cycle, kind, status, "attemptedAt") VALUES ($1,$2,$3,$4,'DISPATCHING',now())
          ON CONFLICT ("subscriptionId", cycle, kind) DO UPDATE SET id = EXCLUDED.id,
            status = 'DISPATCHING', "attemptedAt" = now(), "nextAttemptAt" = NULL
          WHERE "subscriptionNotification".status = 'FAILED' AND "subscriptionNotification"."nextAttemptAt" <= now()
          RETURNING id`, [attemptId, id, cycle, kind]);
        if (!inserted.rowCount) return null;
        return { id: attemptId, kind, subscription, cycle, telegramId: subscription.telegramId };
      });
    },
    async failed(claim, delaySeconds) {
      await pool.query(`UPDATE public."subscriptionNotification" SET status = 'FAILED',
        "nextAttemptAt" = now() + $2 * interval '1 second' WHERE id = $1 AND status = 'DISPATCHING'`, [claim.id, delaySeconds]);
    },
    async reviewRequired() {
      const result = await pool.query(`SELECT count(*)::int AS count FROM public."subscriptionNotification"
        WHERE status = 'DISPATCHING' AND "attemptedAt" < now() - interval '5 minutes'`);
      return result.rows[0].count;
    },
    async sent(claim, messageId) {
      if (!Object.hasOwn(FIELDS, claim.kind)) throw new Error("Unknown notification kind.");
      const field = FIELDS[claim.kind];
      await transaction(async (connection) => {
        await connection.query('SELECT id FROM public."subscription" WHERE id = $1 FOR UPDATE', [claim.subscription.id]);
        // Persist both the remote receipt and timestamp together. Cycle guard
        // prevents a delayed receipt from setting a renewed entitlement's flag.
        const result = await connection.query(`UPDATE public."subscriptionNotification" SET status = 'SENT',
          "sentAt" = now(), "telegramMessageId" = $2 WHERE id = $1 AND status = 'DISPATCHING' RETURNING "sentAt"`, [claim.id, messageId]);
        if (!result.rowCount) return;
        await connection.query(`UPDATE public."subscription" SET "${field}" = $2 WHERE id = $1
          ${claim.kind === "migrationNotice" ? "" : 'AND "expiresAt" = $3::timestamptz'}`,
        claim.kind === "migrationNotice" ? [claim.subscription.id, result.rows[0].sentAt] :
          [claim.subscription.id, result.rows[0].sentAt, claim.cycle]);
      });
    },
    async close() { await pool.end(); },
  };
}
module.exports = { createNotificationStore };
