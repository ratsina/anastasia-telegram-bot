import test from "node:test";
import assert from "node:assert/strict";

import {
  escapeHtml,
  getSessionSnapshotForTest,
  handleUpdateForTest,
  isMemberStatus,
  normalizePhone,
  resetStateForTest,
  sourceLabel,
} from "./bot.mjs";

test("normalizes Russian and international phone numbers", () => {
  assert.equal(normalizePhone("8 (913) 123-45-67"), "+79131234567");
  assert.equal(normalizePhone("913 123 45 67"), "+79131234567");
  assert.equal(normalizePhone("+49 151 23456789"), "+4915123456789");
  assert.equal(normalizePhone("123"), null);
  assert.equal(normalizePhone("call 89131234567"), null);
});

test("recognizes Telegram channel membership statuses", () => {
  assert.equal(isMemberStatus({ status: "member" }), true);
  assert.equal(isMemberStatus({ status: "administrator" }), true);
  assert.equal(isMemberStatus({ status: "restricted", is_member: true }), true);
  assert.equal(isMemberStatus({ status: "left" }), false);
});

test("sanitizes source labels and HTML", () => {
  assert.equal(sourceLabel("complex_instagram_reels_15"), "instagram reels 15");
  assert.equal(sourceLabel("complex"), "Telegram / ссылка на комплекс");
  assert.equal(escapeHtml("<Анна & Ко>"), "&lt;Анна &amp; Ко&gt;");
});

test("walks through a massage form and edits one field", async () => {
  resetStateForTest();
  const requests = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    requests.push({ method, body });

    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };

  const user = { id: 101, username: "anna", first_name: "Анна" };
  const chat = { id: 101, type: "private" };
  let messageId = 1;
  let callbackId = 1;
  let consentSnapshot;

  const message = async (text, extra = {}) => {
    await handleUpdateForTest({
      message: {
        message_id: messageId++,
        chat,
        from: user,
        text,
        ...extra,
      },
    });
  };
  const click = async (data) => {
    await handleUpdateForTest({
      callback_query: {
        id: `callback-${callbackId++}`,
        from: user,
        data,
        message: { message_id: messageId++, chat },
      },
    });
  };

  try {
    await message("/start instagram_reels_15");
    await click("start_massage");
    await click("continue");
    await click("m_legs");
    await message("Хочу снять напряжение после тренировок");
    await click("health_no");
    await click("time_evening");
    await click("days_weekdays");
    await click("privacy_agree");
    consentSnapshot = getSessionSnapshotForTest(user.id);
    await message("Анна");
    await message("123");
    await message("8 (913) 123-45-67");
    await click("review_edit");
    await click("edit_time");
    await click("time_morning");
    await click("submit");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const messages = requests
    .filter(({ method }) => method === "sendMessage")
    .map(({ body }) => body.text);
  const reviews = messages.filter((text) => text.includes("Проверьте, пожалуйста"));

  assert.equal(reviews.length, 2);
  assert.match(reviews.at(-1), /<b>Вариант:<\/b> Массаж ног/);
  assert.match(
    reviews.at(-1),
    /<b>Требуется дополнительное уточнение с Анастасией:<\/b> нет/,
  );
  assert.match(reviews.at(-1), /<b>Удобное время:<\/b> Утро/);
  assert.match(reviews.at(-1), /<b>Телефон:<\/b> \+79131234567/);
  const privacyIndex = messages.findIndex((text) =>
    text.includes("Согласие на обработку персональных данных"),
  );
  const nameIndex = messages.findIndex((text) => text.includes("Как к вам обращаться"));
  const phoneIndex = messages.findIndex((text) =>
    text.includes("Оставьте, пожалуйста, номер телефона"),
  );

  assert.ok(privacyIndex >= 0 && privacyIndex < nameIndex && nameIndex < phoneIndex);
  assert.ok(messages.some((text) => text.includes("Не получилось распознать номер")));
  assert.ok(messages.some((text) => text.includes("НОВАЯ ЗАЯВКА НА МАССАЖ")));
  assert.ok(messages.some((text) => text.includes("Согласие на обработку ПД:</b> ✅")));
  assert.ok(messages.some((text) => text.includes("Версия согласия:</b> 1.0")));
  assert.ok(messages.some((text) => text.includes("Telegram user ID:</b> 101")));
  assert.ok(messages.some((text) => text.includes("Готово 🤍")));
  assert.equal(consentSnapshot.data.privacy_consent, true);
  assert.equal(consentSnapshot.data.privacy_consent_version, "1.0");
  assert.equal(consentSnapshot.data.privacy_policy_version, "1.0");
  assert.equal(consentSnapshot.data.telegram_user_id, 101);
  assert.ok(Number.isFinite(Date.parse(consentSnapshot.data.privacy_consent_at)));
  const consentMessage = requests.find(
    ({ method, body }) =>
      method === "sendMessage" && body.text.includes("Согласие на обработку персональных данных"),
  );
  assert.match(
    consentMessage.body.reply_markup.inline_keyboard[0][0].url,
    /^https:\/\/telegra\.ph\//,
  );
});

