import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import {
  scanAndInsertImages,
  getAllImages,
  toggleFavorite,
  markAsDeleted,
  restoreImage,
  permanentlyDelete,
  emptyTrash,
  getStats,
  ImageRecord
} from './db';

const app = express();
const PORT = process.env.PORT || 3000;
const IMAGES_DIR = process.env.IMAGES_DIR || 'C:\\Users\\wwwwi\\Downloads';
const REMOVED_DIR = path.join(process.cwd(), 'remove');

// 确保目录存在
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}
if (!fs.existsSync(REMOVED_DIR)) {
  fs.mkdirSync(REMOVED_DIR, { recursive: true });
}

// 静态文件服务
app.use('/images', express.static(IMAGES_DIR));
app.use('/removed', express.static(REMOVED_DIR));
app.use(express.static(path.join(process.cwd(), 'public')));

// 解析 JSON 请求体
app.use(express.json());

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

// 获取图片列表的 API
app.get('/api/images', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const sort = (req.query.sort as string) || 'name';
    const show = (req.query.show as string) || 'all';
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

    res.json({
      images,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: offset + limit < total,
        hasPrev: page > 1
      }
    });
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

// 根路由返回前端页面
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'public/index.html'));
});

// 启动服务器时初始化数据库
app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('正在初始化数据库...');
  try {
    await scanAndInsertImages();
    console.log('数据库初始化完成');
  } catch (err) {
    console.error('数据库初始化失败:', err);
  }
});