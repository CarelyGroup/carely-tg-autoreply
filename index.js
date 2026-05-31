const express = require("express");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN;
const COOLDOWN_HOURS = Number(process.env.COOLDOWN_HOURS || 24);

if (!BOT_TOKEN || !WEBHOOK_SECRET || !TELEGRAM_SECRET_TOKEN) {
  throw new Error("Missing BOT_TOKEN, WEBHOOK_SECRET or TELEGRAM_SECRET_TOKEN");
}

const repliedAt = new Map();

const keywordRegex =
  /сотруднич|партн[её]р|партнерств|партнёрств|коллаб|интеграц|бартер|реклам|блогер|инфлюенс/i;

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

const operatorText = `Оператор ответит вам в течение 24 часов.

В зависимости от нагрузки, время ответа оператора может быть увеличено.

💜 Благодарим за понимание!`;

async function callTelegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(`${method} failed:`, data || (await response.text()));
  }

  return data;
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
    text: operatorText
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

app.post(`/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200);

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
        await sendOperatorReply(chatId, businessConnectionId);
      }
    }

    return;
  }

  const msg = req.body.business_message;
  if (!msg) return;

  if (msg.sender_business_bot || msg.from?.is_bot) return;

  const text = msg.text || msg.caption || "";
  if (!keywordRegex.test(text)) return;

  const key = `${msg.business_connection_id}:${msg.chat.id}`;
  const now = Date.now();
  const cooldownMs = COOLDOWN_HOURS * 60 * 60 * 1000;
  const lastReply = repliedAt.get(key);

  if (lastReply && now - lastReply < cooldownMs) return;

  repliedAt.set(key, now);
  await sendMainReply(msg.chat.id, msg.business_connection_id);
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
