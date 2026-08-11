# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS base
RUN npm install -g pnpm@11.8.0
WORKDIR /app

# --- deps ---
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# --- build ---
FROM deps AS build
COPY . .
ENV NODE_ENV=production
RUN pnpm --filter @run-far/web build

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages/shared packages/shared
COPY tsconfig.base.json ./
COPY --from=build /app/apps/web/dist apps/web/dist

RUN mkdir -p apps/api/uploads/ai-drafts

EXPOSE 8080
ENV PORT=8080

CMD ["pnpm", "--filter", "@run-far/api", "start:prod"]
