# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app

# install all deps (incl. dev) for the TypeScript build
COPY package.json package-lock.json* ./
RUN npm install

# compile TS -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# drop dev deps for a lean runtime node_modules
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7070

# non-root user
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER app
EXPOSE 7070

# default: HTTP image-search API. (MCP server is local/stdio — run separately.)
CMD ["node", "dist/server.js"]
