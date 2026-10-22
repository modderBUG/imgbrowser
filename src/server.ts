import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, IMAGE_EXTENSIONS } from './config';
import {
  DbError,
  SortKey,
  ShowMode,
  closeDb,
  emptyTrash,
  getStats,
  listImages,
  markAsDeleted,
  permanentlyDelete,
  restoreImage,
  syncImages,
  toggleFavorite,
  ImageRecord,
} from './db';

const app = express();
const SESSION_COOKIE = 'sessionId';
const SESSION_TTL_MS = config.sessionTtlHours * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* 会话与登录限流                                                       */
/* ------------------------------------------------------------------ */

interface Session {
  createdAt: number;
  lastSeen: number;
  /** 上一次写入 Cookie 的时间，用于在有效期过半时续签 */
  cookieAt: number;
}

const sessions = new Map<string, Session>();
const MAX_SESSIONS = 500;

interface LoginAttempt {
  count: number;
  windowStart: number;
  blockedUntil: number;
}

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, LoginAttempt>();

function getSession(req: Request): Session | null {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (typeof sessionId !== 'string' || !sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session) return null;

  const now = Date.now();
  if (now - session.lastSeen > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }

  // 滑动续期：活跃用户不会因为固定 24 小时到期被踢出
  session.lastSeen = now;
  return session;
}

function createSession(): string {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (oldest) sessions.delete(oldest[0]);
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(sessionId, { createdAt: now, lastSeen: now, cookieAt: now });
  return sessionId;
}

function cookieOptions(req: Request) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: req.secure,
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

function passwordMatches(input: string): boolean {
  // 定长比较，避免通过响应时间推测密码
  const expected = crypto.createHash('sha256').update(config.password).digest();
  const actual = crypto.createHash('sha256').update(input).digest();
  return crypto.timingSafeEqual(expected, actual);
}

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function getAttempt(key: string): LoginAttempt | null {
  const attempt = loginAttempts.get(key);
  if (!attempt) return null;
  const now = Date.now();
  if (attempt.blockedUntil > now) return attempt;
  if (now - attempt.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return null;
  }
  return attempt;
}

function registerFailure(key: string): void {
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (!attempt || now - attempt.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, windowStart: now, blockedUntil: 0 });
    return;
  }

  attempt.count += 1;
  if (attempt.count >= LOGIN_MAX_FAILURES) {
    attempt.blockedUntil = now + LOGIN_BLOCK_MS;
  }
}

/* ------------------------------------------------------------------ */
/* 请求解析辅助                                                         */
/* ------------------------------------------------------------------ */

const SORT_KEYS: SortKey[] = ['name', 'newest', 'oldest'];
const SHOW_KEYS: ShowMode[] = ['all', 'favorites', 'trash'];

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parseIntParam(value: unknown, fallback: number, min: number, max: number): number {
  const raw = firstString(value);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  // 负数、0、非法输入都当作未传，直接使用默认值
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function parseId(req: Request): number {
  const id = Number.parseInt(firstString(req.params.id) ?? '', 10);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '无效的图片 ID');
  return id;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 把数据库记录转换成前端需要的形状，URL 使用相对路径，反向代理下也不会错。 */
function toDto(row: ImageRecord) {
  const basename = encodeURIComponent(path.basename(row.file_path));
  const url = `/${row.deleted ? 'removed' : 'images'}/${basename}`;
  return {
    id: row.id,
    filename: row.filename,
    url,
    path: url,
    width: row.width,
    height: row.height,
    size: row.size,
    mtime: row.mtime,
    favorited: row.favorited === 1,
    deleted: row.deleted === 1,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* 中间件                                                              */
/* ------------------------------------------------------------------ */

app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self'",
      "script-src 'self'",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const session = getSession(req);
  if (session) {
    // 服务端会话是滑动的，但 Cookie 的 maxAge 是固定值：
    // 过期过半时重新下发，避免「一直在用却被浏览器丢掉 Cookie」
    if (Date.now() - session.cookieAt > SESSION_TTL_MS / 2) {
      const sessionId = req.cookies?.[SESSION_COOKIE];
      if (typeof sessionId === 'string' && sessionId) {
        res.cookie(SESSION_COOKIE, sessionId, cookieOptions(req));
        session.cookieAt = Date.now();
      }
    }
    next();
    return;
  }

  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: '未授权访问，请先登录' });
    return;
  }

  res.redirect('/login.html');
};

