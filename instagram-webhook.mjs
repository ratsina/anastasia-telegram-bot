import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDirectory = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(appDirectory, ".env"));

const DEFAULT_GRAPH_VERSION = "v24.0";
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_REMEMBERED_MESSAGE_IDS = 5000;

const INSTAGRAM_REPLY_TEXT = [
  "Привет! 🙌",
  "Вы пришли за обещанным комплексом упражнений для шеи.",
  "",
  "Держите 🤍",
  "",
  "[ССЫЛКА НА КОМПЛЕКС №1]",
].join("\n");

if (isDirectRun()) {
  await main();
}

async function main() {
  const config = instagramConfigFromEnv();
  const missing = requiredInstagramEnv(config);

  if (missing.length) {
    console.error(`Не заполнены обязательные переменные: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const server = createInstagramWebhookServer({ config });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(
      `[instagram-webhook] server started host=0.0.0.0 port=${config.port} path=/webhook`,
    );
  });

  const shutdown = (signal) => {
    console.log(`[instagram-webhook] shutdown signal=${signal}`);
    server.close(() => process.exit(0));
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

function createInstagramWebhookServer({
  config = instagramConfigFromEnv(),
  fetchImpl = globalThis.fetch,
  logger = console,
  defer = setImmediate,
  sendMessage,
} = {}) {
  const processedMessageIds = new Set();
  const sendInstagramMessage =
    sendMessage ?? createInstagramSender(config, fetchImpl);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "instagram-webhook" });
        return;
      }

      if (url.pathname !== "/webhook") {
        sendText(response, 404, "Not found");
        return;
      }

      if (request.method === "GET") {
        handleWebhookVerification(url, response, config, logger);
        return;
      }

      if (request.method !== "POST") {
        response.setHeader("Allow", "GET, POST");
        sendText(response, 405, "Method not allowed");
        return;
      }

      const rawBody = await readRawBody(request);
      const signature = request.headers["x-hub-signature-256"];

      if (!verifyMetaSignature(rawBody, signature, config.appSecret)) {
        logger.warn("[instagram-webhook] rejected request reason=invalid_signature");
        sendText(response, 401, "Invalid signature");
        return;
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        logger.warn("[instagram-webhook] rejected request reason=invalid_json");
        sendText(response, 400, "Invalid JSON");
        return;
      }

      const messageCount = countMessagingEvents(payload);
      logger.info(
        `[instagram-webhook] webhook received object=${safeLogValue(payload?.object)} entries=${payload?.entry?.length ?? 0} messages=${messageCount}`,
      );

      sendText(response, 200, "EVENT_RECEIVED");

      defer(() => {
        processInstagramWebhookPayload(payload, {
          accountId: config.accountId,
          logger,
          processedMessageIds,
          sendMessage: sendInstagramMessage,
        }).catch((error) => {
          logger.error(`[instagram-webhook] processing failed error=${safeErrorCode(error)}`);
        });
      });
    } catch (error) {
      const statusCode = error?.statusCode ?? 500;
      logger.error(
        `[instagram-webhook] request failed status=${statusCode} error=${safeErrorCode(error)}`,
      );
      sendText(response, statusCode, statusCode === 413 ? "Payload too large" : "Internal error");
    }
  });

  server.headersTimeout = 15000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return server;
}

function handleWebhookVerification(url, response, config, logger) {
  const mode = url.searchParams.get("hub.mode");
  const verifyToken = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    challenge !== null &&
    Boolean(config.verifyToken) &&
    constantTimeEqual(verifyToken ?? "", config.verifyToken)
  ) {
    logger.info("[instagram-webhook] verification successful");
    sendText(response, 200, challenge);
    return;
  }

  logger.warn(`[instagram-webhook] verification failed mode=${safeLogValue(mode)}`);
  sendText(response, 403, "Verification failed");
}

async function processInstagramWebhookPayload(
  payload,
  {
    accountId,
    sendMessage,
    logger = console,
    processedMessageIds = new Set(),
  },
) {
  if (payload?.object !== "instagram" || !Array.isArray(payload.entry)) {
    logger.info("[instagram-webhook] ignored payload reason=unsupported_object");
    return { received: 0, replied: 0, ignored: 0 };
  }

  const result = { received: 0, replied: 0, ignored: 0 };

  for (const entry of payload.entry) {
    for (const event of entry.messaging ?? []) {
      const message = event?.message;
      if (!message) continue;

      result.received += 1;
      const senderId = String(event?.sender?.id ?? "");
      const messageId = String(message.mid ?? "");
      const isOwnMessage =
        message.is_echo === true ||
        message.is_self === true ||
        (senderId && senderId === String(accountId));

      if (isOwnMessage) {
        result.ignored += 1;
        logger.info(
          `[instagram-webhook] message ignored reason=own_message id=${maskIdentifier(messageId)}`,
        );
        continue;
      }

      if (!senderId || typeof message.text !== "string") {
        result.ignored += 1;
        logger.info("[instagram-webhook] message ignored reason=no_text_or_sender");
        continue;
      }

      if (messageId && processedMessageIds.has(messageId)) {
        result.ignored += 1;
        logger.info(
          `[instagram-webhook] message ignored reason=duplicate id=${maskIdentifier(messageId)}`,
        );
        continue;
      }

      const keywordMatch = normalizeInstagramKeyword(message.text) === "движение";
      logger.info(
        `[instagram-webhook] incoming message id=${maskIdentifier(messageId)} sender=${maskIdentifier(senderId)} text_length=${message.text.length} keyword_match=${keywordMatch}`,
      );

      if (!keywordMatch) {
        result.ignored += 1;
        continue;
      }

      rememberMessageId(processedMessageIds, messageId);

      try {
        await sendMessage(senderId, INSTAGRAM_REPLY_TEXT);
        result.replied += 1;
        logger.info(
          `[instagram-webhook] automatic reply sent recipient=${maskIdentifier(senderId)} source_message=${maskIdentifier(messageId)}`,
        );
      } catch (error) {
        if (messageId) processedMessageIds.delete(messageId);
        logger.error(
          `[instagram-webhook] automatic reply failed recipient=${maskIdentifier(senderId)} error=${safeErrorCode(error)}`,
        );
      }
    }
  }

  return result;
}

function createInstagramSender(config, fetchImpl = globalThis.fetch) {
  return async (recipientId, text) => {
    const graphVersion = /^v\d+\.\d+$/.test(config.graphVersion)
      ? config.graphVersion
      : DEFAULT_GRAPH_VERSION;
    const endpoint = `https://graph.instagram.com/${graphVersion}/${encodeURIComponent(config.accountId)}/messages`;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
      signal: AbortSignal.timeout(15000),
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // Meta can return an empty or non-JSON error response.
    }

    if (!response.ok || payload?.error) {
      const error = new Error("instagram_api_request_failed");
      error.code = payload?.error?.code ?? response.status;
      throw error;
    }

    return payload;
  };
}

