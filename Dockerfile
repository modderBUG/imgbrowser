# 使用 Node.js LTS 版本作为基础镜像
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 安装 Python 和 Make 用于编译 sqlite3
RUN apk add --no-cache python3 make g++

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装所有依赖
RUN npm ci

# 复制 TypeScript 配置文件
COPY tsconfig.json ./

# 复制源代码
COPY src ./src
COPY public ./public

# 编译 TypeScript 代码
RUN npm run build

# 清理开发依赖以减小镜像大小
RUN npm prune --production && rm -rf node_modules/@types

# 创建必要的目录
RUN mkdir -p /app/images /app/remove

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV PORT=3000
ENV IMAGES_DIR=/app/images
ENV NODE_ENV=production

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/auth/status || exit 1

# 启动命令
CMD ["npm", "run", "serve"]
