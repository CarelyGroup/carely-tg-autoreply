const test = require("node:test");
const assert = require("node:assert/strict");

process.env.BOT_TOKEN = process.env.BOT_TOKEN || "test-bot-token";
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "test-webhook-secret";
process.env.TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN || "test-telegram-secret";

const {
  qaDeliveryIdentity,
  isQaAppsScriptDeliveryAccepted,
  qaDeliveryRetryDelay,
  qaDeliveryFailureReason
} = require("../index");

test("uses Telegram update_id as the idempotency key", () => {
  assert.equal(qaDeliveryIdentity({ update_id: 123, message: { message_id: 1 } }), "update-123");
  assert.equal(qaDeliveryIdentity({ update_id: 123, message: { message_id: 2 } }), "update-123");
});

test("creates a stable fallback identity when update_id is absent", () => {
  const update = { message: { message_id: 25, text: "Комментарий" } };
  assert.equal(qaDeliveryIdentity(update), qaDeliveryIdentity(update));
  assert.notEqual(qaDeliveryIdentity(update), qaDeliveryIdentity({ message: { message_id: 26 } }));
});

test("accepts only a completed Apps Script delivery", () => {
  assert.equal(
    isQaAppsScriptDeliveryAccepted({ ok: true, payload: { ok: true, sheet: "Август 2026", row: 583 } }),
    true
  );
  assert.equal(
    isQaAppsScriptDeliveryAccepted({ ok: true, payload: { ok: true, deferred: true } }),
    false
  );
  assert.equal(isQaAppsScriptDeliveryAccepted({ ok: false, payload: { ok: true } }), false);
});

test("keeps deferred updates retryable with bounded exponential backoff", () => {
  assert.equal(qaDeliveryRetryDelay(1), 5000);
  assert.equal(qaDeliveryRetryDelay(2), 10000);
  assert.equal(qaDeliveryRetryDelay(100), 300000);
  assert.equal(
    qaDeliveryFailureReason({ ok: true, payload: { ok: true, deferred: true, reason: "row_not_found" } }),
    "row_not_found"
  );
});
