FROM node:20-alpine

# tzdata lets TZ from .env set local time for calendar day boundaries
RUN apk add --no-cache tzdata

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

EXPOSE 4040

CMD ["node", "server/index.js"]
