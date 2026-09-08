import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDirectory = dirname(fileURLToPath(import.meta.url));
loadEnvFile(join(appDirectory, ".env"));
loadEnvFile(join(appDirectory, "settings.env"));

const config = {
  token: process.env.BOT_TOKEN ?? "",
  adminChatId: process.env.ADMIN_CHAT_ID?.trim() ?? "",
  channelUsername: normalizeChannelUsername(
    process.env.CHANNEL_USERNAME ?? "@anastasia_lfk_massage",
  ),
  channelUrl:
    process.env.CHANNEL_URL ?? "https://t.me/anastasia_lfk_massage",
  privacyPolicyUrl: (process.env.PRIVACY_POLICY_URL ?? "").trim(),
  privacyPolicyVersion: (process.env.PRIVACY_POLICY_VERSION ?? "").trim() || "1.0",
  privacyConsentVersion: (process.env.PRIVACY_CONSENT_VERSION ?? "").trim() || "1.0",
  privacyPolicyDate: (process.env.PRIVACY_POLICY_DATE ?? "").trim(),
  privacyOperatorName: (process.env.PRIVACY_OPERATOR_NAME ?? "").trim(),
  privacyContactEmail: (process.env.PRIVACY_CONTACT_EMAIL ?? "").trim(),
  privacyContactTelegram: (process.env.PRIVACY_CONTACT_TELEGRAM ?? "").trim(),
  complexes: {
    1: {
      mode: (process.env.COMPLEX_1_MODE ?? "link").toLowerCase(),
      url: process.env.COMPLEX_1_URL ?? "https://example.com/complex-1",
    },
    2: {
      mode: (process.env.COMPLEX_2_MODE ?? "link").toLowerCase(),
      url: process.env.COMPLEX_2_URL ?? "https://example.com/complex-2",
    },
  },
};

const CLARIFICATION_NOTE = "Нужно дополнительное уточнение с Анастасией";

const sessions = new Map();
let offset = 0;

const MAIN_TEXT = [
  "Здравствуйте! 👋",
  "",
  "Я помощник Анастасии.",
  "",
  "Здесь вы можете:",
  "",
  "🎁 получить бесплатный комплекс упражнений;",
  "💆 оставить заявку на массаж;",
  "🤸 записаться на индивидуальное занятие ЛФК.",
  "",
  "Выберите, что вас интересует 👇",
].join("\n");

const mainMenu = inlineKeyboard([
  [{ text: "🎁 Получить комплекс упражнений", callback_data: "start_complex" }],
  [{ text: "💆 Массаж", callback_data: "start_massage" }],
  [{ text: "🤸 ЛФК", callback_data: "start_lfk" }],
  [{ text: "🤔 Не знаю, что выбрать", callback_data: "start_advice" }],
]);

if (isDirectRun()) {
  await main();
}

async function main() {
  if (!config.token) {
    console.error("BOT_TOKEN не задан. Добавьте его в файл .env.");
    process.exitCode = 1;
    return;
  }

  let retryDelay = 5000;

  while (true) {
    try {
      await callTelegram("deleteWebhook", { drop_pending_updates: false });
      await callTelegram("setMyCommands", {
        commands: [
          { command: "start", description: "Запустить бота" },
          { command: "menu", description: "Главное меню" },
          { command: "id", description: "Показать ID текущего чата" },
          { command: "privacy", description: "Политика обработки данных" },
          { command: "delete_data", description: "Отозвать согласие или удалить данные" },
          { command: "help", description: "Помощь" },
        ],
      });

      const me = await callTelegram("getMe");
      console.log(`Бот @${me.result.username} запущен. Для остановки нажмите Ctrl+C.`);
      break;
    } catch (error) {
      if (error.status === 401) {
        console.error("Telegram отклонил BOT_TOKEN. Получите новый токен в BotFather.");
        process.exitCode = 1;
        return;
      }

      console.error(
        `Telegram пока недоступен: ${error.message}. Новая попытка через ${retryDelay / 1000} сек.`,
      );
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    }
  }

  process.on("SIGINT", () => {
    console.log("\nБот остановлен.");
    process.exit(0);
  });

  while (true) {
    try {
      const updates = await callTelegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates.result ?? []) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    } catch (error) {
      console.error(`Ошибка получения сообщений: ${error.message}`);
      await sleep(3000);
    }
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  if (update.message) await handleMessage(update.message);
}

