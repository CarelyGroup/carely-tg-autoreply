const express = require("express");
const Redis = require("ioredis");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN;
const REDIS_URL = process.env.REDIS_URL;
const QA_BOT_TOKEN = process.env.QA_BOT_TOKEN || BOT_TOKEN;
const QA_TELEGRAM_SECRET_TOKEN = process.env.QA_TELEGRAM_SECRET_TOKEN || TELEGRAM_SECRET_TOKEN;
const QA_CHANNEL_ID = process.env.QA_CHANNEL_ID || "";
const QA_APPS_SCRIPT_WEBHOOK_URL =
  process.env.QA_APPS_SCRIPT_WEBHOOK_URL ||
  "https://script.google.com/macros/s/AKfycbx3p5SEoDy3FdPVz3ujKyx-UTY32KhgLgTTObFyIyur17i5a-ZBVXfWE-66Gv8S0qzG/exec";

if (!BOT_TOKEN || !WEBHOOK_SECRET || !TELEGRAM_SECRET_TOKEN) {
  throw new Error("Missing BOT_TOKEN, WEBHOOK_SECRET or TELEGRAM_SECRET_TOKEN");
}

const redis = REDIS_URL ? new Redis(REDIS_URL) : null;
const inMemoryKeys = new Set();
const QA_DELIVERY_QUEUE_KEY = "carely:qa:delivery:pending";
const QA_DELIVERY_JOB_PREFIX = "carely:qa:delivery:job:";
const QA_DELIVERY_DONE_PREFIX = "carely:qa:delivery:done:";
const QA_DELIVERY_LOCK_PREFIX = "carely:qa:delivery:lock:";
const QA_DELIVERY_DONE_TTL_SECONDS = 7 * 24 * 60 * 60;
const QA_DELIVERY_POLL_MS = 1000;
const QA_DELIVERY_LOCK_MS = 60 * 1000;
const QA_DELIVERY_BATCH_SIZE = 5;
const QA_DELIVERY_RETRY_BASE_MS = 5000;
const QA_DELIVERY_RETRY_MAX_MS = 5 * 60 * 1000;
let qaDeliveryWorkerRunning = false;
let qaDeliveryWorkerTimer = null;

if (!redis) {
  console.warn("REDIS_URL is not set. Reply history will reset after Render restarts.");
}

if (redis) {
  redis.on("error", (error) => {
    console.error("Redis error:", error);
  });
}

const keywordRegex =
  /сотруднич|партн[её]р|партнерств|партнёрств|коллаб|интеграц|бартер|реклам|блогер|инфлюенс/i;

const operatorRegex =
  /оператор|менеджер|живой человек|сотрудник|поддержк|позвать оператор/i;

const replyText = `Здравствуйте!

Мы сотрудничаем с блогерами, которые соответствуют следующим критериям:
- страна проживания - Россия;
- возраст: от 18 лет;
- среднее кол-во просмотров на вертикальных роликах в YouTube, TikTok, VK, Likee, Wibes - от 1500;
- среднее кол-во просмотров постов в Telegram, Дзен, Pinterest - от 1000.

С блогерами в Instagram* на данный момент не сотрудничаем.

<b>Если ваши аккаунты соответствуют критериям,</b>
зарегистрируйтесь на нашей платформе по работе с блогерами:
https://bloggers.carely.group/register?scout_id=8_tg

<b>Важно!</b> Для проверки принадлежности аккаунта в социальной сети вам необходимо будет указать в описании профиля фразу "CRL". Как только аккаунт будет проверен, вы сможете удалить фразу из описания (обычно это занимает около 3 рабочих дней).

💜 Благодарим за понимание и интерес к бренду!

<i>*Деятельность организации Meta запрещена на территории РФ.</i>

Если вас интересует иное сотрудничество, пожалуйста, напишите нам на почту: pr@carely.group`;

