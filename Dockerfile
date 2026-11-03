# Production image for the Samsara → Telegram poller. Built and run by Coolify
# on the Hostinger VPS, next to the hub; see docs/deployment/coolify.md.
# (render.yaml still describes the Render service, kept for a rollback.)
FROM node:20-bookworm-slim

# Nothing from apt. Node is PID 1 and handles SIGTERM itself (index.js stops the
# pollers and Telegram cleanly on a redeploy); its only children are the
# ffmpeg runs it waits for. The health check uses Node's own fetch, and Node
# and npm carry their own CA certificates.

WORKDIR /app

# Dependencies before source, so a code-only change reuses this layer. ffmpeg
# for the driver-group music overlay arrives here, as the
# @ffmpeg-installer/ffmpeg + @ffprobe-installer/ffprobe binaries.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The same heap cap it has always run with. Set NODE_OPTIONS in the platform's
# environment to change it. IPv4-first is in the code (src/telegramNetwork.js),
# not here, so an environment that sets NODE_OPTIONS cannot undo it.
ENV PORT=3000 \
    NODE_OPTIONS=--max-old-space-size=400 \
    MALLOC_ARENA_MAX=2

EXPOSE 3000

# /health answers 200 while polling is fresh, 503 when it has gone stale, and
# always 200 in standby (src/standby.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "index.js"]
