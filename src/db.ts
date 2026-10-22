import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, IMAGE_EXTENSIONS } from './config';
import { readImageSize } from './imageSize';

export type ShowMode = 'all' | 'favorites' | 'trash';
export type SortKey = 'name' | 'newest' | 'oldest';

export interface ImageRecord {
  id: number;
  file_path: string;
  filename: string;
  width: number | null;
  height: number | null;
  size: number | null;
  /** 文件修改时间（毫秒时间戳），用于 newest/oldest 排序 */
  mtime: number | null;
  favorited: number;
  deleted: number;
  deleted_at: string | null;
  created_at: string;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
  durationMs: number;
}

export type DbErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'IO';

export class DbError extends Error {
  constructor(readonly code: DbErrorCode, message: string) {
    super(message);
    this.name = 'DbError';
  }
}

const SORT_SQL: Record<SortKey, string> = {
  name: 'filename COLLATE NOCASE ASC, id ASC',
  newest: 'COALESCE(mtime, 0) DESC, id DESC',
  oldest: 'COALESCE(mtime, 0) ASC, id ASC',
};

let dbHandle: Promise<Database> | null = null;
let syncInFlight: Promise<SyncResult> | null = null;

function getDb(): Promise<Database> {
  if (!dbHandle) dbHandle = openDatabase();
  return dbHandle;
}

async function openDatabase(): Promise<Database> {
  await fsp.mkdir(path.dirname(config.dbPath), { recursive: true });
  await fsp.mkdir(config.trashDir, { recursive: true });

  const db = await open({ filename: config.dbPath, driver: sqlite3.Database });
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA synchronous = NORMAL');
  await db.exec('PRAGMA busy_timeout = 5000');
  await migrate(db);
  return db;
}