const operatorText = `💌 Оператор ответит вам в течение 24 часов.
<i>В зависимости от нагрузки время ответа может быть увеличено.</i>

Пожалуйста, напишите максимально детально ваше предложение или запрос, если это необходимо.

Благодарим за понимание!`;

async function callTelegramWithToken(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: false, description: text };
  }

  if (!response.ok || !data.ok) {
    console.error(`${method} failed:`, data);
  }

  return data;
}

async function callTelegram(method, payload) {
  return callTelegramWithToken(BOT_TOKEN, method, payload);
}

async function callQaTelegram(method, payload) {
  return callTelegramWithToken(QA_BOT_TOKEN, method, payload);
}

async function forwardQaUpdateToAppsScript(update, options = {}) {
  const controller = new AbortController();
  // Comment updates can require one read across each active monthly sheet.
  // Keep the durable queue item until Apps Script has enough time to answer.
  const timeoutMs = Number(options.timeoutMs || 45000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(QA_APPS_SCRIPT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "telegram_update", update }),
      redirect: "follow",
      signal: controller.signal
    });

    const text = await response.text();
    if (!response.ok) {
      console.error("QA Apps Script forward failed:", response.status, text.slice(0, 500));
      return { ok: false, status: response.status, text };
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      console.error("QA Apps Script returned invalid JSON:", text.slice(0, 500));
      return { ok: false, status: response.status, text, error: "invalid_json" };
    }

    if (!payload || payload.ok !== true) {
      console.error("QA Apps Script rejected update:", JSON.stringify(payload).slice(0, 500));
      return { ok: false, status: response.status, text, payload };
    }

    return { ok: true, text, payload };
  } catch (error) {
    console.error("QA Apps Script request failed:", error);
    return {
      ok: false,
      status: 0,
      text: "",
      error: error?.name === "AbortError" ? "timeout" : String(error?.message || error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function qaDeliveryIdentity(update) {
  if (update?.update_id !== undefined && update?.update_id !== null) {
    return `update-${String(update.update_id)}`;
  }

  return `sha256-${crypto
    .createHash("sha256")
    .update(JSON.stringify(update || {}))
    .digest("hex")}`;
}

function isQaAppsScriptDeliveryAccepted(forwardResult) {
  return Boolean(
    forwardResult?.ok === true &&
      forwardResult?.payload?.ok === true &&
      forwardResult.payload.deferred !== true
  );
}

function qaDeliveryRetryDelay(attempts) {
  const exponent = Math.max(0, Math.min(Number(attempts || 1) - 1, 10));
  return Math.min(QA_DELIVERY_RETRY_MAX_MS, QA_DELIVERY_RETRY_BASE_MS * 2 ** exponent);
}

function qaDeliveryFailureReason(forwardResult) {
  if (forwardResult?.payload?.deferred === true) {
    return String(
      forwardResult.payload.error || forwardResult.payload.reason || "apps_script_deferred"
    );
  }
  return String(
    forwardResult?.error ||
      forwardResult?.payload?.error ||
      forwardResult?.payload?.reason ||
      (forwardResult?.status ? `http_${forwardResult.status}` : "apps_script_forward_failed")
  );
}

async function enqueueQaUpdate(update) {
  if (!redis) {
    throw new Error("durable_qa_queue_unavailable");
  }

  const id = qaDeliveryIdentity(update);
  const doneKey = QA_DELIVERY_DONE_PREFIX + id;
  if ((await redis.exists(doneKey)) === 1) {
    return { id, alreadyDelivered: true };
  }

  const now = Date.now();
  const job = {
    id,
    update,
    attempts: 0,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    lastError: ""
  };

  await redis
    .multi()
    .set(QA_DELIVERY_JOB_PREFIX + id, JSON.stringify(job), "NX")
    .zadd(QA_DELIVERY_QUEUE_KEY, "NX", now, id)
    .exec();

  return { id, alreadyDelivered: false };
}

async function releaseQaDeliveryLock(lockKey, token) {
  if (!redis) return;
  await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    lockKey,
    token
  );
}

async function processQaDeliveryJob(id) {
  if (!redis) return;

  const lockKey = QA_DELIVERY_LOCK_PREFIX + id;
  const lockToken = `${process.pid}:${Date.now()}:${crypto.randomUUID()}`;
  const locked = await redis.set(lockKey, lockToken, "NX", "PX", QA_DELIVERY_LOCK_MS);
  if (!locked) return;

  try {
    const jobKey = QA_DELIVERY_JOB_PREFIX + id;
    const rawJob = await redis.get(jobKey);
    if (!rawJob) {
      await redis.zrem(QA_DELIVERY_QUEUE_KEY, id);
      return;
    }

    let job;
    try {
      job = JSON.parse(rawJob);
    } catch (error) {
      console.error("QA delivery job is invalid JSON; retaining for inspection:", id, error);
      await redis.zadd(QA_DELIVERY_QUEUE_KEY, Date.now() + QA_DELIVERY_RETRY_MAX_MS, id);
      return;
    }

    const forwardResult = await forwardQaUpdateToAppsScript(job.update);
    if (isQaAppsScriptDeliveryAccepted(forwardResult)) {
      await redis
        .multi()
        .set(QA_DELIVERY_DONE_PREFIX + id, String(Date.now()), "EX", QA_DELIVERY_DONE_TTL_SECONDS)
        .del(jobKey)
        .zrem(QA_DELIVERY_QUEUE_KEY, id)
        .exec();
      console.log("QA update delivered from durable queue:", id);
      return;
    }

    const attempts = Number(job.attempts || 0) + 1;
    const delay = qaDeliveryRetryDelay(attempts);
    job.attempts = attempts;
    job.updatedAt = new Date().toISOString();
    job.lastError = qaDeliveryFailureReason(forwardResult);

    await redis
      .multi()
      .set(jobKey, JSON.stringify(job))
      .zadd(QA_DELIVERY_QUEUE_KEY, Date.now() + delay, id)
      .exec();
    console.warn("QA update retained for retry:", id, job.lastError, `attempt=${attempts}`);
  } finally {
    await releaseQaDeliveryLock(lockKey, lockToken);
  }
}

async function drainQaDeliveryQueue() {
  if (!redis || qaDeliveryWorkerRunning) return;
  qaDeliveryWorkerRunning = true;

  try {
    const ids = await redis.zrangebyscore(
      QA_DELIVERY_QUEUE_KEY,
      0,
      Date.now(),
      "LIMIT",
      0,
      QA_DELIVERY_BATCH_SIZE
    );
    for (const id of ids) {
      await processQaDeliveryJob(id);
    }
  } catch (error) {
    console.error("QA durable delivery worker failed:", error);
  } finally {
    qaDeliveryWorkerRunning = false;
  }
}

function startQaDeliveryWorker() {
  if (!redis || qaDeliveryWorkerTimer) return;
  qaDeliveryWorkerTimer = setInterval(() => {
    void drainQaDeliveryQueue();
  }, QA_DELIVERY_POLL_MS);
  void drainQaDeliveryQueue();
}

function getQaStatusFromCallback(data) {
  const normalized = String(data || "");
  if (normalized === "qa_status|fire") {
    return { emoji: "🔥", text: "Отмечено: ответ готов" };
  }
  if (normalized === "qa_status|moon") {
    return { emoji: "🌚", text: "Отмечено: нужна корректировка" };
  }
  return null;
}

async function handleQaCallback(update) {
  const callback = update.callback_query;
  const status = getQaStatusFromCallback(callback?.data);
  if (!callback || !status || !callback.message?.chat?.id || !callback.message?.message_id) {
    return false;
  }

  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;

  await callQaTelegram("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: status.text
  });

  const reactionResult = await callQaTelegram("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji: status.emoji }],
    is_big: false
  });

  const syntheticReactionUpdate = {
    update_id: update.update_id,
    message_reaction_count: {
      chat: callback.message.chat,
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      reactions: [
        {
          reaction: { type: "emoji", emoji: status.emoji },
          total_count: 1
        }
      ]
    }
  };

  const forwardResult = await forwardQaUpdateToAppsScript(syntheticReactionUpdate);
  if (forwardResult.ok) {
    console.log(
      "QA callback status forwarded to Apps Script:",
      forwardResult.text.slice(0, 500),
      "reaction:",
      reactionResult?.ok ? "set" : "not_set"
    );
  }

  return true;
}

