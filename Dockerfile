FROM oven/bun:1.4-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN bun run build
ENV NODE_ENV=production
EXPOSE 10000
CMD ["bun", "src/server.ts"]
