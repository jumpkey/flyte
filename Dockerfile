FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install supercronic for cron job scheduling.
# Verify the download against the SHA1 checksum published by the upstream
# release (aptible/supercronic only publishes SHA1, not SHA256). This guards
# against tampered or partial downloads. Update both the URL version and the
# SHA1 below in lockstep when bumping supercronic.
ENV SUPERCRONIC_VERSION=v0.2.29
ENV SUPERCRONIC_SHA1=cd48d45c4b10f3f0bfdd3a57d054cd05ac96812b
RUN apk add --no-cache curl && \
    SUPERCRONIC_URL="https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" && \
    curl -fsSL "$SUPERCRONIC_URL" -o /usr/local/bin/supercronic && \
    echo "${SUPERCRONIC_SHA1}  /usr/local/bin/supercronic" | sha1sum -c - && \
    chmod +x /usr/local/bin/supercronic

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/web/views ./dist/web/views
COPY --from=builder /app/db ./db
COPY public ./public
COPY crontab ./crontab
EXPOSE 3000
CMD ["node", "dist/index.js"]
