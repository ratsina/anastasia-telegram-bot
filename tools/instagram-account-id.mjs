import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnvFile(join(projectDirectory, ".env"));

const DEFAULT_GRAPH_VERSION = "v24.0";

if (isDirectRun()) {
  await main();
}

async function main() {
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN?.trim() ?? "";
  const graphVersion = normalizeGraphVersion(process.env.META_GRAPH_VERSION);

  if (!accessToken) {
    console.error("Не заполнена переменная INSTAGRAM_ACCESS_TOKEN в .env.");
    process.exitCode = 1;
    return;
  }

  try {
    const account = await findInstagramAccount({ accessToken, graphVersion });
    console.log(`username: ${account.username ? `@${account.username}` : "не возвращён API"}`);
    console.log(`Instagram account/user ID: ${account.id}`);
  } catch (error) {
    console.error(`Не удалось получить Instagram account ID: ${safeError(error)}`);
    process.exitCode = 1;
  }
}

async function findInstagramAccount({
  accessToken,
  graphVersion = DEFAULT_GRAPH_VERSION,
  fetchImpl = globalThis.fetch,
}) {
  if (!accessToken) throw new Error("missing_access_token");

  const attempts = [
    {
      url: `https://graph.instagram.com/${graphVersion}/me?fields=user_id%2Cusername`,
      extract: extractDirectAccount,
    },
    {
      url: `https://graph.instagram.com/${graphVersion}/me?fields=id%2Cusername`,
      extract: extractDirectAccount,
    },
    {
      url: `https://graph.facebook.com/${graphVersion}/me/accounts?fields=instagram_business_account%7Bid%2Cusername%7D`,
      extract: extractPageAccount,
    },
    {
      url: `https://graph.facebook.com/${graphVersion}/me?fields=instagram_business_account%7Bid%2Cusername%7D`,
      extract: extractSinglePageAccount,
    },
  ];

  const failures = [];

  for (const attempt of attempts) {
    try {
      const response = await fetchImpl(attempt.url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(15000),
      });
      const payload = await readJson(response);
      const account = response.ok ? attempt.extract(payload) : null;

      if (account?.id) return account;

      failures.push(`${new URL(attempt.url).hostname}:${response.status}:${apiErrorCode(payload)}`);
    } catch (error) {
      failures.push(`${new URL(attempt.url).hostname}:network:${safeErrorCode(error)}`);
    }
  }

  throw new Error(`account_not_found (${failures.join(", ")})`);
}

function extractDirectAccount(payload) {
  const id = payload?.user_id ?? payload?.id;
  if (!id) return null;
  return { id: String(id), username: cleanUsername(payload?.username) };
}

function extractPageAccount(payload) {
  if (!Array.isArray(payload?.data)) return null;
  for (const page of payload.data) {
    const account = extractSinglePageAccount(page);
    if (account) return account;
  }
  return null;
}

function extractSinglePageAccount(payload) {
  const account = payload?.instagram_business_account;
  if (!account?.id) return null;
  return { id: String(account.id), username: cleanUsername(account.username) };
}

function cleanUsername(value) {
  return typeof value === "string" ? value.trim().replace(/^@/, "") : "";
}

function normalizeGraphVersion(value) {
  const normalized = value?.trim() || DEFAULT_GRAPH_VERSION;
  return /^v\d+\.\d+$/.test(normalized) ? normalized : DEFAULT_GRAPH_VERSION;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function apiErrorCode(payload) {
  const code = payload?.error?.code;
  return Number.isInteger(code) || typeof code === "string" ? String(code) : "unknown";
}

function safeError(error) {
  return typeof error?.message === "string" ? error.message : "unknown_error";
}

function safeErrorCode(error) {
  return typeof error?.code === "string" ? error.code : error?.name ?? "unknown_error";
}

function loadEnvFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function isDirectRun() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

export { findInstagramAccount };
