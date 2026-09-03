const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("does not acknowledge a deferred Apps Script delivery without Redis", async (t) => {
  let appsScriptPayload = { ok: true, deferred: true, reason: "comment_row_not_found" };
  const appsScriptServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(appsScriptPayload));
  });
  await listen(appsScriptServer);
  t.after(() => close(appsScriptServer));

  const appsScriptPort = appsScriptServer.address().port;
  process.env.BOT_TOKEN = "test-bot-token";
  process.env.WEBHOOK_SECRET = "test-webhook-secret";
  process.env.TELEGRAM_SECRET_TOKEN = "test-telegram-secret";
  process.env.QA_TELEGRAM_SECRET_TOKEN = "test-qa-secret";
  process.env.QA_APPS_SCRIPT_WEBHOOK_URL = `http://127.0.0.1:${appsScriptPort}`;
  delete process.env.REDIS_URL;

  const { app } = require("../index");
  const relayServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => relayServer.once("listening", resolve));
  t.after(() => close(relayServer));

  const relayPort = relayServer.address().port;
  const sendUpdate = () =>
    fetch(`http://127.0.0.1:${relayPort}/qa-webhook/test-webhook-secret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-telegram-bot-api-secret-token": "test-qa-secret"
      },
      body: JSON.stringify({
        update_id: 123,
        message: { message_id: 456, chat: { id: -1001, type: "supergroup" }, text: "Комментарий" }
      })
    });

  const deferredResponse = await sendUpdate();
  assert.equal(deferredResponse.status, 503);

  appsScriptPayload = { ok: true, sheet: "Август 2026", row: 583, comment: true };
  const deliveredResponse = await sendUpdate();
  assert.equal(deliveredResponse.status, 200);
});
