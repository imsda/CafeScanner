FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
# package-lock.json only records some of Rollup's native binaries (npm optional-deps bug),
# so install the musl build matching this image's architecture and Rollup version.
RUN npm ci \
  && npm install --no-save "@rollup/rollup-linux-$(node -p process.arch)-musl@$(node -p "require('rollup/package.json').version")"
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# The Prisma CLI and tsx (dev dependencies) are needed at startup for migrations and seeding.
COPY --from=builder --chown=node:node /app /app
RUN mkdir -p backend/data backend/backups && chown -R node:node backend/data backend/backups
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4000}/api/health" > /dev/null || exit 1
CMD ["sh", "-c", "npm run db:migrate && npm run db:seed && npm run start"]
