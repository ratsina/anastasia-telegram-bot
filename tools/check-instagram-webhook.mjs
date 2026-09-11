import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnvFile(join(rootDirectory, ".env"));

const baseUrl = (process.env.INSTAGRAM_WEBHOOK_BASE_URL ?? "http://127.0.0.1:3001").replace(
  /\/$/,
  "",
);
const verifyToken = process.env.META_VERIFY_TOKEN?.trim();
const appSecret = process.env.INSTAGRAM_APP_SECRET?.trim();
const accountId = process.env.INSTAGRAM_ACCOUNT_ID?.trim() || "test-account";

if (!verifyToken || !appSecret) {
  throw new Error("Заполните META_VERIFY_TOKEN и INSTAGRAM_APP_SECRET в .env.");
}

const verificationUrl = new URL(`${baseUrl}/webhook`);
verificationUrl.searchParams.set("hub.mode", "subscribe");
verificationUrl.searchParams.set("hub.verify_token", verifyToken);
verificationUrl.searchParams.set("hub.challenge", "local-test-ok");

const verification = await fetch(verificationUrl);
const challenge = await verification.text();
console.log(`GET /webhook: HTTP ${verification.status}, challenge=${challenge}`);

const payload = {
  object: "instagram",
  entry: [
    {
      id: accountId,
      time: Date.now(),
      messaging: [
        {
          sender: { id: "local-test-sender" },
          recipient: { id: accountId },
          timestamp: Date.now(),
          message: { mid: `local-test-${Date.now()}`, text: "проверка webhook" },
        },
      ],
    },
  ],
};
const body = JSON.stringify(payload);
const signature = `sha256=${createHmac("sha256", appSecret).update(body).digest("hex")}`;
const webhook = await fetch(`${baseUrl}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": signature,
  },
  body,
});

console.log(`POST /webhook: HTTP ${webhook.status}, response=${await webhook.text()}`);

function loadEnvFile(path) {
  const env = readFileSync(path, "utf8");
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!process.env[key]) process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}