/* ------------------------------------------------------------------ */
/* 公开路由（登录页、静态资源、健康检查）                                 */
/* ------------------------------------------------------------------ */

function sendPublicFile(file: string, contentType: string, cacheControl = 'no-cache') {
  const absolute = path.join(config.publicDir, file);
  return (_req: Request, res: Response) => {
    res.sendFile(
      absolute,
      { headers: { 'Content-Type': contentType, 'Cache-Control': cacheControl } },
      (err) => {
        if (err && !res.headersSent) {
          console.error(`[static] 发送 ${file} 失败：`, err.message);
          res.status(404).send('Not Found');
        }
      }
    );
  };
}

const PUBLIC_ASSETS: Record<string, string> = {
  '/style.css': 'text/css; charset=utf-8',
  '/script.js': 'text/javascript; charset=utf-8',
  '/login.css': 'text/css; charset=utf-8',
  '/login.js': 'text/javascript; charset=utf-8',
  '/favicon.svg': 'image/svg+xml',
};

for (const [route, contentType] of Object.entries(PUBLIC_ASSETS)) {
  app.get(route, sendPublicFile(route.slice(1), contentType));
}

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

app.get('/login.html', (req, res) => {
  if (getSession(req)) {
    res.redirect('/');
    return;
  }
  sendPublicFile('login.html', 'text/html; charset=utf-8')(req, res);
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), version: config.version });
});

app.get('/api/auth/status', (req, res) => {
  const session = getSession(req);
  res.json({ authenticated: Boolean(session) });
});

app.post('/api/login', (req: Request, res: Response) => {
  const key = clientKey(req);
  const attempt = getAttempt(key);
  if (attempt && attempt.blockedUntil > Date.now()) {
    const retryAfter = Math.ceil((attempt.blockedUntil - Date.now()) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: `尝试次数过多，请 ${Math.ceil(retryAfter / 60)} 分钟后再试` });
    return;
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password) {
    res.status(400).json({ error: '密码不能为空' });
    return;
  }

  if (!passwordMatches(password)) {
    registerFailure(key);
    res.status(401).json({ error: '密码错误' });
    return;
  }

  loginAttempts.delete(key);
  const sessionId = createSession();
  res.cookie(SESSION_COOKIE, sessionId, cookieOptions(req));
  res.json({ success: true, message: '登录成功' });
});

app.post('/api/logout', (req: Request, res: Response) => {
  const sessionId = req.cookies?.[SESSION_COOKIE];
  if (typeof sessionId === 'string' && sessionId) sessions.delete(sessionId);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ success: true, message: '已登出' });
});

/* ------------------------------------------------------------------ */
/* 需要登录                                                            */
/* ------------------------------------------------------------------ */

app.use(requireAuth);

app.get('/', sendPublicFile('index.html', 'text/html; charset=utf-8'));
// 保留 /index.html 可访问，避免旧书签 404
app.get('/index.html', (_req, res) => res.redirect('/'));

/**
 * 图片与回收站文件同样需要登录：否则只要猜到文件名，密码就形同虚设。
 */
function mediaHandler(directory: string) {
  return (req: Request, res: Response) => {
    let relative: string;
    try {
      relative = decodeURIComponent(req.path).replace(/^\/+/, '');
    } catch {
      res.status(400).json({ error: '无效的文件路径' });
      return;
    }

    if (!relative || relative.includes('\0')) {
      res.status(400).json({ error: '无效的文件路径' });
      return;
    }

    const absolute = path.resolve(directory, relative);
    const root = path.resolve(directory);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      res.status(403).json({ error: '禁止访问该路径' });
      return;
    }

    if (!IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
      res.status(404).json({ error: '资源不存在' });
      return;
    }

    res.sendFile(
      absolute,
      {
        headers: {
          'Cache-Control': 'private, max-age=0, must-revalidate',
          'Content-Disposition': 'inline',
        },
      },
      (err) => {
        if (!err || res.headersSent) return;
        const status = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
        res.status(status).json({ error: status === 404 ? '文件不存在' : '读取文件失败' });
      }
    );
  };
}

app.use('/images', mediaHandler(config.imagesDir));
app.use('/removed', mediaHandler(config.trashDir));

