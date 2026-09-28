FROM node:24.12.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @workout/contracts build \
 && pnpm --filter @workout/api build
ENV API_ORIGIN=http://127.0.0.1:4300
RUN pnpm --filter @workout/web build

FROM node:24.12.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    API_ORIGIN=http://127.0.0.1:4300 \
    PORT=4300
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "/app/deploy/healthcheck.mjs"]
CMD ["node", "/app/deploy/entrypoint.mjs"]
