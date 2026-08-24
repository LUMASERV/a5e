FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* bunfig.toml* tsconfig.base.json ./
COPY packages/schemas/package.json packages/schemas/
COPY packages/ui/package.json packages/ui/
RUN bun install --frozen-lockfile
COPY packages/schemas packages/schemas
COPY packages/ui packages/ui
WORKDIR /app/packages/ui
RUN bun run build

FROM nginx:1.27-alpine
COPY --from=build /app/packages/ui/dist /usr/share/nginx/html
COPY packages/ui/nginx.conf /etc/nginx/conf.d/default.conf
# Regenerates runtime-config.js from API_ORIGIN at container start — see the script's own comment.
# /docker-entrypoint.d/*.sh is the stock nginx image's own convention; no custom ENTRYPOINT needed.
COPY --chmod=755 packages/ui/docker-entrypoint.d/20-generate-runtime-config.sh /docker-entrypoint.d/
EXPOSE 80