// Override the first QA callback implementation with a more resilient flow:
// acknowledge Telegram first, then write the decision and update UI best-effort.
function getQaStatusFromCallback(data) {
  const normalized = String(data || "");
  const parts = normalized.split("|");
  const targetMessageId = parts[2] ? Number(parts[2]) : null;
  if (parts[0] === "qa_status" && parts[1] === "fire") {
    return {
      emoji: "\uD83D\uDD25",
      text: "\u041e\u0442\u0432\u0435\u0442 \u043a\u043e\u0440\u0440\u0435\u043a\u0442\u0435\u043d",
      targetMessageId
    };
  }
  if (parts[0] === "qa_status" && parts[1] === "moon") {
    return {
      emoji: "\uD83C\uDF1A",
      text: "\u041d\u0443\u0436\u043d\u0430 \u043f\u0440\u0430\u0432\u043a\u0430",
      targetMessageId
    };
  }
  return null;
}

async function setQaMessageReactionBestEffort(chatId, messageId, emoji) {
  const clearResult = await callQaTelegram("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [],
    is_big: false
  });

  const setResult = await callQaTelegram("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
    is_big: false
  });

  return { clearResult, setResult };
}

async function handleQaCallback(update) {
  const callback = update.callback_query;
  const status = getQaStatusFromCallback(callback?.data);
  if (!callback || !status || !callback.message?.chat?.id || !callback.message?.message_id) {
    return false;
  }

  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const targetMessageId = status.targetMessageId || messageId;
  const targetChatId = status.targetMessageId && QA_CHANNEL_ID ? Number(QA_CHANNEL_ID) : chatId;
  const syntheticReactionUpdate = {
    update_id: update.update_id,
    message_reaction_count: {
      chat: callback.message.chat,
      message_id: targetMessageId,
      date: Math.floor(Date.now() / 1000),
      reactions: [
        {
          reaction: { type: "emoji", emoji: status.emoji },
          total_count: 1
        }
      ]
    }
  };

  const answerResult = await callQaTelegram("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: status.text
  });
  const forwardResult = await forwardQaUpdateToAppsScript(syntheticReactionUpdate);
  const reactionResult = await setQaMessageReactionBestEffort(targetChatId, targetMessageId, status.emoji);

  console.log(
    "QA callback processed:",
    JSON.stringify({
      forwarded: !!forwardResult?.ok,
      answered: !!answerResult?.ok,
      reactionCleared: !!reactionResult?.clearResult?.ok,
      reactionSet: !!reactionResult?.setResult?.ok,
      messageId,
      targetMessageId
    })
  );

  return true;
}