app.get('/api/images', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseIntParam(req.query.page, 1, 1, 1_000_000);
    const limit = parseIntParam(req.query.limit, config.defaultLimit, 1, config.maxLimit);
    const sortParam = firstString(req.query.sort);
    const showParam = firstString(req.query.show);
    const sort: SortKey = SORT_KEYS.includes(sortParam as SortKey) ? (sortParam as SortKey) : 'name';
    // 兼容旧前端的 show=deleted 写法
    const normalizedShow = showParam === 'deleted' ? 'trash' : showParam;
    const show: ShowMode = SHOW_KEYS.includes(normalizedShow as ShowMode)
      ? (normalizedShow as ShowMode)
      : 'all';
    const q = (firstString(req.query.q) ?? '').trim().slice(0, 120);

    const offset = (page - 1) * limit;
    const { rows, total } = await listImages({ show, sort, q, limit, offset });

    res.json({
      images: rows.map(toDto),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNext: offset + rows.length < total,
        hasPrev: page > 1 && rows.length > 0,
      },
      query: { page, limit, sort, show, q },
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getStats());
  } catch (err) {
    next(err);
  }
});

app.post('/api/images/:id/favorite', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await toggleFavorite(parseId(req));
    res.json({ success: true, favorited: result.favorited });
  } catch (err) {
    next(err);
  }
});

app.post('/api/images/:id/delete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const image = await markAsDeleted(parseId(req));
    res.json({ success: true, deleted_at: image.deleted_at });
  } catch (err) {
    next(err);
  }
});

app.post('/api/images/:id/restore', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const image = await restoreImage(parseId(req));
    res.json({ success: true, filename: image.filename, path: toDto(image).path });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/images/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await permanentlyDelete(parseId(req));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/trash/empty', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const deletedCount = await emptyTrash();
    res.json({ success: true, deletedCount });
  } catch (err) {
    next(err);
  }
});

async function handleScan(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await syncImages();
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

app.post('/api/scan', handleScan);
// 旧路径保留，避免已有脚本失效
app.post('/api/init', handleScan);

/* ------------------------------------------------------------------ */
/* 兜底处理                                                            */
/* ------------------------------------------------------------------ */

app.use((req: Request, res: Response) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: '接口不存在' });
    return;
  }
  if (req.method === 'GET' && req.accepts('html')) {
    res.status(404).send('404 Not Found');
    return;
  }
  res.status(404).end();
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  if (err instanceof DbError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'CONFLICT' ? 409 : 500;
    if (status === 500) console.error('[db]', err.message);
    res.status(status).json({ error: err.message });
    return;
  }

  const type = (err as Error & { type?: string }).type;
  if (type === 'entity.parse.failed') {
    res.status(400).json({ error: '请求体不是合法的 JSON' });
    return;
  }
  if (type === 'entity.too.large') {
    res.status(413).json({ error: '请求体过大' });
    return;
  }

  console.error('[server] 未处理的错误：', err);
  res.status(500).json({ error: '服务器内部错误' });
});

/* ------------------------------------------------------------------ */
/* 启动与关闭                                                          */
/* ------------------------------------------------------------------ */

// 启动前确保前端资源存在，避免部署漏拷文件时才在运行时暴露
if (!fs.existsSync(path.join(config.publicDir, 'index.html'))) {
  console.error(`未找到前端文件：${path.join(config.publicDir, 'index.html')}`);
  process.exit(1);
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
  for (const [key, attempt] of loginAttempts) {
    const expired = now - attempt.windowStart > LOGIN_WINDOW_MS;
    if (expired && attempt.blockedUntil < now) loginAttempts.delete(key);
  }
}, 10 * 60 * 1000);
cleanupTimer.unref?.();

const server = app.listen(config.port, config.host, async () => {
  console.log('');
  console.log(`  ImgBrowser v${config.version} 已启动`);
  console.log(`  地址      http://localhost:${config.port}`);
  console.log(`  图片目录  ${config.imagesDir}`);
  console.log(`  回收站    ${config.trashDir}`);
  console.log(`  数据库    ${config.dbPath}`);
  console.log('');

  try {
    const result = await syncImages();
    console.log(
      `[scan] 完成：新增 ${result.added}，更新 ${result.updated}，清理 ${result.removed}，` +
        `共 ${result.total} 个文件（${result.durationMs}ms）`
    );
  } catch (err) {
    console.error('[scan] 初始化扫描失败：', (err as Error).message);
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用，请修改 PORT 或释放该端口`);
  } else {
    console.error('服务启动失败：', err);
  }
  process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在关闭...`);

  clearInterval(cleanupTimer);
  const forceExit = setTimeout(() => {
    console.error('关闭超时，强制退出');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async () => {
    await closeDb();
    console.log('已安全退出');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[server] 未处理的 Promise 拒绝：', reason);
});
