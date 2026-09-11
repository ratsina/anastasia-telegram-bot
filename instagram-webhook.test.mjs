import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";

import {
  INSTAGRAM_CONFIRM_COMPLEX_PAYLOAD,
  INSTAGRAM_DECLINE_COMPLEX_PAYLOAD,
  INSTAGRAM_REPLY_TEXT,
  INSTAGRAM_TYPO_CONFIRMATION_TEXT,
  INSTAGRAM_TYPO_QUICK_REPLIES,
  TELEGRAM_COMPLEX_URL,
  classifyInstagramKeyword,
  createInstagramSender,
  createInstagramWebhookServer,
  instagramConfigFromEnv,
  normalizeInstagramKeyword,
  processInstagramWebhookPayload,
  verifyMetaSignature,
} from "./instagram-webhook.mjs";

const TEST_CONFIG = {
  accessToken: "test-access-token",
  appSecret: "test-app-secret",
  verifyToken: "test-verify-token",
  accountId: "17841400000000000",
  graphVersion: "v24.0",
  port: 0,
};

test("normalizes all supported keyword spellings", () => {
  assert.equal(normalizeInstagramKeyword("ДВИЖЕНИЕ"), "движение");
  assert.equal(normalizeInstagramKeyword("  Движение  "), "движение");
  assert.equal(normalizeInstagramKeyword("д в и ж е н и е"), "движение");
  assert.equal(normalizeInstagramKeyword("движение!"), "движение");
  assert.equal(normalizeInstagramKeyword("ДВИЖЕНИЕ!!! 🙌🤍"), "движение");
});

test("sends users to the Telegram complex flow", () => {
  assert.equal(
    TELEGRAM_COMPLEX_URL,
    "https://t.me/anastasia_lfk_massage_bot?start=complex_instagram",
  );
  assert.match(INSTAGRAM_REPLY_TEXT, /получить комплекс №1/);
  assert.ok(INSTAGRAM_REPLY_TEXT.includes(TELEGRAM_COMPLEX_URL));
  assert.equal(INSTAGRAM_REPLY_TEXT.includes("[ССЫЛКА НА КОМПЛЕКС №1]"), false);
});

test("classifies only the exact keyword and one-edit typos", () => {
  for (const text of [
    "ДВИЖЕНИЕ",
    "Движение",
    "д в и ж е н и е",
    " движение... 😊 ",
  ]) {
    assert.equal(classifyInstagramKeyword(text), "exact", text);
  }

  for (const text of ["движене", "движениее", "движенеи"]) {
    assert.equal(classifyInstagramKeyword(text), "typo", text);
  }

  for (const text of [
    "Здравствуйте",
    "Хочу записаться на массаж",
    "Сколько стоит ЛФК?",
    "НЕ ДВИЖЕНИЕ",
    "это не движение",
    "хочу узнать про массаж",
  ]) {
    assert.equal(classifyInstagramKeyword(text), "none", text);
  }
});

test("verifies webhook signatures against the raw request body", () => {
  const body = Buffer.from('{"object":"instagram"}');
  const signature = `sha256=${createHmac("sha256", TEST_CONFIG.appSecret)
    .update(body)
    .digest("hex")}`;

  assert.equal(verifyMetaSignature(body, signature, TEST_CONFIG.appSecret), true);
  assert.equal(verifyMetaSignature(body, "sha256=bad", TEST_CONFIG.appSecret), false);
  assert.equal(verifyMetaSignature(body, undefined, TEST_CONFIG.appSecret), false);
});

