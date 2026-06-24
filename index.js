const express = require("express");
const Redis = require("ioredis");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN;
const REDIS_URL = process.env.REDIS_URL;
const QA_APPS_SCRIPT_WEBHOOK_URL =
  process.env.QA_APPS_SCRIPT_WEBHOOK_URL ||
  "https://script.google.com/macros/s/AKfycbx3p5SEoDy3FdPVz3ujKyx-UTY32KhgLgTTObFyIyur17i5a-ZBVXfWE-66Gv8S0qzG/exec";

if (!BOT_TOKEN || !WEBHOOK_SECRET || !TELEGRAM_SECRET_TOKEN) {
  throw new Error("Missing BOT_TOKEN, WEBHOOK_SECRET or TELEGRAM_SECRET_TOKEN");
}

const redis = REDIS_URL ? new Redis(REDIS_URL) : null;
const inMemoryKeys = new Set();

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

async function callTelegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
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

app.get(`/qa-health/${WEBHOOK_SECRET}`, (req, res) => {
  res.json({ ok: true, service: "carely-qa-webhook" });
});

app.post(`/qa-webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200);

  try {
    if (req.get("x-telegram-bot-api-secret-token") !== TELEGRAM_SECRET_TOKEN) {
      console.warn("QA webhook rejected: bad secret token");
      return;
    }

    const response = await fetch(QA_APPS_SCRIPT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "telegram_update", update: req.body }),
      redirect: "follow"
    });

    const text = await response.text();
    if (!response.ok) {
      console.error("QA Apps Script forward failed:", response.status, text.slice(0, 500));
      return;
    }

    console.log("QA update forwarded to Apps Script:", text.slice(0, 500));
  } catch (error) {
    console.error("QA webhook handler failed:", error);
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

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