test("walks through LFK, goes one step back and accepts only own contact", async () => {
  resetStateForTest();
  const requests = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    requests.push({
      method: String(url).split("/").at(-1),
      body: JSON.parse(options.body),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };

  const user = { id: 202, username: "maria", first_name: "Мария" };
  const chat = { id: 202, type: "private" };
  let id = 1;
  const message = (text, extra = {}) =>
    handleUpdateForTest({
      message: { message_id: id++, chat, from: user, text, ...extra },
    });
  const click = (data) =>
    handleUpdateForTest({
      callback_query: {
        id: `lfk-${id++}`,
        from: user,
        data,
        message: { message_id: id++, chat },
      },
    });

  try {
    await message("/start");
    await click("start_lfk");
    await click("continue");
    await click("lfk_online");
    await click("area_neck");
    await click("form_back");
    await click("area_lower_back");
    await message("Дискомфорт после долгого сидения");
    await click("lfk_health_yes");
    await click("time_day");
    await click("days_any");
    await click("privacy_agree");
    await message("Мария");
    await message("", {
      contact: { user_id: 999, phone_number: "+79990000000" },
    });
    await message("", {
      contact: { user_id: 202, phone_number: "+79991234567" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const messages = requests
    .filter(({ method }) => method === "sendMessage")
    .map(({ body }) => body.text);
  const review = messages.find((text) => text.includes("Проверьте, пожалуйста"));

  assert.match(review, /<b>Формат:<\/b> Онлайн/);
  assert.match(review, /<b>Запрос:<\/b> Поясница/);
  assert.match(
    review,
    /<b>Требуется дополнительное уточнение с Анастасией:<\/b> да/,
  );
  assert.match(review, /<b>Телефон:<\/b> \+79991234567/);
  assert.ok(messages.some((text) => text.includes("поделитесь своим контактом")));
  assert.ok(messages.some((text) => text.includes("уточнит необходимые детали лично")));
  assert.equal(messages.some((text) => text.includes("Есть рекомендации врача")), false);
});

test("declining privacy consent never asks for contacts or submits", async () => {
  resetStateForTest();
  const requests = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    requests.push({
      method: String(url).split("/").at(-1),
      body: JSON.parse(options.body),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };

  const user = { id: 252, username: "no_consent", first_name: "Иван" };
  const chat = { id: 252, type: "private" };
  let id = 1;
  const message = (text) =>
    handleUpdateForTest({
      message: { message_id: id++, chat, from: user, text },
    });
  const click = (data) =>
    handleUpdateForTest({
      callback_query: {
        id: `privacy-${id++}`,
        from: user,
        data,
        message: { message_id: id++, chat },
      },
    });

  try {
    await message("/start");
    await click("start_advice");
    await message("Хочу понять, какая услуга мне подходит");
    await click("time_any");
    await click("days_any");
    await click("privacy_decline");
    await click("privacy_show");
    await message("Иван");
    await click("submit");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const sent = requests.filter(({ method }) => method === "sendMessage");
  const messages = sent.map(({ body }) => body.text);
  const declined = sent.find(({ body }) => body.text.includes("Понимаю."));

  assert.ok(declined);
  assert.equal(
    declined.body.reply_markup.inline_keyboard.flat().some(
      (button) => button.callback_data === "form_back",
    ),
    false,
  );
  assert.ok(
    declined.body.reply_markup.inline_keyboard.flat().some(
      (button) => button.callback_data === "privacy_agree",
    ),
  );
  assert.ok(
    declined.body.reply_markup.inline_keyboard.flat().some(
      (button) => button.callback_data === "privacy_decline",
    ),
  );
  assert.ok(
    messages.some((text) => text.includes("После этого подтвердите своё решение")),
  );
  assert.equal(messages.some((text) => text.includes("Как к вам обращаться")), false);
  assert.equal(
    messages.some((text) => text.includes("Оставьте, пожалуйста, номер телефона")),
    false,
  );
  assert.equal(messages.some((text) => text.includes("НОВАЯ ЗАЯВКА")), false);
  assert.equal(messages.some((text) => text.includes("Готово 🤍")), false);
});

test("allows consent after a previous refusal without restarting the form", async () => {
  resetStateForTest();
  const requests = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    requests.push({
      method: String(url).split("/").at(-1),
      body: JSON.parse(options.body),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };

  const user = { id: 270, username: "changed_mind", first_name: "Ольга" };
  const chat = { id: 270, type: "private" };
  let id = 1;
  const message = (text) =>
    handleUpdateForTest({
      message: { message_id: id++, chat, from: user, text },
    });
  const click = (data) =>
    handleUpdateForTest({
      callback_query: {
        id: `changed-mind-${id++}`,
        from: user,
        data,
        message: { message_id: id++, chat },
      },
    });

  try {
    await message("/start");
    await click("start_advice");
    await message("Хочу выбрать подходящую услугу");
    await click("time_any");
    await click("days_any");
    await click("privacy_decline");
    await message("/privacy");
    await click("privacy_agree");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const messages = requests
    .filter(({ method }) => method === "sendMessage")
    .map(({ body }) => body.text);
  const snapshot = getSessionSnapshotForTest(user.id);

  assert.equal(snapshot.step, "common_name");
  assert.equal(snapshot.data.privacy_consent, true);
  assert.equal(snapshot.data.telegram_user_id, user.id);
  assert.ok(messages.some((text) => text.includes("Как к вам обращаться")));
});

test("opens the public privacy policy and shows data deletion contact instructions", async () => {
  resetStateForTest();
  const requests = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    requests.push({
      method: String(url).split("/").at(-1),
      body: JSON.parse(options.body),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };

  const user = { id: 280, username: "privacy_user", first_name: "Пользователь" };
  const chat = { id: 280, type: "private" };

  try {
    await handleUpdateForTest({
      message: { message_id: 1, chat, from: user, text: "/privacy" },
    });
    await handleUpdateForTest({
      message: { message_id: 2, chat, from: user, text: "/delete_data" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const messages = requests
    .filter(({ method }) => method === "sendMessage")
    .map(({ body }) => body.text);
  const policyMessage = requests.find(
    ({ method, body }) =>
      method === "sendMessage" && body.text.includes("После этого подтвердите своё решение"),
  );

  assert.ok(policyMessage);
  assert.match(
    policyMessage.body.reply_markup.inline_keyboard[0][0].url,
    /^https:\/\/telegra\.ph\//,
  );
  assert.equal(
    messages.some((text) =>
      text.includes("ПОЛИТИКА В ОТНОШЕНИИ ОБРАБОТКИ ПЕРСОНАЛЬНЫХ ДАННЫХ"),
    ),
    false,
  );
  assert.ok(
    messages.some((text) => text.includes("отозвать согласие на обработку персональных данных")),
  );
  assert.ok(messages.some((text) => text.includes("ratzina2013@yandex.ru")));
  assert.ok(messages.some((text) => text.includes("https://t.me/ratsinaaa")));
});

test("delivers both complexes after a confirmed channel subscription", async () => {
  resetStateForTest();
  const requests = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    requests.push({ method, body });
    const result =
      method === "getChatMember" ? { status: "member" } : {};

    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result }),
    };
  };

  const user = { id: 303, username: "client", first_name: "Клиент" };
  const chat = { id: 303, type: "private" };
  let id = 1;
  const click = (data) =>
    handleUpdateForTest({
      callback_query: {
        id: `complex-${id++}`,
        from: user,
        data,
        message: { message_id: id++, chat },
      },
    });

  try {
    await handleUpdateForTest({
      message: {
        message_id: id++,
        chat,
        from: user,
        text: "/start complex_instagram_reels_22",
      },
    });
    await click("complex_1_get");
    await click("complex_2_want");
    await click("complex_2_check");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const telegramMessages = requests.filter(({ method }) => method === "sendMessage");
  const membershipCheck = requests.find(({ method }) => method === "getChatMember");

  assert.equal(membershipCheck.body.chat_id, "@anastasia_lfk_massage");
  assert.equal(membershipCheck.body.user_id, 303);
  assert.ok(telegramMessages.some(({ body }) => body.text.includes("Комплекс №1")));
  assert.ok(telegramMessages.some(({ body }) => body.text.includes("Комплекс №2")));
  assert.ok(telegramMessages.some(({ body }) => body.text.includes("Спасибо за подписку")));
});
