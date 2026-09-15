FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @open-mailtrack/server
COPY tsconfig.base.json ./
COPY packages/server packages/server
RUN pnpm --filter @open-mailtrack/server build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --prod --filter @open-mailtrack/server
COPY --from=build /app/packages/server/dist packages/server/dist
ENV PORT=8787 DB_PATH=/data/open-mailtrack.db
VOLUME /data
EXPOSE 8787
CMD ["node", "--no-warnings=ExperimentalWarning", "packages/server/dist/index.js"]
