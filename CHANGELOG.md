# 变更记录

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-10-22

一次以「修复不合理实现 + 提升可用性」为目标的整理，接口有少量破坏性变更（见文末）。

### 修复

- **图片可以绕过密码访问**：`/images`、`/removed` 由 `express.static` 提供且列在白名单里，未登录也能按文件名取图。现在两个目录都要求登录，并加路径穿越校验。
- **从大图删除必定报错**：`deleteImage(id, card)` 在 `card` 为 `null` 时访问 `classList` 抛 `TypeError`，服务端已删除但界面不刷新。改为按 id 操作，删除后自动切到下一张。
- **点击视图按钮的图标会毁掉布局**：事件用 `e.target.dataset.view`，点在 `<svg>` 上得到 `undefined`，`gallery` 变成 `gallery undefined`。
- **`/` 与 `/login.html` 路由被 404 中间件截胡**：路由注册在 `app.use(404)` 之后，永远不生效，实际靠 `express.static` 兜底。
- **收藏状态文案重复**：状态判断依赖中文文案，切换后可能叠加节点。
- **免鉴权访问 `/index.html`**：静态目录整体暴露。
- **`?limit=-3` 返回 10 张图**：`slice(offset, offset-3)` 的结果，且 `totalPages` 为负数。
- **`/api/stats` 500**：`SUM(...) AS all` 与 SQL 关键字冲突。
- **回收站同名文件互相覆盖**：不同目录的同名文件移入同一个 `remove/` 会覆盖；现在用 `id__文件名` 命名，恢复时自动避让重名。
- **扫描可能永远不返回**：任意一次查询出错都会让 `processed` 计数对不上，Promise 永不 resolve。
- **删除记录与磁盘不一致**：永久删除时先删记录后删文件、`unlink` 未等待、文件已丢失时直接 500。

### 变更

- 配置集中在 `src/config.ts`，自带 `.env` 解析（零依赖，兼容 UTF-8 BOM、引号与行尾注释），启动时打印实际生效的目录。
- `IMAGES_DIR` 默认值从硬编码的个人目录改为 `./images`。
- 数据库改用 `sqlite` 异步封装，启用 WAL；自动迁移补列（`width/height/size/mtime`）并建立唯一索引。
- 列表在 SQL 层分页、排序、搜索，返回真实宽高与体积；`sort` 改为按文件修改时间。
- 扫描改为增量：按 `size + mtime` 判断是否需要更新，仅为新文件解析尺寸。
- 会话滑动续期，登录失败按 IP 限流（5 次 / 15 分钟），密码使用常量时间比较。
- 静态资源白名单化，新增严格 CSP、`Permissions-Policy`、`Referrer-Policy`。
- 新增 `GET /api/health`（无需登录），Docker 健康检查改用它。
- 删除列表接口的 5 分钟内存缓存：分页查询本身足够快，缓存只会带来脏数据。
- 日志与错误码规范化：`404` 不存在、`409` 状态冲突、`413/400` 请求体问题。

### 前端

- 重写为无依赖实现：图标内联 SVG，去掉 Font Awesome / Google Fonts 的 CDN 请求，离线可用。
- 顶栏压缩到 68px，工具栏吸顶，首屏即可看到图片；移动端两列布局与两行工具栏。
- 新增搜索框（防抖 + 服务端过滤）、空状态、错误重试、Toast 提示、`RESCAN` 按钮、清空回收站入口。
- 卡片显示真实尺寸与日期，并用 `aspect-ratio` 占位，消除瀑布流加载跳变。
- 大图查看支持 1×–4× 缩放、拖拽平移（Pointer Events，兼容触屏）、缩放百分比显示、自动加载下一张。
- 事件统一委托 + `currentTarget` 取参，彻底避免 `undefined` 视图问题。
- 所有用户数据走 `textContent`，修复文件名 XSS。
- 视图与排序偏好写入 `localStorage`；`prefers-reduced-motion` 下关闭动画。
- 登录页改为与主应用一致的深色霓虹风格，密码可见性切换、错误提示、锁定说明。
- axe-core 审计：0 violations。

### 工程

- `package.json`：`@types/*`、`ts-node`、`typescript`、`nodemon` 移入 devDependencies，补充 `engines`、`typecheck`、`clean` 脚本，版本号 1.1.0。
- Dockerfile 改为多阶段构建，运行阶段使用 Node 22 Alpine + `tini` + 非 root 用户，健康检查指向 `/api/health`。
- `docker-compose.yml`：移除硬编码弱密码，改用 `.env` 提供；数据库与回收站改用命名卷。
- `.env.example`、`.gitignore`、`.dockerignore` 重写，新增 `data/`、WAL 文件等忽略项。
- 新增 `docs/screenshots/` 与 `CHANGELOG.md`，README 全面重写。
- 清理仓库里的 `$null`（一次错误重定向留下的垃圾文件）。

### 破坏性变更

| 变更 | 处理方式 |
| --- | --- |
| `GET /api/images` 的 `url` 改为相对路径 | 前端直接使用；外部脚本需自行拼接域名 |
| `sort=newest/oldest` 改按文件修改时间 | 语义更符合预期，无需迁移 |
| `show=deleted` 改为 `show=trash` | 旧值仍兼容 |
| `GET /api/stats` 字段调整 | `total` 不再包含回收站，新增 `all`、`trashed`、`bytes` |
| 图片文件需要登录 | 外部直接引用图片链接的场景需要带 Cookie |
| `POST /api/init` → `POST /api/scan` | 旧路径保留为别名 |
| `IMAGES_DIR` 默认值变化 | 用 `.env` 指定实际目录 |
