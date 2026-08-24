FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock* bunfig.toml* tsconfig.base.json ./
COPY packages/schemas/package.json packages/schemas/
COPY packages/k8s-client/package.json packages/k8s-client/
COPY packages/api/package.json packages/api/
RUN bun install --frozen-lockfile

COPY packages/schemas packages/schemas
COPY packages/k8s-client packages/k8s-client
COPY packages/api packages/api

WORKDIR /app/packages/api
USER bun
EXPOSE 3000
ENTRYPOINT ["bun", "run", "src/index.ts"]
