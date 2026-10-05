function isPrivateCustomerContext(ctx) {
  return Number.isSafeInteger(ctx.from?.id) && ctx.from.id > 0 &&
    ctx.chat?.type === "private" && String(ctx.chat.id) === String(ctx.from.id);
}
module.exports = { isPrivateCustomerContext };