function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !appSecret || typeof signatureHeader !== "string") {
    return false;
  }

  if (!/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(signatureHeader.slice(7), "hex");

  return received.length === expected.length && timingSafeEqual(received, expected);
}

function normalizeInstagramKeyword(text) {
  return String(text).normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("ru-RU");
}

function instagramConfigFromEnv() {
  return {
    accessToken: process.env.INSTAGRAM_ACCESS_TOKEN?.trim() ?? "",
    appSecret: process.env.INSTAGRAM_APP_SECRET?.trim() ?? "",
    verifyToken: process.env.META_VERIFY_TOKEN?.trim() ?? "",
    accountId: process.env.INSTAGRAM_ACCOUNT_ID?.trim() ?? "",
    graphVersion: process.env.META_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION,
    port: parsePort(process.env.PORT),
  };
}

function requiredInstagramEnv(config) {
  const required = [
    ["INSTAGRAM_ACCESS_TOKEN", config.accessToken],
    ["INSTAGRAM_APP_SECRET", config.appSecret],
    ["META_VERIFY_TOKEN", config.verifyToken],
    ["INSTAGRAM_ACCOUNT_ID", config.accountId],
  ];

  return required.filter(([, value]) => !value).map(([name]) => name);
}

function parsePort(value) {
  const port = Number.parseInt(value ?? "3001", 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3001;
}

async function readRawBody(request) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_WEBHOOK_BYTES) {
      const error = new Error("payload_too_large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function countMessagingEvents(payload) {
  if (!Array.isArray(payload?.entry)) return 0;
  return payload.entry.reduce(
    (count, entry) => count + (Array.isArray(entry?.messaging) ? entry.messaging.length : 0),
    0,
  );
}

function rememberMessageId(store, messageId) {
  if (!messageId) return;
  store.add(messageId);

  if (store.size > MAX_REMEMBERED_MESSAGE_IDS) {
    store.delete(store.values().next().value);
  }
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function maskIdentifier(value) {
  const text = String(value ?? "");
  if (!text) return "none";
  return text.length <= 4 ? "***" : `***${text.slice(-4)}`;
}

function safeLogValue(value) {
  return String(value ?? "none").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

function safeErrorCode(error) {
  return safeLogValue(error?.code ?? error?.message ?? "unknown_error");
}

function sendText(response, statusCode, text) {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

function sendJson(response, statusCode, payload) {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");

    for (const line of env.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;

      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env is optional when the environment is supplied by the hosting platform.
  }
}

function isDirectRun() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

export {
  INSTAGRAM_REPLY_TEXT,
  createInstagramSender,
  createInstagramWebhookServer,
  instagramConfigFromEnv,
  normalizeInstagramKeyword,
  processInstagramWebhookPayload,
  requiredInstagramEnv,
  verifyMetaSignature,
};