test("verifies GET webhook requests and rejects an incorrect token", async (t) => {
  const server = createInstagramWebhookServer({
    config: TEST_CONFIG,
    logger: quietLogger(),
    sendMessage: async () => {},
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  const validUrl = new URL("/webhook", baseUrl);
  validUrl.searchParams.set("hub.mode", "subscribe");
  validUrl.searchParams.set("hub.verify_token", TEST_CONFIG.verifyToken);
  validUrl.searchParams.set("hub.challenge", "123456789");

  const valid = await fetch(validUrl);
  assert.equal(valid.status, 200);
  assert.equal(await valid.text(), "123456789");

  validUrl.searchParams.set("hub.verify_token", "incorrect");
  const invalid = await fetch(validUrl);
  assert.equal(invalid.status, 403);
});

test("serves the Render health check endpoint", async (t) => {
  const server = createInstagramWebhookServer({
    config: TEST_CONFIG,
    logger: quietLogger(),
    sendMessage: async () => {},
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "instagram-webhook" });
});

test("reads the listening port from Render's PORT environment variable", () => {
  const previousPort = process.env.PORT;
  process.env.PORT = "43210";

  try {
    assert.equal(instagramConfigFromEnv().port, 43210);
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
});

test("accepts a signed POST webhook and rejects an invalid signature", async (t) => {
  const sent = [];
  const server = createInstagramWebhookServer({
    config: TEST_CONFIG,
    logger: quietLogger(),
    sendMessage: async (...args) => sent.push(args),
  });
  const baseUrl = await listen(server);
  t.after(() => server.close());

  const payload = instagramPayload([
    incomingMessage({ mid: "mid-valid", senderId: "9001", text: "Движение" }),
  ]);
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", TEST_CONFIG.appSecret)
    .update(body)
    .digest("hex")}`;

  const valid = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": signature,
    },
    body,
  });

  assert.equal(valid.status, 200);
  assert.equal(await valid.text(), "EVENT_RECEIVED");
  await waitFor(() => sent.length === 1);
  assert.deepEqual(sent[0], ["9001", INSTAGRAM_REPLY_TEXT]);

  const invalid = await fetch(`${baseUrl}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
    },
    body,
  });
  assert.equal(invalid.status, 401);
  assert.equal(sent.length, 1);
});

test("matches keyword variants, ignores echoes and deduplicates message IDs", async () => {
  const sent = [];
  const logs = [];
  const processedMessageIds = new Set();
  const logger = {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    error: (message) => logs.push(message),
  };
  const payload = instagramPayload([
    incomingMessage({ mid: "mid-1", senderId: "1001", text: "ДВИЖЕНИЕ" }),
    incomingMessage({ mid: "mid-2", senderId: "1002", text: "Движение" }),
    incomingMessage({ mid: "mid-3", senderId: "1003", text: "д в и ж е н и е" }),
    incomingMessage({ mid: "mid-4", senderId: "1004", text: "другое" }),
    incomingMessage({ mid: "mid-5", senderId: TEST_CONFIG.accountId, text: "ДВИЖЕНИЕ" }),
    incomingMessage({ mid: "mid-6", senderId: "1006", text: "ДВИЖЕНИЕ", isEcho: true }),
    incomingMessage({ mid: "mid-1", senderId: "1001", text: "ДВИЖЕНИЕ" }),
  ]);

  const result = await processInstagramWebhookPayload(payload, {
    accountId: TEST_CONFIG.accountId,
    logger,
    processedMessageIds,
    sendMessage: async (...args) => sent.push(args),
  });

  assert.equal(result.received, 7);
  assert.equal(result.replied, 3);
  assert.equal(result.ignored, 4);
  assert.equal(sent.length, 3);
  assert.ok(sent.every(([, text]) => text === INSTAGRAM_REPLY_TEXT));
  assert.equal(logs.join("\n").includes(TEST_CONFIG.appSecret), false);
  assert.equal(logs.join("\n").includes(TEST_CONFIG.accessToken), false);
});

