import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(rootDirectory, ".env");
const policyPath = join(rootDirectory, "docs", "privacy_policy.md");

loadEnvFile(envPath);

const operatorName = process.env.PRIVACY_OPERATOR_NAME?.trim();
const telegramUrl = process.env.PRIVACY_CONTACT_TELEGRAM?.trim();

if (!operatorName || !telegramUrl) {
  throw new Error("Заполните PRIVACY_OPERATOR_NAME и PRIVACY_CONTACT_TELEGRAM в .env.");
}

const content = markdownToTelegraph(readFileSync(policyPath, "utf8"));
let accessToken = process.env.TELEGRAPH_ACCESS_TOKEN?.trim();

if (!accessToken) {
  const account = await telegraphRequest("createAccount", {
    short_name: "anastasia_lfk",
    author_name: operatorName,
    author_url: telegramUrl,
  });
  accessToken = account.access_token;
}

const commonPageFields = {
  access_token: accessToken,
  title: "Политика обработки персональных данных",
  author_name: operatorName,
  author_url: telegramUrl,
  content,
  return_content: false,
};

const existingPath = process.env.TELEGRAPH_PAGE_PATH?.trim();
const page = existingPath
  ? await telegraphRequest(`editPage/${existingPath}`, commonPageFields)
  : await telegraphRequest("createPage", commonPageFields);

setEnvValues(envPath, {
  PRIVACY_POLICY_URL: page.url,
  TELEGRAPH_ACCESS_TOKEN: accessToken,
  TELEGRAPH_PAGE_PATH: page.path,
});

console.log(`Политика опубликована: ${page.url}`);

async function telegraphRequest(method, values) {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    body.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  const response = await fetch(`https://api.telegra.ph/${method}`, {
    method: "POST",
    body,
  });
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Telegraph HTTP ${response.status}`);
  }

  return payload.result;
}

function markdownToTelegraph(markdown) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const nodes = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    if (line.startsWith("# ")) continue;

    if (line.startsWith("## ")) {
      nodes.push({ tag: "h3", children: [line.slice(3)] });
      continue;
    }

    if (line.startsWith("— ")) {
      const items = [];

      while (index < lines.length) {
        const item = lines[index].trim();
        if (item.startsWith("— ")) {
          items.push({ tag: "li", children: inlineNodes(item.slice(2)) });
          index += 1;
          continue;
        }
        if (!item) {
          index += 1;
          continue;
        }
        break;
      }

      index -= 1;
      nodes.push({ tag: "ul", children: items });
      continue;
    }

    nodes.push({ tag: "p", children: inlineNodes(line) });
  }

  return nodes;
}

function inlineNodes(text) {
  const nodes = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let position = 0;
  let match;

  while ((match = pattern.exec(text))) {
    if (match.index > position) nodes.push(text.slice(position, match.index));
    nodes.push({ tag: "strong", children: [linkedText(match[1])] });
    position = match.index + match[0].length;
  }

  if (position < text.length) nodes.push(text.slice(position));
  return nodes.length ? nodes : [text];
}

function linkedText(text) {
  if (/^https?:\/\//i.test(text)) {
    return { tag: "a", attrs: { href: text }, children: [text] };
  }

  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) {
    return { tag: "a", attrs: { href: `mailto:${text}` }, children: [text] };
  }

  return text;
}

function loadEnvFile(path) {
  const content = readFileSync(path, "utf8");

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!process.env[key]) process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function setEnvValues(path, values) {
  let content = readFileSync(path, "utf8");

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content)
      ? content.replace(pattern, line)
      : `${content.trimEnd()}\n${line}\n`;
  }

  writeFileSync(path, content, "utf8");
}
