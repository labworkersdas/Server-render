FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=10000 \
    OUTPUT_DIR=/app/hls \
    AUTO_START=true

RUN mkdir -p /app/hls && chown -R node:node /app
USER node

EXPOSE 10000

CMD ["node", "server.js"]
