# Instagram Direct webhook

Интеграция принимает события Instagram Direct и отвечает только на кодовое слово `ДВИЖЕНИЕ`. В ответе пользователь получает deep link, который открывает ветку комплексов Telegram-бота.

## Переменные окружения

Заполните в `.env` или в настройках хостинга:

```env
INSTAGRAM_ACCESS_TOKEN=
INSTAGRAM_APP_SECRET=
META_VERIFY_TOKEN=
INSTAGRAM_ACCOUNT_ID=
META_GRAPH_VERSION=v24.0
TELEGRAM_BOT_USERNAME=anastasia_lfk_massage_bot
PORT=3001
```

- `INSTAGRAM_ACCESS_TOKEN` — токен Instagram-профессионального аккаунта с правом управления сообщениями.
- `INSTAGRAM_APP_SECRET` — App Secret приложения из Meta for Developers.
- `META_VERIFY_TOKEN` — придуманная вами строка, одинаковая в `.env` и настройках webhook Meta.
- `INSTAGRAM_ACCOUNT_ID` — числовой Instagram User ID профессионального аккаунта.
- `META_GRAPH_VERSION` — версия Graph API; по умолчанию `v24.0`.
- `TELEGRAM_BOT_USERNAME` — username Telegram-бота без символа `@`.
- `PORT` — локальный порт сервера; хостинг обычно устанавливает его автоматически.

Секреты не передаются в URL и не выводятся в журналы.

## Запуск

На этом компьютере:

```powershell
.\start-instagram-webhook.cmd
```

На сервере или хостинге:

```bash
npm start
```

Пошаговая настройка Render находится в [`render-deploy.md`](render-deploy.md). Готовый `render.yaml` создаёт Node.js Web Service с проверкой `/health`.

Сервис слушает `0.0.0.0:$PORT` и предоставляет:

- `GET /health` — проверка работоспособности;
- `GET /webhook` — подтверждение webhook Meta;
- `POST /webhook` — события Instagram Direct.

Чтобы безопасно получить ID подключённого профессионального аккаунта из токена в `.env`, выполните:

```powershell
npm run instagram:account-id
```

Для локальной проверки запустите сервер, затем во втором окне выполните:

```powershell
.\test-instagram-webhook.cmd
```

Тест отправляет корректно подписанный запрос, но не использует кодовое слово и поэтому не вызывает реальную отправку сообщения через Meta.

## Настройка Meta

1. Используйте Instagram API with Instagram Login и профессиональный Instagram-аккаунт типа Business или Creator.
2. Получите токен с разрешениями, необходимыми для чтения и отправки сообщений Instagram.
3. Разверните сервис на сервере с постоянным публичным HTTPS-адресом.
4. В настройках webhook укажите URL `https://ВАШ-ДОМЕН/webhook`.
5. В поле подтверждения маркера вставьте значение `META_VERIFY_TOKEN` из окружения сервера.
6. Подпишитесь как минимум на поле `messages`.
7. В режиме разработки проверяйте сообщения от аккаунтов, добавленных в роли приложения; перед использованием с обычными пользователями завершите необходимые проверки приложения Meta.

Формат события и endpoint отправки соответствуют официальной коллекции [Meta Instagram API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api). Общая схема подтверждения webhook описана в [Meta Webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started).

## Проверка в Instagram

1. Напишите профессиональному аккаунту с другого разрешённого тестового аккаунта сообщение `ДВИЖЕНИЕ`.
2. Webhook должен вернуть Meta `HTTP 200` и `EVENT_RECEIVED`.
3. В Direct должен появиться автоматический ответ со ссылкой на Telegram-бота.
4. Ссылка должна открыть ветку комплекса №1, после которой бот предложит комплекс №2.

В журнале успешный сценарий выглядит так:

```text
[instagram-webhook] webhook received object=instagram entries=1 messages=1
[instagram-webhook] incoming message id=***1234 sender=***5678 text_length=8 keyword_match=true
[instagram-webhook] automatic reply sent recipient=***5678 source_message=***1234
```

Для исходящего echo-события будет запись `message ignored reason=own_message`; повторный ответ не отправляется.
