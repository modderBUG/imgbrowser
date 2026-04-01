import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'imgbrowser.db');
const IMAGES_DIR = process.env.IMAGES_DIR || 'C:\\Users\\wwwwi\\Downloads';
const REMOVED_DIR = path.join(process.cwd(), 'remove');

// 确保 remove 目录存在
if (!fs.existsSync(REMOVED_DIR)) {
  fs.mkdirSync(REMOVED_DIR, { recursive: true });
}

let db: sqlite3.Database | null = null;

function getDb(): sqlite3.Database {
  if (!db) {
    db = new sqlite3.Database(DB_PATH);
    initDb();
  }
  return db;
}

function initDb(): void {
  const db = getDb();
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        favorited BOOLEAN DEFAULT 0,
        deleted BOOLEAN DEFAULT 0,
        deleted_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 创建索引
    db.run('CREATE INDEX IF NOT EXISTS idx_favorited ON images(favorited)');
    db.run('CREATE INDEX IF NOT EXISTS idx_deleted ON images(deleted)');
    db.run('CREATE INDEX IF NOT EXISTS idx_filename ON images(filename)');
  });
  console.log('数据库初始化完成');
}

export async function scanAndInsertImages(): Promise<void> {
  const db = getDb();
  
  return new Promise((resolve, reject) => {
    fs.readdir(IMAGES_DIR, (err, files) => {
      if (err) {
        console.error('读取图片目录失败:', err);
        reject(err);
        return;
      }

      const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
      const imageFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return imageExtensions.includes(ext);
      });

      if (imageFiles.length === 0) {
        console.log('未找到图片文件');
        resolve();
        return;
      }

     let processed = 0;
      const total = imageFiles.length;

      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        imageFiles.forEach(file => {
          const filePath = path.join(IMAGES_DIR, file);
          
          db.get('SELECT id FROM images WHERE file_path = ?', [filePath], (err, row) => {
            if (err) {
              console.error('查询数据库失败:', err);
              return;
            }

            if (!row) {
              db.run(
                'INSERT INTO images (file_path, filename) VALUES (?, ?)',
                [filePath, file],
                (err) => {
                  if (err) {
                    console.error('插入图片失败:', err);
                  } else {
                    console.log(`插入图片：${file}`);
                  }
                  processed++;
                  if (processed === total) {
                    db.run('COMMIT', () => {
                      console.log(`扫描完成，共处理 ${total} 个图片文件`);
                      resolve();
                    });
                  }
                }
              );
            } else {
              processed++;
              if (processed === total) {
                db.run('COMMIT', () => {
                  console.log(`扫描完成，共处理 ${total} 个图片文件`);
                  resolve();
                });
              }
            }
          });
        });
      });
 });
  });
}

export interface ImageRecord {
  id: number;
  file_path: string;
  filename: string;
  favorited: number;
  deleted: number;
  deleted_at: string | null;
  created_at: string;
}

export function getAllImages(show?: 'all' | 'favorites' | 'deleted'): Promise<ImageRecord[]> {
  return new Promise((resolve, reject) => {
    const db = getDb();
    let query = 'SELECT * FROM images WHERE 1=1';
    const params: any[] = [];

    if (show === 'favorites') {
      query += ' AND favorited = 1 AND deleted = 0';
    } else if (show === 'deleted') {
      query += ' AND deleted = 1';
    } else {
      query += ' AND deleted = 0';
    }

    query += ' ORDER BY created_at DESC';
    
    db.all<ImageRecord>(query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows || []);
      }
    });
  });
}

export function toggleFavorite(id: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const db = getDb();
    db.run(
      'UPDATE images SET favorited = NOT favorited WHERE id = ?',
      [id],
      function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      }
    );
  });
}

export async function markAsDeleted(id: number): Promise<boolean> {
  const db = getDb();
  
  return new Promise((resolve, reject) => {
    db.get<ImageRecord>('SELECT * FROM images WHERE id = ?', [id], async (err, image) => {
      if (err || !image) {
        reject(err || new Error('图片不存在'));
        return;
      }

      // 移动文件到回收站目录（使用复制 + 删除处理跨设备）
      try {
        const sourcePath = image.file_path;
        const filename = path.basename(sourcePath);
        const destPath = path.join(REMOVED_DIR, filename);
        
        // 复制文件到回收站
        await fs.promises.copyFile(sourcePath, destPath);
        // 删除原文件
        await fs.promises.unlink(sourcePath);
        
        // 更新数据库：标记为删除并更新文件路径
        db.run(
          'UPDATE images SET deleted = 1, deleted_at = CURRENT_TIMESTAMP, file_path = ? WHERE id = ?',
          [destPath, id],
          function(err) {
            if (err) {
              console.error('更新数据库失败:', err);
              reject(err);
            } else {
              console.log(`文件已移动到回收站：${filename}`);
              resolve(this.changes > 0);
            }
          }
        );
      } catch (err) {
        console.error('移动文件失败:', err);
        reject(err);
      }
   });
  });
}

