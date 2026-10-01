const { messagingState, timeMs } = require("./dynamic-config");
const GB = 1024n ** 3n;
const MESSAGES = {
  expiryWarning: "သက်တမ်းသတိပေးချက်\n\nသင့် VPN သက်တမ်းက မနက်ဖြန်ကုန်တော့မှာပါ။\n\nဆက်လက်အသုံးပြုနိုင်အောင် ကြိုတင်သက်တမ်းတိုးထားလို့ရပါတယ်။",
  lowDataWarning: "Data သတိပေးချက်\n\nသင့် package မှာ data 1 GB အောက်ပဲ ကျန်တော့ပါတယ်။\n\nဆက်လက်အသုံးပြုနိုင်ဖို့ package ကို ကြိုတင်ဝယ်ထားလို့ရပါတယ်။",
  expiredNotice: "VPN သက်တမ်းကုန်သွားပါပြီ\n\nအခု VPN ကို ဆက်အသုံးပြုလို့မရတော့ပါဘူး။\n\nဆက်သုံးချင်ရင် သက်တမ်းတိုးလို့ရပါတယ်။",
  quotaNotice: "Package data ကုန်သွားပါပြီ\n\nဒီ package နဲ့ VPN ကို ဆက်အသုံးပြုလို့မရတော့ပါဘူး။\n\nဆက်လက်အသုံးပြုနိုင်အောင် package အသစ်ဝယ်နိုင်ပါတယ်။",
  migrationNotice: "VPN connection ကို update လုပ်ထားပါတယ်။\n\nအောက်က ချိတ်ဆက်ရန်ကိုနှိပ်ပြီး Outline app ထဲ တစ်ကြိမ်ပြန်ထည့်ပေးပါ။\n\nနောက်ပိုင်း key ပြန်ပြောင်းစရာမလိုတော့ပါဘူး။",
};
const FIELDS = { expiryWarning: "expiryWarningSentAt", lowDataWarning: "lowDataWarningSentAt",
  expiredNotice: "expiredNoticeSentAt", quotaNotice: "quotaNoticeSentAt", migrationNotice: "migrationNoticeSentAt" };

function remainingBytes(subscription) {
  // Same integer allowance conversion as existing Outline enforcement. Never use display rounding.
  const allowance = Number(subscription.dataLimitGb) * Number(GB);
  if (!Number.isSafeInteger(allowance) || allowance <= 0 || subscription.dataUsedBytes == null) return null;
  try { return BigInt(allowance) - BigInt(subscription.dataUsedBytes); } catch { return null; }
}
function eligibleKinds(subscription, now = Date.now()) {
  const state = messagingState(subscription, now);
  if (state === "EXPIRED") return ["expiredNotice"];
  if (state !== "ACTIVE" && state !== "DATA_LIMIT_REACHED") return [];
  const kinds = [];
  const left = timeMs(subscription.expiresAt) - timeMs(now);
  if (left > 0 && left <= 24 * 60 * 60 * 1000) kinds.push("expiryWarning");
  if (state === "DATA_LIMIT_REACHED") return [...kinds, "quotaNotice"];
  const bytes = remainingBytes(subscription);
  if (bytes != null && bytes > 0n && bytes <= GB) kinds.push("lowDataWarning");
  return kinds;
}
function renewalNotificationReset(alreadyApplied) {
  return alreadyApplied ? {} : { expiryWarningSentAt: null, lowDataWarningSentAt: null,
    expiredNoticeSentAt: null, quotaNoticeSentAt: null };
}
function definitelyRejected(error) {
  // Only an explicit Bot API rejection proves Telegram did not create a message.
  const response = error?.response;
  return response?.ok === false && Number.isInteger(response.error_code) && response.error_code >= 400 && response.error_code < 500;
}

function createSubscriptionNotifications({ store, sendMessage, prepareMigration, log = console }) {
  let running;
  let lastReviewCount;
  async function deliver(id, kind) {
    let claim;
    try {
      claim = await store.claim(id, kind);
      if (!claim) return;
      let text = MESSAGES[kind];
      let extra = {};
      if (kind === "migrationNotice") {
        try {
          const delivery = await prepareMigration(claim.subscription);
          text = (delivery.text || text) + `\n\n${delivery.accessUrl}`;
          extra = delivery.extra;
        } catch {
          // Local preparation failed before any send could happen.
          await store.failed(claim, 60);
          log.error("Dynamic key delivery preparation failed; retry scheduled.");
          return;
        }
      }
      let sent;
      try { sent = await sendMessage(claim.telegramId, text, extra); }
      catch (error) {
        if (definitelyRejected(error)) {
          const delay = Math.max(60, Math.min(86400, Number(error.response.parameters?.retry_after) || 60));
          await store.failed(claim, delay);
          log.error("Subscription notification rejected; retry scheduled.", { kind });
        } else {
          log.error("Subscription notification outcome uncertain; manual review required.", { kind });
        }
        return;
      }
      if (!Number.isSafeInteger(sent?.message_id)) {
        log.error("Subscription notification confirmation unavailable; manual review required.", { kind });
        return;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await store.sent(claim, sent.message_id); break; }
        catch (error) { if (attempt === 2) throw error; }
      }
    } catch {
      // A persisted DISPATCHING attempt is never automatically re-sent, even if
      // persisting Telegram's confirmed result failed or the process crashed.
      log.error("Subscription notification failed; inspect durable attempt state.", { kind });
    }
  }
  async function scan() {
    try {
      let after = 0;
      for (;;) {
        const rows = await store.list(after);
        if (!rows.length) break;
        for (const subscription of rows) {
          after = subscription.id;
          try {
            for (const kind of eligibleKinds(subscription)) await deliver(subscription.id, kind);
            if (messagingState(subscription) === "ACTIVE" && !subscription.migrationNoticeSentAt) {
              await deliver(subscription.id, "migrationNotice");
            }
          } catch { log.error("Subscription notification evaluation failed."); }
        }
      }
    } catch { log.error("Subscription notification scan failed; it will retry."); }
    finally {
      try {
        const count = await store.reviewRequired?.();
        if (count > 0 && count !== lastReviewCount) {
          log.error("Subscription notification attempts require manual delivery review.", { count });
        }
        lastReviewCount = count;
      } catch { log.error("Subscription notification review count unavailable."); }
    }
  }
  function run() {
    if (!running) running = scan().finally(() => { running = undefined; });
    return running;
  }
  return { run, deliver };
}
module.exports = { GB, MESSAGES, FIELDS, remainingBytes, eligibleKinds, renewalNotificationReset,
  definitelyRejected, createSubscriptionNotifications };