function getQaPrivateCommand(text) {
  const match = String(text || "").trim().match(/^\/(start|id)(?:@\w+)?(?:\s|$)/i);
  return match ? match[1].toLowerCase() : null;
}

function formatQaUserDisplayName(user) {
  const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return fullName || "не указано";
}

async function handleQaPrivateCommand(update) {
  const msg = update.message || update.edited_message;
  if (!msg || msg.chat?.type !== "private") {
    return false;
  }

  const command = getQaPrivateCommand(msg.text || msg.caption || "");
  if (!command) {
    return false;
  }

  const from = msg.from || {};
  const chatId = msg.chat.id;
  const userId = from.id || "";
  const username = from.username ? `@${from.username}` : "не указан";
  const fullName = formatQaUserDisplayName(from);

  const text =
    command === "start"
      ? [
          "Бот подключен.",
          "",
          `Ваш chat_id: ${chatId}`,
          userId ? `Ваш user_id: ${userId}` : "",
          `Username: ${username}`,
          `Имя: ${fullName}`,
          "",
          "Этот chat_id можно использовать для личных уведомлений."
        ].filter(Boolean).join("\n")
      : [
          `chat_id: ${chatId}`,
          userId ? `user_id: ${userId}` : "",
          `username: ${username}`,
          `name: ${fullName}`
        ].filter(Boolean).join("\n");

  const result = await callQaTelegram("sendMessage", {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true }
  });

  console.log(
    "QA private command processed:",
    JSON.stringify({
      command,
      chatId,
      userId,
      username: from.username || "",
      sent: !!result?.ok
    })
  );

  return true;
}