async function handleMessage(message) {
  if (!message.chat?.id || !message.from?.id) return;

  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();
  const { command, argument } = parseCommand(text);

  if (command === "/id") {
    console.log(`[chat-id] ${message.chat.type}: ${chatId}`);
    await sendMessage(
      chatId,
      [
        `ID этого чата: <code>${escapeHtml(chatId)}</code>`,
        "",
        "Скопируйте число целиком, включая минус, и укажите его как ADMIN_CHAT_ID в файле settings.env.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    return;
  }

  if (message.chat.type !== "private") return;

  const session = getSession(message.from);
  updateSessionUser(session, message.from);

  if (command === "/start") {
    await clearContactKeyboardIfNeeded(chatId, session);
    resetSession(session, argument ? sourceLabel(argument) : session.source);

    if (argument.toLowerCase().startsWith("complex")) {
      await startComplex(chatId, session);
    } else {
      await showMain(chatId, session);
    }
    return;
  }

  if (command === "/menu" || text === "🏠 Главное меню") {
    await clearContactKeyboardIfNeeded(chatId, session);
    await showMain(chatId, session);
    return;
  }

  if (command === "/privacy") {
    await sendPrivacyPolicy(chatId, session);
    return;
  }

  if (command === "/delete_data" || command === "/privacy_request") {
    await sendPrivacyRequest(chatId);
    return;
  }

  if (command === "/help") {
    await sendMessage(
      chatId,
      [
        "Выберите услугу в главном меню и отвечайте на вопросы бота.",
        "",
        "Команды:",
        "/start — начать заново",
        "/menu — открыть главное меню",
        "/id — показать ID текущего чата",
        "/privacy — открыть Политику обработки персональных данных",
        "/delete_data — запросить отзыв согласия или удаление данных",
        "",
        "Для получения комплекса также можно написать кодовое слово ДВИЖЕНИЕ.",
      ].join("\n"),
      { reply_markup: mainMenu },
    );
    return;
  }

  if (text.toUpperCase() === "ДВИЖЕНИЕ") {
    await clearContactKeyboardIfNeeded(chatId, session);
    await startComplex(chatId, session);
    return;
  }

  if (text === "← Назад" && session.kind === "form") {
    await clearContactKeyboardIfNeeded(chatId, session);
    await goBack(chatId, session);
    return;
  }

  if (session.kind === "form") {
    await handleFormInput(message, session);
    return;
  }

  await sendMessage(
    chatId,
    "Я лучше всего понимаю ответы через кнопки. Выберите нужный раздел 👇",
    { reply_markup: mainMenu },
  );
}

async function handleCallback(query) {
  const chatId = query.message?.chat?.id;
  const user = query.from;

  await answerCallback(query.id);
  if (!chatId || !user?.id) return;

  const session = getSession(user);
  updateSessionUser(session, user);
  const action = query.data ?? "";

  if (action === "home") {
    await clearContactKeyboardIfNeeded(chatId, session);
    await showMain(chatId, session);
    return;
  }

  if (action === "privacy_show") {
    await sendPrivacyPolicy(chatId, session);
    return;
  }

  if (action === "start_complex") {
    await startComplex(chatId, session);
    return;
  }

  if (action === "start_massage") {
    await startForm(chatId, session, "massage");
    return;
  }

  if (action === "start_lfk") {
    await startForm(chatId, session, "lfk");
    return;
  }

  if (action === "start_advice") {
    await startForm(chatId, session, "advice");
    return;
  }

  if (action.startsWith("complex_")) {
    await handleComplexCallback(chatId, user.id, session, action);
    return;
  }

  if (session.kind === "form") {
    await handleFormCallback(chatId, session, action);
    return;
  }

  await sendMessage(chatId, "Эта кнопка уже неактуальна. Откройте главное меню.", {
    reply_markup: mainMenu,
  });
}

async function showMain(chatId, session) {
  resetSession(session, session.source);
  await sendMessage(chatId, MAIN_TEXT, { reply_markup: mainMenu });
}

async function startComplex(chatId, session) {
  resetSession(session, session.source);
  session.kind = "complex";

  await sendMessage(
    chatId,
    [
      "Привет! 👋",
      "",
      "Вы пришли за комплексом упражнений — держите 😊",
      "",
      "Я подготовила небольшой комплекс для шеи, который можно выполнять самостоятельно дома.",
      "",
      "<b>Комплекс №1 — упражнения для шеи</b>",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([
        [{ text: "▶️ Получить комплекс", callback_data: "complex_1_get" }],
        [{ text: "🏠 Главное меню", callback_data: "home" }],
      ]),
    },
  );
}

async function handleComplexCallback(chatId, userId, session, action) {
  session.kind = "complex";

  if (action === "complex_1_get") {
    await deliverComplex(chatId, 1);
    await sendMessage(
      chatId,
      [
        "Сохраните комплекс, чтобы не потерять 🤍",
        "",
        "Во время выполнения ориентируйтесь на своё самочувствие. Упражнения не должны выполняться через выраженную боль или резкое ухудшение состояния.",
      ].join("\n"),
    );
    await askAboutSecondComplex(chatId);
    return;
  }

  if (action === "complex_2_want") {
    await showChannelOffer(chatId);
    return;
  }

  if (action === "complex_2_check") {
    try {
      if (await isChannelMember(userId)) {
        await sendMessage(chatId, "Готово 🙌\n\nСпасибо за подписку! Вот обещанный комплекс №2.");
        await deliverComplex(chatId, 2);
        await showAfterComplexMenu(chatId);
      } else {
        await showSubscriptionMissing(chatId);
      }
    } catch (error) {
      console.error(`Проверка подписки: ${error.message}`);
      await sendMessage(
        chatId,
        [
          "Не получилось проверить подписку.",
          "",
          "Убедитесь, что бот добавлен администратором канала, затем попробуйте ещё раз.",
        ].join("\n"),
        {
          reply_markup: inlineKeyboard([
            [{ text: "🔄 Проверить подписку", callback_data: "complex_2_check" }],
            [{ text: "🏠 Главное меню", callback_data: "home" }],
          ]),
        },
      );
    }
    return;
  }

  if (action === "complex_2_no") {
    await sendMessage(
      chatId,
      [
        "Хорошо 😊",
        "",
        "Первый комплекс уже у вас — сохраните его, чтобы не потерять.",
        "",
        "Если позже захотите получить другие упражнения или подобрать нагрузку индивидуально, вы всегда сможете вернуться сюда.",
      ].join("\n"),
      {
        reply_markup: inlineKeyboard([
          [{ text: "🤸 Записаться на ЛФК", callback_data: "start_lfk" }],
          [{ text: "💆 Записаться на массаж", callback_data: "start_massage" }],
          [{ text: "🏠 Главное меню", callback_data: "home" }],
        ]),
      },
    );
    return;
  }

  if (action === "complex_2_back") await askAboutSecondComplex(chatId);
}

async function askAboutSecondComplex(chatId) {
  await sendMessage(
    chatId,
    "Хотите получить ещё один комплекс для шеи с другими упражнениями? 👇",
    {
      reply_markup: inlineKeyboard([
        [{ text: "🎁 Да, хочу комплекс №2", callback_data: "complex_2_want" }],
        [{ text: "Пока достаточно", callback_data: "complex_2_no" }],
        [{ text: "🏠 Главное меню", callback_data: "home" }],
      ]),
    },
  );
}

async function showChannelOffer(chatId) {
  await sendMessage(
    chatId,
    [
      "Отлично 🙌",
      "",
      "<b>Комплекс №2 для шеи</b> я бесплатно отправляю подписчикам моего Telegram-канала.",
      "",
      "В канале я регулярно публикую упражнения, небольшие комплексы, разборы техники и рекомендации по движению и нагрузке.",
      "",
      "Подпишитесь на канал, а затем вернитесь сюда 👇",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([
        [{ text: "📲 Подписаться на канал", url: config.channelUrl }],
        [{ text: "✅ Я подписался — получить комплекс №2", callback_data: "complex_2_check" }],
        [{ text: "← Назад", callback_data: "complex_2_back" }],
        [{ text: "🏠 Главное меню", callback_data: "home" }],
      ]),
    },
  );
}

async function showSubscriptionMissing(chatId) {
  await sendMessage(
    chatId,
    [
      "Пока не вижу подписку на канал 😊",
      "",
      "Подпишитесь по кнопке ниже, а затем вернитесь сюда и нажмите «Проверить подписку» ещё раз.",
    ].join("\n"),
    {
      reply_markup: inlineKeyboard([
        [{ text: "📲 Подписаться на канал", url: config.channelUrl }],
        [{ text: "🔄 Проверить подписку", callback_data: "complex_2_check" }],
        [{ text: "← Назад", callback_data: "complex_2_back" }],
        [{ text: "🏠 Главное меню", callback_data: "home" }],
      ]),
    },
  );
}

async function showAfterComplexMenu(chatId) {
  await sendMessage(
    chatId,
    [
      "Надеюсь, комплекс будет вам полезен 🤍",
      "",
      "Если вам нужны упражнения, подобранные именно под вашу ситуацию, ограничения и уровень нагрузки, можно оставить заявку на индивидуальное занятие ЛФК.",
      "",
      "Анастасия проводит занятия очно и онлайн.",
    ].join("\n"),
    {
      reply_markup: inlineKeyboard([
        [{ text: "🤸 Хочу на ЛФК", callback_data: "start_lfk" }],
        [{ text: "💆 Хочу на массаж", callback_data: "start_massage" }],
        [{ text: "🏠 Главное меню", callback_data: "home" }],
      ]),
    },
  );
}

async function deliverComplex(chatId, number) {
  const complex = config.complexes[number];
  const title = `Комплекс №${number} — упражнения для шеи`;

  if (complex.mode === "video") {
    try {
      await callTelegram("sendVideo", {
        chat_id: chatId,
        video: complex.url,
        caption: title,
      });
      return;
    } catch (error) {
      console.error(`Отправка видео комплекса №${number}: ${error.message}`);
    }
  }

  await sendMessage(chatId, `<b>${title}</b>\n\nСейчас здесь установлена временная ссылка.`, {
    parse_mode: "HTML",
    reply_markup: inlineKeyboard([
      [{ text: `▶️ Открыть комплекс №${number}`, url: complex.url }],
    ]),
  });
}

async function isChannelMember(userId) {
  const result = await callTelegram("getChatMember", {
    chat_id: config.channelUsername,
    user_id: userId,
  });

  return isMemberStatus(result.result);
}

async function startForm(chatId, session, flow) {
  resetSession(session, session.source);
  session.kind = "form";
  session.flow = flow;
  session.step =
    flow === "massage"
      ? "massage_intro"
      : flow === "lfk"
        ? "lfk_intro"
        : "advice_request";

  await renderStep(chatId, session);
}

async function handleFormCallback(chatId, session, action) {
  if (action === "form_back") {
    await goBack(chatId, session);
    return;
  }

  if (action === "review_edit" && session.step === "review") {
    session.step = "edit_menu";
    await renderStep(chatId, session);
    return;
  }

  if (action === "edit_back" && session.step === "edit_menu") {
    session.step = "review";
    await renderStep(chatId, session);
    return;
  }

  if (action.startsWith("edit_") && session.step === "edit_menu") {
    await beginEdit(chatId, session, action.slice(5));
    return;
  }

  if (action === "submit" && session.step === "review") {
    await submitApplication(chatId, session);
    return;
  }

  const step = session.step;

  if (step === "massage_intro" && action === "continue") {
    await moveTo(chatId, session, "massage_type");
    return;
  }

  if (step === "massage_type") {
    const choices = {
      m_back_neck: "Спина и шейно-воротниковая зона",
      m_general: "Общий массаж",
      m_legs: "Массаж ног",
      m_advice: "Пока не знаю — хочу посоветоваться",
    };

    if (choices[action]) {
      session.data.massageType = choices[action];
      session.data.needsAdvice = action === "m_advice";
      await completeField(chatId, session, "massageType", "massage_concern");
      return;
    }

    if (action === "m_other") {
      await moveTo(chatId, session, "massage_type_other");
      return;
    }
  }

  if (step === "massage_concern" && action === "m_relax") {
    session.data.concern = "Ничего не беспокоит — массаж для расслабления";
    await completeField(chatId, session, "concern", "massage_health");
    return;
  }

  if (step === "massage_health") {
    if (action === "health_no") {
      session.data.health = "не указаны";
      await completeField(chatId, session, "health", "common_time");
      return;
    }

    if (action === "health_yes") {
      session.data.health = CLARIFICATION_NOTE;
      await sendMessage(
        chatId,
        "Анастасия уточнит необходимые детали лично.",
      );
      await completeField(chatId, session, "health", "common_time");
      return;
    }
  }

  if (step === "lfk_intro" && action === "continue") {
    await moveTo(chatId, session, "lfk_format");
    return;
  }

  if (step === "lfk_format") {
    const choices = {
      lfk_offline: "Очно",
      lfk_online: "Онлайн",
      lfk_format_advice: "Пока не знаю — хочу посоветоваться",
    };

    if (choices[action]) {
      session.data.format = choices[action];
      session.data.needsAdvice = action === "lfk_format_advice";
      await completeField(chatId, session, "format", "lfk_area");
      return;
    }
  }

  if (step === "lfk_area") {
    const choices = {
      area_neck: "Шея",
      area_chest: "Грудной отдел",
      area_lower_back: "Поясница",
      area_multiple: "Несколько зон",
      area_injury: "Восстановление после травмы",
      area_fitness: "Укрепление мышц / общая физическая форма",
    };

    if (choices[action]) {
      session.data.area = choices[action];
      await completeField(chatId, session, "area", "lfk_comment");
      return;
    }

    if (action === "area_other") {
      await moveTo(chatId, session, "lfk_area_other");
      return;
    }
  }

  if (step === "lfk_health") {
    if (action === "lfk_health_no") {
      session.data.lfkHealth = "не указаны";
      await completeField(chatId, session, "lfkHealth", "common_time");
      return;
    }

    if (action === "lfk_health_yes" || action === "lfk_health_unsure") {
      session.data.lfkHealth = CLARIFICATION_NOTE;
      await sendMessage(
        chatId,
        "Анастасия уточнит необходимые детали лично.",
      );
      await completeField(chatId, session, "lfkHealth", "common_time");
      return;
    }
  }

  if (step === "common_time") {
    const choices = {
      time_morning: "Утро",
      time_day: "День",
      time_evening: "Вечер",
      time_any: "Не имеет значения",
    };

    if (choices[action]) {
      session.data.time = choices[action];
      await completeField(chatId, session, "time", "common_days");
      return;
    }
  }

  if (step === "common_days") {
    const choices = {
      days_weekdays: "Будни",
      days_weekends: "Выходные",
      days_any: "Могу и в будни, и в выходные",
    };

    if (choices[action]) {
      session.data.days = choices[action];
      await completeField(chatId, session, "days", "common_privacy");
      return;
    }
  }

  if (step === "common_privacy" || step === "privacy_declined") {
    if (action === "privacy_agree") {
      session.data.privacy_consent = true;
      session.data.privacy_consent_at = new Date().toISOString();
      session.data.privacy_consent_version = config.privacyConsentVersion;
      session.data.privacy_policy_version = config.privacyPolicyVersion;
      session.data.telegram_user_id = session.user.id;
      await moveTo(chatId, session, "common_name");
      return;
    }

    if (action === "privacy_decline") {
      session.data.privacy_consent = false;
      delete session.data.privacy_consent_at;
      delete session.data.privacy_consent_version;
      delete session.data.privacy_policy_version;
      delete session.data.telegram_user_id;
      delete session.data.name;
      delete session.data.phone;
      session.history = [];
      session.editingField = null;
      session.step = "privacy_declined";
      await renderStep(chatId, session);
      return;
    }
  }

  await sendMessage(
    chatId,
    "Эта кнопка относится к предыдущему шагу. Продолжим с текущего вопроса 👇",
  );
  await renderStep(chatId, session);
}

async function handleFormInput(message, session) {
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();
  const step = session.step;

  if (
    (step === "common_name" || step === "common_phone") &&
    session.data.privacy_consent !== true
  ) {
    session.step = "common_privacy";
    await renderStep(chatId, session);
    return;
  }

  if (step === "common_phone") {
    if (message.contact?.user_id && message.contact.user_id !== message.from.id) {
      await sendMessage(
        chatId,
        "Пожалуйста, поделитесь своим контактом или введите собственный номер вручную.",
        { reply_markup: contactKeyboard() },
      );
      return;
    }

    const candidate = message.contact?.phone_number ?? text;
    const phone = normalizePhone(candidate);

    if (!phone) {
      await sendMessage(
        chatId,
        "Не получилось распознать номер. Введите от 10 до 15 цифр, например +7 999 123-45-67, или используйте кнопку передачи контакта.",
        { reply_markup: contactKeyboard() },
      );
      return;
    }

    session.data.phone = phone;
    await sendMessage(chatId, "Спасибо, номер сохранён.", {
      reply_markup: { remove_keyboard: true },
    });
    await completeField(chatId, session, "phone", "review");
    return;
  }

  if (!text) {
    await sendMessage(chatId, "Пожалуйста, отправьте ответ текстом.");
    return;
  }

  if (text.length > 700) {
    await sendMessage(chatId, "Ответ получился слишком длинным. Сократите его, пожалуйста, до 700 символов.");
    return;
  }

  if (step === "massage_type_other") {
    session.data.massageType = `Другой вариант: ${text}`;
    await completeField(chatId, session, "massageType", "massage_concern");
    return;
  }

  if (step === "massage_concern") {
    session.data.concern = text;
    await completeField(chatId, session, "concern", "massage_health");
    return;
  }

  if (step === "lfk_area_other") {
    session.data.area = `Другой запрос: ${text}`;
    await completeField(chatId, session, "area", "lfk_comment");
    return;
  }

  if (step === "lfk_comment") {
    session.data.comment = text;
    await completeField(chatId, session, "comment", "lfk_health");
    return;
  }

  if (step === "advice_request") {
    session.data.request = text;
    session.data.needsAdvice = true;
    await completeField(chatId, session, "request", "common_time");
    return;
  }

  if (step === "common_name") {
    if (text.length < 2 || text.length > 60 || /\d/.test(text)) {
      await sendMessage(chatId, "Введите, пожалуйста, имя длиной от 2 до 60 символов.");
      return;
    }

    session.data.name = text;
    await completeField(chatId, session, "name", "common_phone");
    return;
  }

  await sendMessage(
    chatId,
    "На этом шаге выберите один из вариантов с помощью кнопок под сообщением.",
  );
  await renderStep(chatId, session);
}

async function moveTo(chatId, session, nextStep) {
  if (session.step) session.history.push(session.step);
  session.step = nextStep;
  await renderStep(chatId, session);
}

async function completeField(chatId, session, field, nextStep) {
  if (session.editingField === field) {
    session.editingField = null;
    session.history = [];
    session.step = "review";
  } else {
    if (session.step) session.history.push(session.step);
    session.step = nextStep;
  }

  await renderStep(chatId, session);
}

async function goBack(chatId, session) {
  const previous = session.history.pop();

  if (!previous) {
    await showMain(chatId, session);
    return;
  }

  session.step = previous;
  if (previous === "review") session.editingField = null;
  await renderStep(chatId, session);
}

async function beginEdit(chatId, session, field) {
  const targets = {
    massageType: "massage_type",
    concern: "massage_concern",
    health: "massage_health",
    format: "lfk_format",
    area: "lfk_area",
    comment: "lfk_comment",
    lfkHealth: "lfk_health",
    request: "advice_request",
    time: "common_time",
    days: "common_days",
    name: "common_name",
    phone: "common_phone",
  };

  const target = targets[field];
  if (!target) {
    await renderStep(chatId, session);
    return;
  }

  session.editingField = field;
  session.history = ["review"];
  session.step = target;
  await renderStep(chatId, session);
}

async function renderStep(chatId, session) {
  const nav = () => [
    [
      { text: "← Назад", callback_data: "form_back" },
      { text: "🏠 Главное меню", callback_data: "home" },
    ],
  ];
  const withNav = (rows) => inlineKeyboard([...rows, ...nav()]);

  switch (session.step) {
    case "massage_intro":
      await sendMessage(
        chatId,
        [
          "Хорошо 🤍",
          "",
          "Я задам несколько коротких вопросов, чтобы Анастасия заранее понимала ваш запрос.",
          "",
          "После этого информация будет передана ей, и она лично свяжется с вами для согласования даты и времени.",
        ].join("\n"),
        { reply_markup: withNav([[{ text: "Продолжить", callback_data: "continue" }]]) },
      );
      break;

    case "massage_type":
      await sendMessage(chatId, "Какой вариант массажа вы рассматриваете?", {
        reply_markup: withNav([
          [{ text: "💆 Спина и шейно-воротниковая зона", callback_data: "m_back_neck" }],
          [{ text: "🙌 Общий массаж", callback_data: "m_general" }],
          [{ text: "🦵 Массаж ног", callback_data: "m_legs" }],
          [{ text: "Другой вариант", callback_data: "m_other" }],
          [{ text: "🤔 Пока не знаю — хочу посоветоваться", callback_data: "m_advice" }],
        ]),
      });
      break;

    case "massage_type_other":
      await sendMessage(chatId, "Напишите, какой вариант массажа вас интересует 👇", {
        reply_markup: withNav([]),
      });
      break;

    case "massage_concern":
      await sendMessage(
        chatId,
        [
          "Какой результат вы хотели бы получить от массажа?",
          "",
          "Например: расслабиться, снять обычное напряжение после нагрузок или уделить внимание выбранной зоне.",
          "",
          "Напишите коротко, без диагнозов, медицинских заключений и подробных сведений о здоровье 👇",
        ].join("\n"),
        {
          reply_markup: withNav([
            [{ text: "Хочу массаж для расслабления", callback_data: "m_relax" }],
          ]),
        },
      );
      break;

    case "massage_health":
      await sendMessage(
        chatId,
        [
          "<b>Перед записью важно уточнить ещё один момент.</b>",
          "",
          "Нужно ли Анастасии дополнительно уточнить с вами какие-либо особенности перед массажем? Подробности в боте указывать не нужно.",
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: withNav([
            [{ text: "✅ Нет", callback_data: "health_no" }],
            [{ text: "💬 Да, нужно обсудить", callback_data: "health_yes" }],
          ]),
        },
      );
      break;

    case "lfk_intro":
      await sendMessage(
        chatId,
        [
          "Хорошо 🙌",
          "",
          "Я задам несколько коротких вопросов, чтобы Анастасия заранее понимала ваш запрос и могла предложить подходящий формат занятия.",
          "",
          "После этого она лично свяжется с вами для согласования записи.",
        ].join("\n"),
        { reply_markup: withNav([[{ text: "Продолжить", callback_data: "continue" }]]) },
      );
      break;

    case "lfk_format":
      await sendMessage(chatId, "Какой формат занятия вы рассматриваете?", {
        reply_markup: withNav([
          [
            { text: "📍 Очно", callback_data: "lfk_offline" },
            { text: "💻 Онлайн", callback_data: "lfk_online" },
          ],
          [{ text: "🤔 Пока не знаю — хочу посоветоваться", callback_data: "lfk_format_advice" }],
        ]),
      });
      break;

    case "lfk_area":
      await sendMessage(chatId, "С каким запросом вы хотели бы поработать?", {
        reply_markup: withNav([
          [
            { text: "Шея", callback_data: "area_neck" },
            { text: "Грудной отдел", callback_data: "area_chest" },
          ],
          [
            { text: "Поясница", callback_data: "area_lower_back" },
            { text: "Несколько зон", callback_data: "area_multiple" },
          ],
          [{ text: "Восстановление после травмы", callback_data: "area_injury" }],
          [{ text: "Укрепление мышц / общая форма", callback_data: "area_fitness" }],
          [{ text: "Другой запрос", callback_data: "area_other" }],
        ]),
      });
      break;

    case "lfk_area_other":
      await sendMessage(
        chatId,
        "Напишите коротко цель занятия, без диагнозов, медицинских заключений и подробных сведений о здоровье 👇",
        { reply_markup: withNav([]) },
      );
      break;

    case "lfk_comment":
      await sendMessage(
        chatId,
        "Коротко опишите цель занятий, например улучшить подвижность или укрепить мышцы. Не указывайте диагнозы, медицинские заключения и подробные сведения о здоровье 👇",
        { reply_markup: withNav([]) },
      );
      break;

    case "lfk_health":
      await sendMessage(
        chatId,
        "Нужно ли Анастасии дополнительно уточнить с вами какие-либо особенности перед занятием? Подробности в боте указывать не нужно.",
        {
          reply_markup: withNav([
            [{ text: "✅ Нет", callback_data: "lfk_health_no" }],
            [{ text: "💬 Да, нужно обсудить", callback_data: "lfk_health_yes" }],
            [{ text: "🤔 Не уверен(а)", callback_data: "lfk_health_unsure" }],
          ]),
        },
      );
      break;

    case "advice_request":
      await sendMessage(
        chatId,
        "Не переживайте 😊\n\nОпишите коротко, какой результат вы хотите получить. Не указывайте диагнозы, медицинские заключения и подробные сведения о здоровье. Анастасия ознакомится с сообщением и подскажет, какой вариант лучше рассмотреть.",
        { reply_markup: withNav([]) },
      );
      break;

    case "common_time":
      {
        const question =
          session.flow === "lfk"
            ? "Когда вам обычно удобнее заниматься?"
            : session.flow === "massage"
              ? "Когда вам обычно удобнее приходить на массаж?"
              : "Когда вам обычно удобнее?";

      await sendMessage(
        chatId,
        [
          question,
          "",
          "Сейчас нужно выбрать только удобный период. Конкретную дату и точное время Анастасия предложит и согласует с вами лично после получения заявки.",
        ].join("\n"),
        {
          reply_markup: withNav([
            [
              { text: "🌅 Утро", callback_data: "time_morning" },
              { text: "☀️ День", callback_data: "time_day" },
            ],
            [
              { text: "🌙 Вечер", callback_data: "time_evening" },
              { text: "🕐 Не имеет значения", callback_data: "time_any" },
            ],
          ]),
        },
      );
      break;
      }

    case "common_days":
      await sendMessage(
        chatId,
        "Какие дни вам обычно удобнее?\n\nВыберите общий вариант — конкретную дату сейчас выбирать не нужно.",
        {
        reply_markup: withNav([
          [
            { text: "Будни", callback_data: "days_weekdays" },
            { text: "Выходные", callback_data: "days_weekends" },
          ],
          [{ text: "Могу и в будни, и в выходные", callback_data: "days_any" }],
        ]),
        },
      );
      break;

    case "common_name":
      if (session.data.privacy_consent !== true) {
        session.step = "common_privacy";
        await renderStep(chatId, session);
        break;
      }

      await sendMessage(chatId, "Спасибо. Как к вам обращаться?", {
        reply_markup: withNav([]),
      });
      break;

    case "common_phone":
      if (session.data.privacy_consent !== true) {
        session.step = "common_privacy";
        await renderStep(chatId, session);
        break;
      }

      await sendMessage(
        chatId,
        "Оставьте, пожалуйста, номер телефона для связи по поводу записи.\n\nМожно нажать кнопку передачи контакта или ввести номер вручную.",
        { reply_markup: contactKeyboard() },
      );
      break;

    case "common_privacy":
      await sendMessage(
        chatId,
        [
          "<b>Согласие на обработку персональных данных</b>",
          "",
          "Для обработки вашей заявки и связи с вами Анастасии необходимо получить ваше согласие на обработку персональных данных.",
          "",
          "Будут обработаны предоставленные вами имя, номер телефона и данные Telegram, необходимые для связи и организации записи.",
          "",
          "Данные используются для:",
          "",
          "— обработки вашей заявки;",
          "— связи с вами;",
          "— согласования записи на массаж или ЛФК.",
          "",
          "Нажимая <b>«Согласен(на)»</b>, вы подтверждаете, что ознакомились с Политикой обработки персональных данных и добровольно даёте согласие на обработку указанных данных для перечисленных целей.",
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: withNav([
            [policyButton("📄 ПОЛИТИКА ОБРАБОТКИ ПЕРСОНАЛЬНЫХ ДАННЫХ")],
            [{ text: "✅ СОГЛАСЕН(НА)", callback_data: "privacy_agree" }],
            [{ text: "❌ НЕ СОГЛАСЕН(НА)", callback_data: "privacy_decline" }],
          ]),
        },
      );
      break;

    case "privacy_declined":
      await sendMessage(
        chatId,
        [
          "<b>Понимаю.</b>",
          "",
          "Без согласия на обработку контактных данных бот не сможет передать заявку Анастасии для организации записи.",
          "",
          "Вы можете ознакомиться с Политикой обработки персональных данных или вернуться в главное меню.",
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: inlineKeyboard([
            [policyButton("📄 ОЗНАКОМИТЬСЯ С ПОЛИТИКОЙ")],
            [{ text: "✅ СОГЛАСЕН(НА)", callback_data: "privacy_agree" }],
            [{ text: "❌ НЕ СОГЛАСЕН(НА)", callback_data: "privacy_decline" }],
            [{ text: "🏠 ГЛАВНОЕ МЕНЮ", callback_data: "home" }],
          ]),
        },
      );
      break;

    case "review":
      await sendMessage(chatId, buildReview(session), {
        parse_mode: "HTML",
        reply_markup: inlineKeyboard([
          [{ text: "✅ Всё верно — отправить", callback_data: "submit" }],
          [{ text: "✏️ Изменить", callback_data: "review_edit" }],
          [{ text: "🏠 Главное меню", callback_data: "home" }],
        ]),
      });
      break;

    case "edit_menu":
      await sendMessage(chatId, "Какое поле вы хотите изменить?", {
        reply_markup: editKeyboard(session.flow),
      });
      break;

    default:
      await showMain(chatId, session);
  }
}

function editKeyboard(flow) {
  const serviceRows =
    flow === "massage"
      ? [
          [{ text: "Вариант массажа", callback_data: "edit_massageType" }],
          [{ text: "Что беспокоит", callback_data: "edit_concern" }],
          [{ text: "Дополнительное уточнение", callback_data: "edit_health" }],
        ]
      : flow === "lfk"
        ? [
            [{ text: "Формат", callback_data: "edit_format" }],
            [{ text: "Запрос", callback_data: "edit_area" }],
            [{ text: "Комментарий", callback_data: "edit_comment" }],
            [{ text: "Дополнительное уточнение", callback_data: "edit_lfkHealth" }],
          ]
        : [[{ text: "Описание запроса", callback_data: "edit_request" }]];

  return inlineKeyboard([
    ...serviceRows,
    [
      { text: "Удобное время", callback_data: "edit_time" },
      { text: "Дни", callback_data: "edit_days" },
    ],
    [
      { text: "Имя", callback_data: "edit_name" },
      { text: "Телефон", callback_data: "edit_phone" },
    ],
    [{ text: "← Назад к заявке", callback_data: "edit_back" }],
    [{ text: "🏠 Главное меню", callback_data: "home" }],
  ]);
}

function buildReview(session) {
  const d = session.data;
  const lines = [
    "<b>Проверьте, пожалуйста, всё ли верно 👇</b>",
    "",
    `<b>Имя:</b> ${safeValue(d.name)}`,
    `<b>Услуга:</b> ${safeValue(serviceName(session.flow))}`,
  ];

  if (session.flow === "massage") {
    lines.push(
      `<b>Вариант:</b> ${safeValue(d.massageType)}`,
      `<b>Запрос:</b> ${safeValue(d.concern)}`,
      `<b>Требуется дополнительное уточнение с Анастасией:</b> ${clarificationValue(session)}`,
    );
  } else if (session.flow === "lfk") {
    lines.push(
      `<b>Формат:</b> ${safeValue(d.format)}`,
      `<b>Запрос:</b> ${safeValue(d.area)}`,
      `<b>Комментарий:</b> ${safeValue(d.comment)}`,
      `<b>Требуется дополнительное уточнение с Анастасией:</b> ${clarificationValue(session)}`,
    );
  } else {
    lines.push(
      "<b>Требуется помощь с выбором услуги:</b> да",
      `<b>Запрос:</b> ${safeValue(d.request)}`,
    );
  }

  lines.push(
    `<b>Удобное время:</b> ${safeValue(d.time)}`,
    `<b>Дни:</b> ${safeValue(d.days)}`,
    `<b>Телефон:</b> ${safeValue(d.phone)}`,
    "",
    "Точную дату и время Анастасия согласует с вами лично после получения заявки.",
  );

  return lines.join("\n");
}

function buildAdminCard(session) {
  const d = session.data;
  const user = session.user;
  const telegram = user.username
    ? `@${escapeHtml(user.username)}`
    : `ID ${escapeHtml(user.id)}`;
  const title =
    session.flow === "massage"
      ? "🔔 <b>НОВАЯ ЗАЯВКА НА МАССАЖ</b>"
      : session.flow === "lfk"
        ? "🔔 <b>НОВАЯ ЗАЯВКА НА ЛФК</b>"
        : "🔔 <b>НУЖНА ПОМОЩЬ С ВЫБОРОМ УСЛУГИ</b>";
  const lines = [
    title,
    "",
    `<b>Имя:</b> ${safeValue(d.name)}`,
    `<b>Telegram:</b> ${telegram}`,
    `<b>Telegram user ID:</b> ${safeValue(d.telegram_user_id)}`,
    `<b>Телефон:</b> ${safeValue(d.phone)}`,
  ];

  if (d.needsAdvice) {
    lines.push("<b>Требуется консультация по выбору:</b> да");
  }

  if (session.flow === "massage") {
    lines.push(
      "",
      `<b>Массаж:</b> ${safeValue(d.massageType)}`,
      `<b>Что беспокоит:</b>\n${safeValue(d.concern)}`,
      `<b>Требуется дополнительное уточнение с Анастасией:</b> ${clarificationValue(session)}`,
    );
  } else if (session.flow === "lfk") {
    lines.push(
      "",
      `<b>Формат:</b> ${safeValue(d.format)}`,
      `<b>Запрос:</b> ${safeValue(d.area)}`,
      `<b>Комментарий:</b>\n${safeValue(d.comment)}`,
      `<b>Требуется дополнительное уточнение с Анастасией:</b> ${clarificationValue(session)}`,
    );
  } else {
    lines.push("", `<b>Запрос:</b>\n${safeValue(d.request)}`);
  }

  lines.push(
    "",
    `<b>Удобное время:</b> ${safeValue(d.time)}`,
    `<b>Дни:</b> ${safeValue(d.days)}`,
    "<b>Согласие на обработку ПД:</b> ✅",
    `<b>Получено:</b> ${safeValue(formatConsentDate(d.privacy_consent_at))}`,
    `<b>Версия согласия:</b> ${safeValue(d.privacy_consent_version)}`,
    `<b>Версия Политики:</b> ${safeValue(d.privacy_policy_version)}`,
    `<b>Источник:</b> ${safeValue(session.source)}`,
  );

  return lines.join("\n");
}

async function submitApplication(chatId, session) {
  if (session.data.privacy_consent !== true) {
    await sendMessage(
      chatId,
      "Для отправки заявки необходимо согласие на обработку персональных данных.",
    );
    session.step = "common_privacy";
    await renderStep(chatId, session);
    return;
  }

  if (!/^-?\d+$/.test(config.adminChatId)) {
    await sendMessage(
      chatId,
      [
        "Заявка полностью сформирована, но группа для заявок пока не подключена.",
        "",
        "Добавьте бота в группу, отправьте там команду /id и укажите полученное число в ADMIN_CHAT_ID файла settings.env. После перезапуска эту заявку можно будет отправить повторно.",
      ].join("\n"),
    );
    return;
  }

  const contactUrl = session.user.username
    ? `https://t.me/${session.user.username}`
    : `tg://user?id=${session.user.id}`;

  try {
    await sendMessage(config.adminChatId, buildAdminCard(session), {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([
        [{ text: "💬 Написать клиенту", url: contactUrl }],
      ]),
    });
  } catch (error) {
    console.error(`Отправка заявки: ${error.message}`);
    await sendMessage(
      chatId,
      "Не удалось передать заявку в группу. Попробуйте ещё раз чуть позже или вернитесь в главное меню.",
    );
    return;
  }

  await sendMessage(
    chatId,
    [
      "<b>Готово 🤍</b>",
      "",
      "Вся информация передана Анастасии.",
      "",
      "Сейчас она может проводить сеанс массажа или вести занятие, поэтому не всегда может ответить сразу.",
      "",
      "Как только освободится, Анастасия лично напишет вам и предложит доступные варианты даты и времени.",
      "",
      "Заявки обрабатываются по порядку поступления. Пожалуйста, ожидайте сообщения 🌿",
    ].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard([
        [{ text: "🏠 Главное меню", callback_data: "home" }],
      ]),
    },
  );

  resetSession(session, session.source);
}

function getSession(user) {
  let session = sessions.get(user.id);

  if (!session) {
    session = createSession(user);
    sessions.set(user.id, session);
  }

  return session;
}

function createSession(user) {
  return {
    kind: "idle",
    flow: null,
    step: null,
    history: [],
    editingField: null,
    data: {},
    source: "Telegram / прямой запуск",
    user: {
      id: user.id,
      username: user.username ?? "",
      firstName: user.first_name ?? "",
    },
  };
}

function resetSession(session, source) {
  session.kind = "idle";
  session.flow = null;
  session.step = null;
  session.history = [];
  session.editingField = null;
  session.data = {};
  session.source = source || "Telegram / прямой запуск";
}

function updateSessionUser(session, user) {
  session.user = {
    id: user.id,
    username: user.username ?? "",
    firstName: user.first_name ?? "",
  };
}

function contactKeyboard() {
  return {
    keyboard: [
      [{ text: "📱 Поделиться номером телефона", request_contact: true }],
      [{ text: "← Назад" }, { text: "🏠 Главное меню" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

async function clearContactKeyboardIfNeeded(chatId, session) {
  if (session.step !== "common_phone") return;

  await sendMessage(chatId, "Закрываю ввод телефона.", {
    reply_markup: { remove_keyboard: true },
  });
}

function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

async function sendPrivacyPolicy(chatId, session = null) {
  if (!/^https?:\/\//i.test(config.privacyPolicyUrl)) {
    await sendMessage(
      chatId,
      "Политика обработки персональных данных пока не опубликована.",
    );
    return;
  }

  const rows = [[{ text: "📄 ОТКРЫТЬ ПОЛИТИКУ", url: config.privacyPolicyUrl }]];

  if (
    session?.kind === "form" &&
    (session.step === "common_privacy" || session.step === "privacy_declined")
  ) {
    rows.push(
      [{ text: "✅ СОГЛАСЕН(НА)", callback_data: "privacy_agree" }],
      [{ text: "❌ НЕ СОГЛАСЕН(НА)", callback_data: "privacy_decline" }],
    );
  }

  await sendMessage(
    chatId,
    "Ознакомьтесь с Политикой обработки персональных данных. После этого подтвердите своё решение кнопкой ниже.",
    { reply_markup: inlineKeyboard(rows) },
  );
}

async function sendPrivacyRequest(chatId) {
  const contacts = [config.privacyContactEmail, config.privacyContactTelegram].filter(Boolean);
  const contactText = contacts.length
    ? contacts.join("\n")
    : "Контакт Анастасии пока не указан в настройках бота.";

  await sendMessage(
    chatId,
    [
      "Если вы хотите отозвать согласие на обработку персональных данных или запросить удаление ранее предоставленных данных, свяжитесь с Анастасией:",
      "",
      contactText,
    ].join("\n"),
    {
      reply_markup: inlineKeyboard([
        [policyButton("📄 Политика обработки персональных данных")],
        [{ text: "🏠 Главное меню", callback_data: "home" }],
      ]),
    },
  );
}

function policyButton(text) {
  if (/^https?:\/\//i.test(config.privacyPolicyUrl)) {
    return { text, url: config.privacyPolicyUrl };
  }

  return { text, callback_data: "privacy_show" };
}

async function sendMessage(chatId, text, extra = {}) {
  return callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra,
  });
}

async function answerCallback(callbackQueryId) {
  try {
    await callTelegram("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
    });
  } catch (error) {
    console.error(`Ответ на нажатие кнопки: ${error.message}`);
  }
}

async function callTelegram(method, payload) {
  const response = await fetch(
    `https://api.telegram.org/bot${config.token}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.description ?? `${method}: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return data;
}

function parseCommand(text) {
  if (!text.startsWith("/")) return { command: "", argument: "" };

  const [rawCommand, ...rest] = text.split(/\s+/);
  return {
    command: rawCommand.replace(/@[^\s]+$/, "").toLowerCase(),
    argument: rest.join(" ").trim(),
  };
}

function serviceName(flow) {
  if (flow === "massage") return "Массаж";
  if (flow === "lfk") return "ЛФК";
  return "Нужна помощь с выбором услуги";
}

function safeValue(value) {
  return escapeHtml(value || "—");
}

function clarificationValue(session) {
  const value = session.flow === "massage" ? session.data.health : session.data.lfkHealth;
  return value === CLARIFICATION_NOTE ? "да" : "нет";
}

function formatConsentDate(value) {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleString("ru-RU", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

function normalizeChannelUsername(value) {
  const clean = value.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  return `@${clean}`;
}

function sourceLabel(payload) {
  const clean = payload
    .trim()
    .slice(0, 64)
    .replace(/^complex[_-]?/i, "")
    .replace(/[_-]+/g, " ")
    .trim();

  return clean ? clean : "Telegram / ссылка на комплекс";
}

function normalizePhone(input) {
  if (typeof input !== "string" || /[A-Za-zА-Яа-яЁё]/.test(input)) return null;

  let digits = input.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("9")) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length < 10 || digits.length > 15) return null;

  return `+${digits}`;
}

function isMemberStatus(member) {
  return (
    ["creator", "administrator", "member"].includes(member?.status) ||
    (member?.status === "restricted" && member?.is_member === true)
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
    // .env необязателен, если переменные уже заданы в системе.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDirectRun() {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
}

function resetStateForTest() {
  sessions.clear();
  offset = 0;
}

function getSessionSnapshotForTest(userId) {
  const session = sessions.get(userId);
  return session ? structuredClone(session) : null;
}

export {
  escapeHtml,
  getSessionSnapshotForTest,
  handleUpdate as handleUpdateForTest,
  isMemberStatus,
  normalizePhone,
  resetStateForTest,
  sourceLabel,
};
