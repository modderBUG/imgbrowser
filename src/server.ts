import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import {
  scanAndInsertImages,
  getAllImages,
  toggleFavorite,
  markAsDeleted,
  restoreImage,
  permanentlyDelete,
  emptyTrash,
  getStats,
  closeDb,
  ImageRecord
} from './db';

// 扩展Request类型以包含cookies属性
declare global {
  namespace Express {
    interface Request {
      cookies: Record<string, string>;
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const IMAGES_DIR = process.env.IMAGES_DIR || 'C:\\Users\\wwwwi\\Downloads';
const REMOVED_DIR = path.join(process.cwd(), 'remove');
const PASSWORD = process.env.APP_PASSWORD;
if (!PASSWORD) {
  console.error('ERROR: APP_PASSWORD environment variable is required');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// 简单的会话存储（内存中）
interface Session {
  id: string;
  authenticated: boolean;
  createdAt: number;
}

const sessions = new Map<string, Session>();

// 生成随机会话ID
function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

// 验证会话
function verifySession(req: Request): boolean {
  const sessionId = req.cookies?.sessionId;
  if (!sessionId) return false;
  
  const session = sessions.get(sessionId);
  if (!session) return false;
  
  // 检查会话是否过期（24小时）
  const now = Date.now();
  const sessionAge = now - session.createdAt;
  const maxAge = 24 * 60 * 60 * 1000; // 24小时
  
  if (sessionAge > maxAge) {
    sessions.delete(sessionId);
    return false;
  }
  
  return session.authenticated;
}

// 认证中间件
function requireAuth(req: Request, res: Response, next: Function) {
  // 允许访问登录页面和静态文件
  const allowedPaths = [
    '/login.html',
    '/api/login',
    '/api/logout',
    '/api/auth/status',
    '/style.css',
    '/script.js',
    '/favicon.ico',
    '/images/',
    '/removed/'
  ];
  
  const isAllowed = allowedPaths.some(path => 
    req.path === path || req.path.startsWith(path)
  );
  
  if (isAllowed) {
    return next();
  }
  
  // 允许访问根路径（会重定向到登录页面）
  if (req.path === '/' || req.path === '') {
    return next();
  }
  
  if (verifySession(req)) {
    next();
  } else {
    // 对于API请求返回401，对于页面请求重定向到登录页面
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: '未授权访问' });
    } else {
      res.redirect('/login.html');
    }
  }
}

// 确保目录存在
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}
if (!fs.existsSync(REMOVED_DIR)) {
  fs.mkdirSync(REMOVED_DIR, { recursive: true });
}

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// 静态文件服务
app.use('/images', express.static(IMAGES_DIR));
app.use('/removed', express.static(REMOVED_DIR));
app.use(express.static(path.join(process.cwd(), 'public')));

// 解析 JSON 请求体和cookies
app.use(express.json());
app.use(cookieParser());

// 应用认证中间件
app.use(requireAuth);

// 登录API
app.post('/api/login', (req: Request, res: Response) => {
  try {
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({ error: '密码不能为空' });
    }
    
    if (password === PASSWORD) {
      // 创建新会话
      const sessionId = generateSessionId();
      sessions.set(sessionId, {
        id: sessionId,
        authenticated: true,
        createdAt: Date.now()
      });
      
      // 设置cookie（24小时过期）
      res.cookie('sessionId', sessionId, {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24小时
        sameSite: 'strict'
      });
      
      return res.json({ success: true, message: '登录成功' });
    } else {
      return res.status(401).json({ error: '密码错误' });
    }
  } catch (err) {
    console.error('登录处理失败:', err);
    res.status(500).json({ error: '登录处理失败' });
  }
});

// 登出API
app.post('/api/logout', (req: Request, res: Response) => {
  const sessionId = req.cookies?.sessionId;
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.clearCookie('sessionId');
  res.json({ success: true, message: '已登出' });
});

// 检查登录状态API
app.get('/api/auth/status', (req: Request, res: Response) => {
  const isAuthenticated = verifySession(req);
  res.json({ authenticated: isAuthenticated });
});

// 初始化数据库（扫描图片）
app.post('/api/init', async (req: Request, res: Response) => {
  try {
    await scanAndInsertImages();
    res.json({ success: true, message: '数据库初始化完成' });
  } catch (err) {
    console.error('初始化失败:', err);
    res.status(500).json({ error: '初始化失败' });
  }
});

