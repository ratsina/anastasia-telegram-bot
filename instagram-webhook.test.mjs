import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";

import {
  INSTAGRAM_REPLY_TEXT,
  createInstagramSender,
  createInstagramWebhookServer,
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
  assert.equal(normalizeInstagramKeyword("движение!"), "движение!");
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

function incomingMessage({ mid, senderId, text, isEcho = false }) {
  return {
    sender: { id: senderId },
    recipient: { id: TEST_CONFIG.accountId },
    timestamp: Date.now(),
    message: { mid, text, is_echo: isEcho },
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