export async function restoreImage(id: number): Promise<boolean> {
  const db = getDb();
  
  return new Promise((resolve, reject) => {
    db.get<ImageRecord>('SELECT * FROM images WHERE id = ?', [id], async (err, image) => {
      if (err || !image || !image.deleted) {
        reject(err || new Error('图片不存在或未删除'));
        return;
      }

      // 移动文件回原目录（使用复制 + 删除处理跨设备）
      const sourcePath = image.file_path;
      const filename = path.basename(sourcePath);
      const destPath = path.join(IMAGES_DIR, filename);
      
      try {
        await fs.promises.copyFile(sourcePath, destPath);
        await fs.promises.unlink(sourcePath);
        
        // 更新数据库
        db.run(
          'UPDATE images SET deleted = 0, deleted_at = NULL, file_path = ? WHERE id = ?',
          [destPath, id],
          function(err) {
            if (err) {
              reject(err);
            } else {
              console.log(`文件已恢复：${filename}`);
              resolve(this.changes > 0);
            }
          }
        );
      } catch (err) {
        console.error('恢复文件失败:', err);
        reject(err);
      }
  });
  });
}

export function permanentlyDelete(id: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const db = getDb();
    
    db.get<ImageRecord>('SELECT * FROM images WHERE id = ?', [id], (err, image) => {
      if (err || !image) {
        reject(err || new Error('图片不存在'));
        return;
      }

      // 删除物理文件
      if (fs.existsSync(image.file_path)) {
        fs.unlink(image.file_path, (err) => {
          if (err) {
            console.error('删除文件失败:', err);
          }
        });
      }
      
      // 删除数据库记录
      db.run('DELETE FROM images WHERE id = ?', [id], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes > 0);
        }
      });
    });
  });
}

export function emptyTrash(): Promise<number> {
  return new Promise((resolve, reject) => {
    const db = getDb();
    
    db.all<ImageRecord>('SELECT * FROM images WHERE deleted = 1', [], (err, deletedImages) => {
      if (err) {
        reject(err);
        return;
      }

      let deletedCount = 0;
      let processed = 0;
      const total = deletedImages.length;

      if (total === 0) {
        resolve(0);
        return;
      }

      deletedImages.forEach(image => {
        // 删除物理文件
        if (fs.existsSync(image.file_path)) {
          fs.unlink(image.file_path, (err) => {
            if (err) {
              console.error(`删除文件 ${image.filename} 失败:`, err);
            }
          });
        }
        
        // 删除数据库记录
        db.run('DELETE FROM images WHERE id = ?', [image.id], (err) => {
          if (err) {
            console.error(`删除数据库记录 ${image.id} 失败:`, err);
          } else {
            deletedCount++;
          }
          
          processed++;
          if (processed === total) {
            resolve(deletedCount);
          }
        });
      });
    });
  });
}

export function getStats(): Promise<{ total: number; favorites: number; deleted: number }> {
  return new Promise((resolve, reject) => {
    const db = getDb();
    
    db.get<{ count: number }>('SELECT COUNT(*) as count FROM images', (err, total) => {
      if (err) {
        reject(err);
        return;
      }
      
      db.get<{ count: number }>('SELECT COUNT(*) as count FROM images WHERE favorited = 1 AND deleted = 0', (err, favorites) => {
        if (err) {
          reject(err);
          return;
        }
        
        db.get<{ count: number }>('SELECT COUNT(*) as count FROM images WHERE deleted = 1', (err, deleted) => {
          if (err) {
            reject(err);
            return;
          }
          
          resolve({
            total: total?.count || 0,
            favorites: favorites?.count || 0,
            deleted: deleted?.count || 0,
          });
        });
      });
    });
  });
}

// 关闭数据库连接
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}