async function migrate(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      size INTEGER,
      mtime INTEGER,
      favorited INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // 兼容旧库：补齐后加的列
  const existing = new Set(
    (await db.all<{ name: string }[]>('PRAGMA table_info(images)')).map((column) => column.name)
  );
  const addedColumns: Array<[string, string]> = [
    ['width', 'INTEGER'],
    ['height', 'INTEGER'],
    ['size', 'INTEGER'],
    ['mtime', 'INTEGER'],
  ];
  for (const [name, type] of addedColumns) {
    if (!existing.has(name)) {
      await db.exec(`ALTER TABLE images ADD COLUMN ${name} ${type}`);
    }
  }

  // 旧库没有唯一约束，先去重再建唯一索引，避免同一文件被登记多次
  await db.exec(`
    DELETE FROM images
    WHERE id NOT IN (SELECT MIN(id) FROM images GROUP BY file_path)
  `);

  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_images_path ON images(file_path)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_images_deleted ON images(deleted, favorited)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_images_mtime ON images(mtime)');
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export interface ListParams {
  show: ShowMode;
  sort: SortKey;
  q: string;
  limit: number;
  offset: number;
}

export interface ListResult {
  rows: ImageRecord[];
  total: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function listImages(params: ListParams): Promise<ListResult> {
  const db = await getDb();
  const where: string[] = [];

  if (params.show === 'trash') {
    where.push('deleted = 1');
  } else if (params.show === 'favorites') {
    where.push('deleted = 0', 'favorited = 1');
  } else {
    where.push('deleted = 0');
  }

  const queryParams: unknown[] = [];
  if (params.q) {
    where.push(`filename LIKE ? ESCAPE '\\'`);
    queryParams.push(`%${escapeLike(params.q)}%`);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const countRow = await db.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM images ${whereSql}`,
    queryParams
  );

  const rows = await db.all<ImageRecord[]>(
    `SELECT * FROM images ${whereSql} ORDER BY ${SORT_SQL[params.sort]} LIMIT ? OFFSET ?`,
    [...queryParams, params.limit, params.offset]
  );

  return { rows, total: countRow?.total ?? 0 };
}

export interface Stats {
  /** 不含回收站 */
  total: number;
  favorites: number;
  trashed: number;
  /** 含回收站 */
  all: number;
  bytes: number;
}

export async function getStats(): Promise<Stats> {
  const db = await getDb();
  const row = await db.get<{
    totalAll: number;
    favorites: number;
    trashed: number;
    bytes: number;
  }>(`
    SELECT
      COUNT(*) AS totalAll,
      COALESCE(SUM(CASE WHEN favorited = 1 AND deleted = 0 THEN 1 ELSE 0 END), 0) AS favorites,
      COALESCE(SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END), 0) AS trashed,
      COALESCE(SUM(CASE WHEN deleted = 0 THEN size ELSE 0 END), 0) AS bytes
    FROM images
  `);

  const all = row?.totalAll ?? 0;
  const trashed = row?.trashed ?? 0;
  return {
    total: all - trashed,
    favorites: row?.favorites ?? 0,
    trashed,
    all,
    bytes: row?.bytes ?? 0,
  };
}

async function requireImage(id: number): Promise<ImageRecord> {
  const db = await getDb();
  const row = await db.get<ImageRecord>('SELECT * FROM images WHERE id = ?', [id]);
  if (!row) throw new DbError('NOT_FOUND', '图片不存在');
  return row;
}

/* ------------------------------------------------------------------ */
/* 状态变更                                                            */
/* ------------------------------------------------------------------ */

export async function toggleFavorite(id: number): Promise<{ favorited: boolean }> {
  const db = await getDb();
  const result = await db.run(
    'UPDATE images SET favorited = CASE WHEN favorited = 1 THEN 0 ELSE 1 END WHERE id = ?',
    [id]
  );
  if (result.changes === 0) throw new DbError('NOT_FOUND', '图片不存在');

  const row = await db.get<{ favorited: number }>('SELECT favorited FROM images WHERE id = ?', [id]);
  return { favorited: row?.favorited === 1 };
}

/** 回收站内的文件名带上 id 前缀，避免不同目录的同名文件互相覆盖。 */
function trashPathFor(image: ImageRecord): string {
  return path.join(config.trashDir, `${image.id}__${image.filename}`);
}

async function uniqueTargetPath(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

async function moveFile(source: string, target: string): Promise<void> {
  try {
    await fsp.rename(source, target);
  } catch (err) {
    // 跨磁盘/跨设备时 rename 会失败，退化为复制后删除
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsp.copyFile(source, target);
    await fsp.unlink(source);
  }
}

export async function markAsDeleted(id: number): Promise<ImageRecord> {
  const db = await getDb();
  const image = await requireImage(id);
  if (image.deleted) throw new DbError('CONFLICT', '图片已在回收站中');

  const target = trashPathFor(image);
  try {
    await moveFile(image.file_path, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 文件已经被外部删掉，仍然要把记录移入回收站，避免脏数据
      console.warn(`[db] 文件不存在，仅更新记录：${image.file_path}`);
    } else {
      throw new DbError('IO', `移动到回收站失败：${(err as Error).message}`);
    }
  }

  await db.run(
    `UPDATE images SET deleted = 1, deleted_at = datetime('now'), file_path = ? WHERE id = ?`,
    [target, id]
  );

  return requireImage(id);
}

export async function restoreImage(id: number): Promise<ImageRecord> {
  const db = await getDb();
  const image = await requireImage(id);
  if (!image.deleted) throw new DbError('CONFLICT', '图片不在回收站中');

  const target = await uniqueTargetPath(config.imagesDir, image.filename);
  try {
    await moveFile(image.file_path, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new DbError('IO', `恢复文件失败：${(err as Error).message}`);
    }
    console.warn(`[db] 回收站文件缺失，仅恢复记录：${image.file_path}`);
  }

  const filename = path.basename(target);
  await db.run(
    `UPDATE images SET deleted = 0, deleted_at = NULL, file_path = ?, filename = ? WHERE id = ?`,
    [target, filename, id]
  );

  return requireImage(id);
}

export async function permanentlyDelete(id: number): Promise<void> {
  const db = await getDb();
  const image = await requireImage(id);

  await fsp.unlink(image.file_path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') {
      throw new DbError('IO', `删除文件失败：${err.message}`);
    }
  });

  const result = await db.run('DELETE FROM images WHERE id = ?', [id]);
  if (result.changes === 0) throw new DbError('NOT_FOUND', '图片不存在');
}

export async function emptyTrash(): Promise<number> {
  const db = await getDb();
  const rows = await db.all<ImageRecord[]>('SELECT * FROM images WHERE deleted = 1');

  let deletedCount = 0;
  for (const row of rows) {
    try {
      await fsp.unlink(row.file_path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[db] 删除回收站文件失败：${row.file_path}`, (err as Error).message);
      }
    }
    await db.run('DELETE FROM images WHERE id = ?', [row.id]);
    deletedCount += 1;
  }

  // 清理回收站目录里没有被数据库登记的文件（历史遗留或手动放入的）
  await sweepTrashDirectory(new Set(rows.map((row) => path.basename(row.file_path))));

  return deletedCount;
}