async function markBusinessMessageRead(msg) {
  if (!msg.business_connection_id || !msg.chat?.id || !msg.message_id) return;

  const result = await callTelegram("readBusinessMessage", {
    business_connection_id: msg.business_connection_id,
    chat_id: msg.chat.id,
    message_id: msg.message_id
  });

  if (!result?.ok) {
    console.error("Could not mark message as read");
  }
}

async function hasKey(key) {
  if (redis) {
    return (await redis.exists(key)) === 1;
  }

  return inMemoryKeys.has(key);
}

async function setKey(key) {
  if (redis) {
    await redis.set(key, String(Date.now()));
    return;
  }

  inMemoryKeys.add(key);
}

async function sendMainReply(chatId, businessConnectionId) {
  return callTelegram("sendMessage", {
    chat_id: chatId,
    business_connection_id: businessConnectionId,
    text: replyText,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Зарегистрироваться",
            url: "https://bloggers.carely.group/register?scout_id=8_tg"
          }
        ],
        [
          {
            text: "Позвать оператора",
            callback_data: "call_operator"
          }
        ]
      ]
    }
  });
}

async function sendOperatorReply(chatId, businessConnectionId) {
  return callTelegram("sendMessage", {
    chat_id: chatId,
    business_connection_id: businessConnectionId,
    text: operatorText,
    parse_mode: "HTML"
  });
}

app.get("/", (req, res) => {
  res.send("Carely Telegram autoreply is running");
});

app.get(`/setup-webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://${req.get("host")}`;
  const webhookUrl = `${baseUrl}/webhook/${WEBHOOK_SECRET}`;

  const data = await callTelegram("setWebhook", {
    url: webhookUrl,
    secret_token: TELEGRAM_SECRET_TOKEN,
    allowed_updates: ["business_connection", "business_message", "callback_query"]
  });

  res.json({ webhookUrl, telegram: data });
});

app.get(`/admin/clear-replied/${WEBHOOK_SECRET}`, async (req, res) => {
  const patterns = ["cooperation_autoreplied:*", "operator_called:*"];
  let deleted = 0;

  if (redis) {
    for (const pattern of patterns) {
      let cursor = "0";

      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          100
        );

        cursor = nextCursor;

        if (keys.length > 0) {
          deleted += await redis.del(...keys);
        }
      } while (cursor !== "0");
    }
  } else {
    deleted = inMemoryKeys.size;
    inMemoryKeys.clear();
  }

  res.json({
    ok: true,
    deleted,
    patterns
  });
});

app.get(`/qa-health/${WEBHOOK_SECRET}`, async (req, res) => {
  let pendingDeliveries = null;
  if (redis) {
    try {
      pendingDeliveries = await redis.zcard(QA_DELIVERY_QUEUE_KEY);
    } catch (error) {
      console.error("Could not read QA delivery queue health:", error);
    }
  }

  res.json({
    ok: true,
    service: "carely-qa-webhook",
    durableDelivery: Boolean(redis),
    pendingDeliveries
  });
});

app.post(`/qa-drain/${WEBHOOK_SECRET}`, async (req, res) => {
  if (!redis) {
    return res.status(503).json({ ok: false, error: "durable_queue_unavailable" });
  }

  const ids = await redis.zrange(QA_DELIVERY_QUEUE_KEY, 0, -1);
  if (ids.length > 0) {
    const now = Date.now();
    const scores = [];
    for (const id of ids) scores.push(now, id);
    await redis.zadd(QA_DELIVERY_QUEUE_KEY, ...scores);
  }
  void drainQaDeliveryQueue();
  return res.status(202).json({ ok: true, started: true, rescheduled: ids.length });
});

