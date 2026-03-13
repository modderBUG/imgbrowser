# 使用 Node.js LTS 版本作为基础镜像
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装所有依赖（包括开发依赖，因为需要 TypeScript 编译）
RUN npm ci

# 复制 TypeScript 配置文件
COPY tsconfig.json ./

# 复制源代码
COPY src ./src
COPY public ./public

# 编译 TypeScript 代码
RUN npm run build

# 创建必要的目录
RUN mkdir -p /app/images /app/remove

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV PORT=3000
ENV IMAGES_DIR=/app/images
ENV NODE_ENV=production

# 启动命令
CMD ["npm", "run", "serve"]