# ImgBrowser 图片浏览器

一个基于 Node.js + Express 的图片浏览应用，提供优雅的瀑布流布局、无限滚动加载和完整的图片管理功能。

## 功能特性

- **瀑布流布局**：自适应图片展示，支持网格、列表视图切换
- **无限滚动**：滚动到底部自动加载更多图片
- **排序与筛选**：支持按文件名、创建时间（最新/最旧）排序
- **响应式设计**：适配桌面与移动端
- **图片收藏**：支持收藏喜欢的图片，可单独查看收藏夹
- **回收站功能**：删除的图片移动到回收站，支持恢复和永久删除
- **大图查看**：点击图片打开全屏模态框，支持上一张/下一张导航
- **图片操作**：双击放大、拖拽查看、键盘快捷键支持
- **API 支持**：提供完整的 RESTful API 进行图片管理
- **数据持久化**：使用 SQLite 数据库存储图片元数据和状态

## 技术栈

- **后端**：Node.js + Express + TypeScript + SQLite
- **前端**：原生 HTML/CSS/JavaScript
- **数据库**：SQLite（轻量级嵌入式数据库）
- **构建工具**：TypeScript Compiler
- **开发工具**：Nodemon（热重载）

## 快速开始

### 前提条件

- Node.js（建议 v18+）
- npm 或 yarn

### 安装

1. 克隆仓库：

   ```bash
   git clone <仓库地址>
   cd imgbrowser
   ```

2. 安装依赖：

   ```bash
   npm install
   ```

3. 准备图片目录：
   - 在项目根目录下创建 `images/` 文件夹（如果不存在）
   - 将需要展示的图片（支持 .jpg、.png、.gif、.bmp、.webp）放入该目录

### 启动开发服务器

使用以下命令启动开发服务器（支持热重载）：

```bash
npm run dev
```

服务器将在 `http://localhost:3000` 启动。首次启动时会自动扫描图片目录并初始化数据库。

### 构建与生产运行

1. 编译 TypeScript 代码：

   ```bash
   npm run build
   ```

2. 启动生产服务器：

   ```bash
   npm run serve
   ```

   或者直接使用 `npm start`（使用 ts-node 运行，无需编译）。

## 部署指南

### 传统服务器部署（Linux/Windows）

1. 将项目文件上传到服务器。
2. 安装 Node.js 环境。
3. 在项目目录执行 `npm install --production` 安装生产依赖。
4. 使用 PM2 等进程管理工具守护进程：

   ```bash
   npm install -g pm2
   pm2 start npm --name "imgbrowser" -- run serve
   pm2 save
   pm2 startup
   ```

5. 配置 Nginx 反向代理（可选）：

   ```nginx
   server {
       listen 80;
       server_name your-domain.com;

       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

### Docker 部署

项目支持 Docker 容器化运行，提供了完整的 Dockerfile 和 .dockerignore 文件。

#### 快速开始

1. 构建镜像：

   ```bash
   docker build -t imgbrowser .
   ```

2. 运行容器：

   ```bash
   docker run -p 3000:3000 -v $(pwd)/images:/app/images imgbrowser
   ```

   （请确保宿主机上的 `images` 目录已存在并包含图片）

#### 高级配置

- **自定义端口**：将容器端口映射到不同的主机端口
  ```bash
  docker run -p 8080:3000 -v $(pwd)/images:/app/images imgbrowser
  ```

- **自定义图片目录**：使用不同的宿主机目录
  ```bash
  docker run -p 3000:3000 -v /path/to/your/images:/app/images imgbrowser
  ```

- **使用环境变量**：
  ```bash
  docker run -p 3000:3000 \
    -v $(pwd)/images:/app/images \
    -e PORT=3000 \
    -e IMAGES_DIR=/app/images \
    imgbrowser
  ```

- **后台运行**：
  ```bash
  docker run -d -p 3000:3000 -v $(pwd)/images:/app/images --name imgbrowser-container imgbrowser
  ```

- **查看日志**：
  ```bash
  docker logs imgbrowser-container
  ```

- **停止容器**：
  ```bash
  docker stop imgbrowser-container
  ```

#### Docker Compose 部署

创建 `docker-compose.yml` 文件：

```yaml
version: '3.8'
services:
  imgbrowser:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./images:/app/images
      - ./remove:/app/remove
    environment:
      - PORT=3000
      - IMAGES_DIR=/app/images
    restart: unless-stopped