app.post(`/qa-webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    if (req.get("x-telegram-bot-api-secret-token") !== QA_TELEGRAM_SECRET_TOKEN) {
      console.warn("QA webhook rejected: bad secret token");
      return res.sendStatus(401);
    }

    if (await handleQaCallback(req.body)) {
      return res.sendStatus(200);
    }

    if (await handleQaPrivateCommand(req.body)) {
      return res.sendStatus(200);
    }

    if (redis) {
      const queued = await enqueueQaUpdate(req.body);
      console.log(
        queued.alreadyDelivered ? "QA update already delivered:" : "QA update durably queued:",
        queued.id
      );
      void drainQaDeliveryQueue();
      return res.sendStatus(200);
    }

    // Without durable storage, acknowledge Telegram only after Apps Script
    // confirms that the update was applied rather than merely deferred.
    const forwardResult = await forwardQaUpdateToAppsScript(req.body, { timeoutMs: 45000 });
    if (isQaAppsScriptDeliveryAccepted(forwardResult)) {
      console.log("QA update synchronously delivered to Apps Script:", forwardResult.text.slice(0, 500));
      return res.sendStatus(200);
    }

    return res.status(503).json({
      ok: false,
      error: "apps_script_delivery_not_confirmed",
      reason: qaDeliveryFailureReason(forwardResult)
    });
  } catch (error) {
    console.error("QA webhook handler failed:", error);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: "qa_webhook_handler_failed" });
    }
  }
});

app.post(`/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200);

  try {
    if (req.get("x-telegram-bot-api-secret-token") !== TELEGRAM_SECRET_TOKEN) {
      return;
    }

    const callback = req.body.callback_query;

    if (callback) {
      await callTelegram("answerCallbackQuery", {
        callback_query_id: callback.id
      });

      if (callback.data === "call_operator") {
        const chatId = callback.message?.chat?.id;
        const businessConnectionId = callback.message?.business_connection_id;

        if (chatId && businessConnectionId) {
          const operatorKey = `operator_called:${businessConnectionId}:${chatId}`;

          if (await hasKey(operatorKey)) {
            return;
          }

          const result = await sendOperatorReply(chatId, businessConnectionId);

          if (result?.ok) {
            await setKey(operatorKey);
          }
        }
      }

      return;
    }

    const msg = req.body.business_message;
    if (!msg) return;

    if (msg.sender_business_bot || msg.from?.is_bot) return;

    const text = msg.text || msg.caption || "";
    if (!text) return;

    if (operatorRegex.test(text)) {
      await markBusinessMessageRead(msg);

      const operatorKey = `operator_called:${msg.business_connection_id}:${msg.chat.id}`;

      if (await hasKey(operatorKey)) {
        return;
      }

      const result = await sendOperatorReply(msg.chat.id, msg.business_connection_id);

      if (result?.ok) {
        await setKey(operatorKey);
      }

      return;
    }

    if (!keywordRegex.test(text)) return;

    const replyKey = `cooperation_autoreplied:${msg.business_connection_id}:${msg.chat.id}`;

    if (await hasKey(replyKey)) {
      return;
    }

    await markBusinessMessageRead(msg);

    const result = await sendMainReply(msg.chat.id, msg.business_connection_id);

    if (result?.ok) {
      await setKey(replyKey);
    }
  } catch (error) {
    console.error("Webhook handler failed:", error);
  }
});

const port = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Listening on port ${port}`);
    startQaDeliveryWorker();
  });
}

module.exports = {
  app,
  qaDeliveryIdentity,
  isQaAppsScriptDeliveryAccepted,
  qaDeliveryRetryDelay,
  qaDeliveryFailureReason
};
