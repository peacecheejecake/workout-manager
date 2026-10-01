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
RUN groupadd --gid 20001 workout \
 && useradd --uid 20001 --gid workout --create-home --home-dir /home/workout \
      --shell /usr/sbin/nologin --no-log-init workout
ENV NODE_ENV=production \
    API_ORIGIN=http://127.0.0.1:4300 \
    PORT=4300 \
    HOME=/home/workout
COPY --from=build /app /app
RUN mkdir -p /app/apps/web/.next/cache \
 && chown -R workout:workout /app/apps/web/.next/cache
USER workout:workout
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "/app/deploy/healthcheck.mjs"]
CMD ["node", "/app/deploy/entrypoint.mjs"]