```

然后运行：
```bash
docker-compose up -d
```

### 环境变量

可通过环境变量配置服务器：

- `PORT`：服务端口（默认 3000）
- `IMAGES_DIR`：图片目录路径（默认 `./images` 或 `C:\Users\wwwwi\Downloads`）

示例：

```bash
export PORT=8080
export IMAGES_DIR=/mnt/pictures
npm start
```

## API 文档

### 获取图片列表

`GET /api/images`

**查询参数**：

| 参数   | 类型    | 默认值 | 说明               |
| ------ | ------- | ------ | ------------------ |
| page   | integer | 1      | 页码（从1开始）    |
| limit  | integer | 20     | 每页图片数量       |
| sort   | string  | name   | 排序方式：`name`（按文件名）、`newest`（最新）、`oldest`（最旧） |
| show   | string  | all    | 筛选方式：`all`（所有图片）、`favorites`（收藏夹）、`deleted`（回收站） |

**响应示例**：

```json
{
  "images": [
    {
      "id": 1,
      "url": "http://localhost:3000/images/photo1.jpg",
      "filename": "photo1.jpg",
      "path": "/images/photo1.jpg",
      "favorited": true,
      "deleted": false,
      "deleted_at": null,
      "created_at": "2026-03-13 02:18:54"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8,
    "hasNext": true,
    "hasPrev": false
  }
}
```

### 图片管理 API

| 方法 | 路径 | 功能 | 请求体 | 响应 |
|------|------|------|--------|------|
| POST | `/api/images/:id/favorite` | 切换收藏状态 | 无 | `{"success": true}` |
| POST | `/api/images/:id/delete` | 删除图片（移动到回收站） | 无 | `{"success": true}` |
| POST | `/api/images/:id/restore` | 从回收站恢复图片 | 无 | `{"success": true}` |
| DELETE | `/api/images/:id` | 永久删除图片 | 无 | `{"success": true}` |
| POST | `/api/trash/empty` | 清空回收站 | 无 | `{"success": true, "deletedCount": 5}` |
| GET | `/api/stats` | 获取统计信息 | 无 | `{"total": 70, "favorites": 5, "deleted": 3}` |
| POST | `/api/init` | 手动初始化数据库 | 无 | `{"success": true, "message": "数据库初始化完成"}` |

## 项目结构

```
imgbrowser/
├── src/
│   ├── server.ts          # Express 服务器
│   └── db.ts              # SQLite 数据库模块
├── public/
│   ├── index.html         # 前端页面
│   ├── style.css          # 样式文件
│   └── script.js          # 前端逻辑
├── images/                # 图片目录（从环境变量 IMAGES_DIR 读取）
├── remove/                # 回收站目录（自动创建）
├── imgbrowser.db          # SQLite 数据库文件（自动创建）
├── dist/                  # TypeScript 编译输出目录
├── Dockerfile             # Docker 容器化配置文件
├── .dockerignore          # Docker 构建忽略文件
├── package.json
├── tsconfig.json
└── README.md
```

## 常见问题

### 图片无法显示？

- 确保 `IMAGES_DIR` 目录存在且包含图片文件。
- 检查文件扩展名是否在支持列表中（.jpg, .jpeg, .png, .gif, .bmp, .webp）。
- 确认服务器对图片目录有读取权限。

### 修改端口号？

通过环境变量 `PORT` 设置，或直接修改 `src/server.ts` 中的 `PORT` 常量。

### 如何增加图片加载数量？

修改 `src/server.ts` 中 `limit` 的默认值，或在前端 `script.js` 中调整请求参数。

### 数据库相关问题？

- 数据库文件 `imgbrowser.db` 会在首次启动时自动创建。
- 如果需要重新扫描图片目录，可以访问 `/api/init` 端点或重启服务器。
- 回收站目录 `remove/` 会自动创建，用于存储已删除的图片。

### 部署后无法访问？

- 检查防火墙是否开放对应端口。
- 若使用反向代理，确保代理配置正确。
- 查看服务器日志（`pm2 logs imgbrowser`）。

### 大图查看功能如何使用？

- **点击图片**：打开大图查看模态框
- **键盘快捷键**：
  - 左右箭头：上一张/下一张
  - ESC：关闭模态框
  - F：切换收藏状态
  - D：删除/永久删除
  - 空格：切换缩放
- **鼠标操作**：
  - 双击：放大/缩小
  - 拖拽：查看放大后的图片细节

## 贡献

欢迎提交 Issue 或 Pull Request 改进本项目。

## 许可证

ISC