test("stays silent for ordinary Direct messages", async () => {
  const sent = [];
  const texts = [
    "Здравствуйте",
    "Хочу записаться на массаж",
    "Сколько стоит ЛФК?",
    "НЕ ДВИЖЕНИЕ",
    "это не движение",
    "хочу узнать про массаж",
  ];
  const payload = instagramPayload(
    texts.map((text, index) =>
      incomingMessage({ mid: `silent-${index}`, senderId: "2001", text }),
    ),
  );

  const result = await processInstagramWebhookPayload(payload, {
    accountId: TEST_CONFIG.accountId,
    logger: quietLogger(),
    sendMessage: async (...args) => sent.push(args),
  });

  assert.deepEqual(result, { received: texts.length, replied: 0, ignored: texts.length });
  assert.deepEqual(sent, []);
});

test("asks for confirmation on a close typo and handles both quick replies", async () => {
  const sent = [];
  const processedMessageIds = new Set();
  const payload = instagramPayload([
    incomingMessage({ mid: "typo-1", senderId: "3001", text: "движенеи 😊" }),
    incomingMessage({
      mid: "yes-1",
      senderId: "3001",
      text: "✅ Получить комплекс",
      quickReplyPayload: INSTAGRAM_CONFIRM_COMPLEX_PAYLOAD,
    }),
    incomingMessage({
      mid: "no-1",
      senderId: "3002",
      text: "Нет",
      quickReplyPayload: INSTAGRAM_DECLINE_COMPLEX_PAYLOAD,
    }),
  ]);

  const result = await processInstagramWebhookPayload(payload, {
    accountId: TEST_CONFIG.accountId,
    logger: quietLogger(),
    processedMessageIds,
    sendMessage: async (...args) => sent.push(args),
  });

  assert.deepEqual(result, { received: 3, replied: 2, ignored: 1 });
  assert.deepEqual(sent, [
    [
      "3001",
      INSTAGRAM_TYPO_CONFIRMATION_TEXT,
      { quickReplies: INSTAGRAM_TYPO_QUICK_REPLIES },
    ],
    ["3001", INSTAGRAM_REPLY_TEXT],
  ]);
});

test("sends text through the Instagram Graph messages endpoint", async () => {
  let request;
  const sender = createInstagramSender(TEST_CONFIG, async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ recipient_id: "9001", message_id: "sent-1" }),
    };
  });

  await sender("9001", "Ответ");

  assert.equal(
    request.url,
    `https://graph.instagram.com/v24.0/${TEST_CONFIG.accountId}/messages`,
  );
  assert.equal(request.options.headers.Authorization, `Bearer ${TEST_CONFIG.accessToken}`);
  assert.deepEqual(JSON.parse(request.options.body), {
    recipient: { id: "9001" },
    message: { text: "Ответ" },
  });
});

test("sends Instagram quick replies without exposing configuration", async () => {
  let request;
  const sender = createInstagramSender(TEST_CONFIG, async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ recipient_id: "9001", message_id: "sent-2" }),
    };
  });

  await sender("9001", INSTAGRAM_TYPO_CONFIRMATION_TEXT, {
    quickReplies: INSTAGRAM_TYPO_QUICK_REPLIES,
  });

  assert.deepEqual(JSON.parse(request.options.body), {
    recipient: { id: "9001" },
    message: {
      text: INSTAGRAM_TYPO_CONFIRMATION_TEXT,
      quick_replies: INSTAGRAM_TYPO_QUICK_REPLIES,
    },
  });
  assert.ok(
    INSTAGRAM_TYPO_QUICK_REPLIES.every(
      ({ title }) => Array.from(title).length <= 20,
    ),
  );
});

function instagramPayload(messaging) {
  return {
    object: "instagram",
    entry: [
      {
        id: TEST_CONFIG.accountId,
        time: Date.now(),
        messaging,
      },
    ],
  };
}

function incomingMessage({
  mid,
  senderId,
  text,
  isEcho = false,
  quickReplyPayload,
}) {
  return {
    sender: { id: senderId },
    recipient: { id: TEST_CONFIG.accountId },
    timestamp: Date.now(),
    message: {
      mid,
      text,
      is_echo: isEcho,
      ...(quickReplyPayload
        ? { quick_reply: { payload: quickReplyPayload } }
        : {}),
    },
  };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}
