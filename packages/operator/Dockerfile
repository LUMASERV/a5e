FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock* bunfig.toml* ./
COPY packages/schemas/package.json packages/schemas/
COPY packages/k8s-client/package.json packages/k8s-client/
COPY packages/operator/package.json packages/operator/
RUN bun install --frozen-lockfile

COPY packages/schemas packages/schemas
COPY packages/k8s-client packages/k8s-client
COPY packages/operator packages/operator

WORKDIR /app/packages/operator
USER bun
ENTRYPOINT ["bun", "run", "src/main.ts"]