// 简单的响应缓存（内存中，5 分钟过期）
interface CacheEntry {
  data: any;
  timestamp: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 分钟

// 清除所有图片缓存
function clearImageCache(): void {
  for (const [key] of cache.entries()) {
    if (key.startsWith('images-')) {
      cache.delete(key);
    }
  }
}

// 获取图片列表的 API
app.get('/api/images', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const sort = (req.query.sort as string) || 'name';
    const show = (req.query.show as string) || 'all';
    
    // 检查缓存
    const cacheKey = `images-${page}-${limit}-${sort}-${show}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return res.json(cached.data);
    }
    
    const offset = (page - 1) * limit;

    // 从数据库获取图片
    const allImages = await getAllImages(show as any);
    
    // 排序
    let sortedImages = [...allImages];
    if (sort === 'newest') {
      sortedImages.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (sort === 'oldest') {
      sortedImages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    } else {
      sortedImages.sort((a, b) => a.filename.localeCompare(b.filename));
    }

    const total = sortedImages.length;
    const paginatedImages = sortedImages.slice(offset, offset + limit);
    
    // 构建完整的 URL
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const images = paginatedImages.map(img => {
      const urlPath = img.deleted ? `/removed/${path.basename(img.file_path)}` : `/images/${path.basename(img.file_path)}`;
      return {
        id: img.id,
        url: `${baseUrl}${urlPath}`,
        filename: img.filename,
        path: urlPath,
        favorited: img.favorited === 1,
        deleted: img.deleted === 1,
        deleted_at: img.deleted_at,
        created_at: img.created_at
      };
    });

    const response = {
      images,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: offset + limit < total,
        hasPrev: page > 1
      }
    };
    
    // 存储到缓存
    cache.set(cacheKey, {
      data: response,
      timestamp: Date.now()
    });
    
    res.json(response);
  } catch (err) {
    console.error('获取图片列表失败:', err);
    res.status(500).json({ error: '获取图片列表失败' });
  }
});

// 切换收藏状态
app.post('/api/images/:id/favorite', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      res.status(400).json({ error: '无效的图片ID' });
      return;
    }
    
    const success = await toggleFavorite(id);
    if (success) {
      clearImageCache();
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '图片不存在' });
    }
  } catch (err) {
    console.error('切换收藏状态失败:', err);
    res.status(500).json({ error: '操作失败' });
  }
});

// 删除图片（移动到回收站）
app.post('/api/images/:id/delete', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      res.status(400).json({ error: '无效的图片ID' });
      return;
    }
    
    const success = await markAsDeleted(id);
    if (success) {
      clearImageCache();
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '图片不存在或删除失败' });
    }
  } catch (err) {
    console.error('删除图片失败:', err);
    res.status(500).json({ error: '删除失败' });
  }
});

// 恢复图片
app.post('/api/images/:id/restore', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      res.status(400).json({ error: '无效的图片ID' });
      return;
    }
    
    const success = await restoreImage(id);
    if (success) {
      clearImageCache();
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '图片不存在或恢复失败' });
    }
  } catch (err) {
    console.error('恢复图片失败:', err);
    res.status(500).json({ error: '恢复失败' });
  }
});

// 永久删除图片
app.delete('/api/images/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) {
      res.status(400).json({ error: '无效的图片ID' });
      return;
    }
    
    const success = await permanentlyDelete(id);
    if (success) {
      clearImageCache();
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '图片不存在' });
    }
  } catch (err) {
    console.error('永久删除失败:', err);
    res.status(500).json({ error: '删除失败' });
  }
});

// 清空回收站
app.post('/api/trash/empty', async (req: Request, res: Response) => {
  try {
    const deletedCount = await emptyTrash();
    clearImageCache();
    res.json({ success: true, deletedCount });
  } catch (err) {
    console.error('清空回收站失败:', err);
    res.status(500).json({ error: '清空失败' });
  }
});

// 获取统计信息
app.get('/api/stats', async (req: Request, res: Response) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    console.error('获取统计信息失败:', err);
    res.status(500).json({ error: '获取统计信息失败' });
  }
});

// 404 错误处理
app.use((req, res, next) => {
  res.status(404).json({ error: '资源不存在' });
});

// 全局错误处理中间件
app.use((err: Error, req: Request, res: Response, next: Function) => {
  console.error('服务器错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 根路由：如果已登录则返回主页面，否则重定向到登录页面
app.get('/', (req: Request, res: Response) => {
  if (verifySession(req)) {
    res.sendFile(path.join(process.cwd(), 'public/index.html'));
  } else {
    res.redirect('/login.html');
  }
});

// 登录页面路由
app.get('/login.html', (req: Request, res: Response) => {
  // 如果已经登录，重定向到主页面
  if (verifySession(req)) {
    res.redirect('/');
  } else {
    res.sendFile(path.join(process.cwd(), 'public/login.html'));
  }
});

// 定期清理过期会话（每 1 小时）
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 小时
  
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > maxAge) {
      sessions.delete(sessionId);
    }
  }
}, 60 * 60 * 1000);

// 定期清理过期缓存（每 10 分钟）
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > CACHE_DURATION) {
      cache.delete(key);
    }
  }
}, 10 * 60 * 1000);

let server: any = null;

// 优雅关闭服务器
const gracefulShutdown = async (signal: string) => {
  console.log(`\n收到 ${signal} 信号，正在关闭服务器...`);
  
  // 关闭数据库连接
  closeDb();
  
  // 关闭服务器
  if (server) {
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
  } else {
    console.log('服务器已关闭');
    process.exit(0);
  }
  
  // 如果 10 秒后仍未关闭，强制退出
  setTimeout(() => {
    console.error('强制关闭服务器');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 启动服务器时初始化数据库
server = app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('正在初始化数据库...');
  try {
    await scanAndInsertImages();
    console.log('数据库初始化完成');
  } catch (err) {
    console.error('数据库初始化失败:', err);
  }
});