async function sweepTrashDirectory(known: Set<string>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(config.trashDir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !known.has(entry.name))
      .map((entry) =>
        fsp.unlink(path.join(config.trashDir, entry.name)).catch(() => undefined)
      )
  );
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

function isSameDirectory(candidate: string, dir: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(path.dirname(candidate)) === normalize(dir);
}

/**
 * 增量同步：新增文件入库、变动文件更新元数据、已消失的文件从库中移除。
 * 同一时刻只允许一个扫描任务，重复调用复用同一个 Promise。
 */
export function syncImages(): Promise<SyncResult> {
  if (!syncInFlight) {
    syncInFlight = runSync().finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}

async function runSync(): Promise<SyncResult> {
  const startedAt = Date.now();
  const db = await getDb();
  await fsp.mkdir(config.imagesDir, { recursive: true });
  await fsp.mkdir(config.trashDir, { recursive: true });

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(config.imagesDir, { withFileTypes: true });
  } catch (err) {
    throw new DbError('IO', `无法读取图片目录 ${config.imagesDir}：${(err as Error).message}`);
  }

  const files = entries.filter(
    (entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
  );

  const existingRows = await db.all<ImageRecord[]>('SELECT * FROM images');
  const byPath = new Map(existingRows.map((row) => [row.file_path, row]));

  let added = 0;
  let updated = 0;
  const presentPaths = new Set<string>();

  await db.exec('BEGIN');
  try {
    for (const file of files) {
      const filePath = path.join(config.imagesDir, file.name);
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        continue;
      }

      presentPaths.add(filePath);
      const known = byPath.get(filePath);
      const size = stat.size;
      const mtime = Math.round(stat.mtimeMs);

      if (!known) {
        const dimensions = await readImageSize(filePath);
        await db.run(
          `INSERT OR IGNORE INTO images (file_path, filename, width, height, size, mtime)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [filePath, file.name, dimensions?.width ?? null, dimensions?.height ?? null, size, mtime]
        );
        added += 1;
        continue;
      }

      if (known.size !== size || known.mtime !== mtime || known.filename !== file.name) {
        const dimensions = known.width && known.height ? null : await readImageSize(filePath);
        await db.run(
          `UPDATE images
             SET filename = ?, size = ?, mtime = ?,
                 width = COALESCE(?, width), height = COALESCE(?, height)
           WHERE id = ?`,
          [
            file.name,
            size,
            mtime,
            dimensions?.width ?? null,
            dimensions?.height ?? null,
            known.id,
          ]
        );
        updated += 1;
      }
    }

    // 清理源目录里已经不存在、且没有被移入回收站的记录
    const staleIds = existingRows
      .filter(
        (row) =>
          row.deleted === 0 && isSameDirectory(row.file_path, config.imagesDir) && !presentPaths.has(row.file_path)
      )
      .map((row) => row.id);

    for (const id of staleIds) {
      await db.run('DELETE FROM images WHERE id = ?', [id]);
    }

    await db.exec('COMMIT');

    return {
      added,
      updated,
      removed: staleIds.length,
      total: files.length,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

export async function closeDb(): Promise<void> {
  if (!dbHandle) return;
  try {
    const db = await dbHandle;
    await db.close();
  } catch (err) {
    console.warn('[db] 关闭数据库连接失败：', (err as Error).message);
  } finally {
    dbHandle = null;
  }
}
