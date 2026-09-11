# Развёртывание Instagram webhook на Render

Telegram-бот и Instagram webhook остаются независимыми. На Render запускается только `instagram-webhook.mjs`.

## Вариант с render.yaml

1. Откройте Render Dashboard и нажмите **New > Blueprint**.
2. Подключите GitHub-репозиторий `ratsina/anastasia-telegram-bot`.
3. Render найдёт `render.yaml`. Нажмите **Apply**.
4. Введите четыре секретных значения, которые Render запросит при создании сервиса.
5. После развёртывания откройте сервис и убедитесь, что статус стал **Live**.

`META_GRAPH_VERSION=v24.0` уже задан в Blueprint. Секреты в репозиторий не попадают.

## Ручное создание Web Service

В Render Dashboard нажмите **New > Web Service**, подключите репозиторий и заполните поля:

| Поле Render | Значение |
| --- | --- |
| Name | `anastasia-instagram-webhook` |
| Language / Runtime | `Node` |
| Branch | `main` |
| Root Directory | оставить пустым (корень репозитория) |
| Build Command | `npm install --ignore-scripts` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

`PORT` добавлять не нужно: Render создаёт эту переменную сам, а сервер слушает `0.0.0.0:$PORT`.

## Environment Variables

Добавьте в разделе **Environment**:

```text
INSTAGRAM_ACCESS_TOKEN=<токен Instagram>
INSTAGRAM_APP_SECRET=<App Secret приложения Meta>
INSTAGRAM_ACCOUNT_ID=<числовой ID профессионального Instagram-аккаунта>
META_VERIFY_TOKEN=<ваша секретная строка для проверки webhook>
META_GRAPH_VERSION=v24.0
```

Значение `META_VERIFY_TOKEN` должно быть одинаковым на Render и в поле **Подтверждение маркера** в Meta.

## Получение INSTAGRAM_ACCOUNT_ID

Заполните только `INSTAGRAM_ACCESS_TOKEN` в локальном `.env`, затем из корня проекта выполните:

```powershell
npm run instagram:account-id
```

Успешный результат содержит только username и ID:

```text
username: @example
Instagram account/user ID: 17841400000000000
```

Команда поддерживает токены, полученные через Instagram Login, и токены связанной Facebook Page. Токен и App Secret не выводятся и не передаются в URL.

## Настройка Meta

После успешного deploy скопируйте адрес сервиса из Render. Если Render выдал адрес
`https://anastasia-instagram-webhook.onrender.com`, заполните в Meta:

```text
URL обратного вызова: https://anastasia-instagram-webhook.onrender.com/webhook
Подтверждение маркера: значение META_VERIFY_TOKEN из Render
```

Подпишитесь на поле `messages`. Проверка доступности сервиса:

```text
https://anastasia-instagram-webhook.onrender.com/health
```

По этому адресу должен открыться JSON с `"ok": true`.

## Проверка

1. В Meta сохраните URL обратного вызова и маркер: проверка `GET /webhook` должна завершиться успешно.
2. Напишите профессиональному Instagram-аккаунту с другого разрешённого аккаунта слово `ДВИЖЕНИЕ`.
3. В Direct должен прийти автоматический ответ с текущей ссылкой-заглушкой.
4. В Render откройте сервис и вкладку **Logs**.

После подключения и тестового сообщения в логах появятся строки такого вида:

```text
[instagram-webhook] server started host=0.0.0.0 port=10000 path=/webhook
[instagram-webhook] verification successful
[instagram-webhook] webhook received object=instagram entries=1 messages=1
[instagram-webhook] incoming message id=***1234 sender=***5678 text_length=8 keyword_match=true
[instagram-webhook] automatic reply sent recipient=***5678 source_message=***1234
```

Render может выдать другой домен, если выбранное имя уже занято. В таком случае используйте фактический адрес из верхней части страницы сервиса и добавьте `/webhook`.
