# Production image: builds the web app and runs the API + jobs on Node 22.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY packages packages
RUN npm run build -w @gridiron/web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build /app /app
RUN npm prune --omit=dev --workspaces --include-workspace-root || true
EXPOSE 8787
USER node
CMD ["node", "--import", "tsx", "packages/server/src/main.ts"]
