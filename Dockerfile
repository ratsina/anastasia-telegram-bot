FROM node:22-alpine

WORKDIR /app
COPY package.json instagram-webhook.mjs ./

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

CMD ["node", "instagram-webhook.mjs"]
