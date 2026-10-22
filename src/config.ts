import fs from 'node:fs';
import path from 'node:path';

/**
 * 零依赖读取 .env。
 * 自己解析而不用 process.loadEnvFile，原因有二：
 * 1. 老版本 Node 没有该 API；
 * 2. Windows 编辑器常保存为带 BOM 的 UTF-8，内置解析会把首个键读成 "\uFEFFAPP_PASSWORD"。
 * 已存在的环境变量不会被覆盖，方便在 Docker / PM2 中直接注入。
 */
function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.warn(`[config] 读取 ${file} 失败：${(err as Error).message}`);
    return;
  }

  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;

    const key = match[1];
    let value = match[2];

    if (value.startsWith('"')) {
      const end = value.lastIndexOf('"');
      if (end > 0) {
        value = value.slice(1, end).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
      }
    } else if (value.startsWith("'")) {
      const end = value.lastIndexOf("'");
      if (end > 0) value = value.slice(1, end);
    } else {
      // 去掉行尾注释：只有空白 + # 之后的内容才算注释
      value = value.replace(/\s+#.*$/, '').trim();
    }

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const cwd = process.cwd();

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[config] ${name}=${raw} 不合法，已回退到 ${fallback}`);
    return fallback;
  }
  return value;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** 相对路径统一基于项目根目录（即启动进程的工作目录）解析。 */
function resolvePath(value: string | undefined, fallback: string): string {
  return path.resolve(cwd, (value ?? '').trim() || fallback);
}

/** 从 package.json 读取版本号，直接 `node dist/server.js` 时也能拿到正确值。 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return process.env.npm_package_version ?? '0.0.0';
  }
}

const password = (process.env.APP_PASSWORD ?? '').trim();

if (!password) {
  console.error(
    [
      'ERROR: 缺少访问密码 APP_PASSWORD。',
      '  方式一：在项目根目录创建 .env 并写入 APP_PASSWORD=你的密码（可参考 .env.example）',
      '  方式二：启动前设置环境变量，例如  $env:APP_PASSWORD="你的密码"  /  export APP_PASSWORD=你的密码',
    ].join('\n')
  );
  process.exit(1);
}

if (password.length < 8) {
  console.warn('[config] APP_PASSWORD 少于 8 位，公网部署时存在被暴力破解的风险');
}

/*
 * HTTPS 是可选的：TLS_CERT 与 TLS_KEY 必须同时配置。
 * 之所以在这里就报错退出，是为了避免服务先启动、扫描完图片、
 * 直到 listen 时才因为证书路径写错而失败。
 */
const tlsCert = (process.env.TLS_CERT ?? '').trim();
const tlsKey = (process.env.TLS_KEY ?? '').trim();

if (Boolean(tlsCert) !== Boolean(tlsKey)) {
  console.error(
    [
      'ERROR: TLS_CERT 与 TLS_KEY 必须同时配置。',
      '  启用 HTTPS：两项都指向证书文件，例如',
      '    TLS_CERT=./certs/cert.pem',
      '    TLS_KEY=./certs/key.pem',
      '  保持 HTTP：两项都留空。',
      '  生成自签证书：powershell -ExecutionPolicy Bypass -File ./scripts/new-cert.ps1 <公网IP或域名>',
    ].join('\n')
  );
  process.exit(1);
}

export const config = {
  port: readInt('PORT', 3000, 1, 65535),
  host: (process.env.HOST ?? '').trim() || '0.0.0.0',
  /** 图片库目录（即浏览到的原始图片所在目录） */
  imagesDir: resolvePath(process.env.IMAGES_DIR, 'images'),
  /** 回收站目录，删除图片时会移动到这里 */
  trashDir: resolvePath(process.env.TRASH_DIR, 'remove'),
  /** SQLite 数据库文件 */
  dbPath: resolvePath(process.env.DB_PATH, 'imgbrowser.db'),
  /** 静态资源目录 */
  publicDir: resolvePath(undefined, 'public'),
  password,
  /** 会话有效期（小时） */
  sessionTtlHours: readInt('SESSION_TTL_HOURS', 24, 1, 24 * 30),
  /** 单页最大条数，防止一次拉取过多数据 */
  maxLimit: readInt('MAX_PAGE_SIZE', 100, 1, 1000),
  defaultLimit: readInt('DEFAULT_PAGE_SIZE', 24, 1, 1000),
  /** 部署在 Nginx 等反向代理之后时设为 1，才能拿到真实 IP 与 https 协议 */
  trustProxy: readBool('TRUST_PROXY', false),
  /** TLS 证书路径；为空表示不启用 HTTPS */
  tlsCert: tlsCert ? resolvePath(tlsCert, '') : '',
  /** TLS 私钥路径；与 tlsCert 同时为空或同时非空 */
  tlsKey: tlsKey ? resolvePath(tlsKey, '') : '',
  /** 私钥口令；openssl -nodes 生成的私钥不需要 */
  tlsPassphrase: process.env.TLS_KEY_PASSPHRASE ?? '',
  isProduction: process.env.NODE_ENV === 'production',
  version: readVersion(),
} as const;

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.avif']);
