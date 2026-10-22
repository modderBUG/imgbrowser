# ---------- 构建阶段：编译 TypeScript ----------
FROM node:22-alpine AS builder

WORKDIR /app

# sqlite3 在没有预编译包的平台上需要从源码构建
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


# ---------- 运行阶段：只保留运行所需文件 ----------
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    IMAGES_DIR=/app/images \
    TRASH_DIR=/app/remove \
    DB_PATH=/app/data/imgbrowser.db

# tini 负责回收僵尸进程并正确转发信号，让容器的优雅关闭生效
RUN apk add --no-cache tini \
    && addgroup -S -g 1000 app \
    && adduser -S -u 1000 -G app app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY public ./public

RUN mkdir -p /app/images /app/remove /app/data \
    && chown -R app:app /app

USER app

EXPOSE 3000

# 使用无需登录的健康检查接口
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
