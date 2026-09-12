FROM node:22-alpine

WORKDIR /app
COPY package.json bot.mjs settings.env ./

ENV NODE_ENV=production

CMD ["node", "bot.mjs"]
