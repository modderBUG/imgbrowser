import fsp from 'node:fs/promises';

export interface ImageSize {
  width: number;
  height: number;
}

/** 只需要文件头，64KB 足以覆盖 JPEG 的 APPn 段、WebP 的 VP8X/VP8L 头。 */
const HEADER_BYTES = 64 * 1024;

function isSize(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < 1_000_000;
}

/**
 * 从图片文件头解析出宽高，避免为拿尺寸而解码整张图。
 * 解析失败（损坏、未知格式）返回 null，调用方按"未知尺寸"处理。
 */
export async function readImageSize(filePath: string): Promise<ImageSize | null> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return parseSize(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseSize(buf: Buffer): ImageSize | null {
  const size = parsePng(buf) ?? parseJpeg(buf) ?? parseGif(buf) ?? parseBmp(buf) ?? parseWebp(buf);
  return size && isSize(size.width) && isSize(size.height) ? size : null;
}

function parsePng(buf: Buffer): ImageSize | null {
  // 89 50 4E 47 0D 0A 1A 0A，IHDR 紧跟头部
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseGif(buf: Buffer): ImageSize | null {
  if (buf.length < 10) return null;
  const magic = buf.toString('ascii', 0, 6);
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function parseBmp(buf: Buffer): ImageSize | null {
  if (buf.length < 26 || buf.readUInt16LE(0) !== 0x4d42) return null;
  // 高度可能为负（自上而下存储）
  return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
}

function parseJpeg(buf: Buffer): ImageSize | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buf[offset + 1];
    // 填充字节
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 无长度的标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    // 扫描数据已经开始，说明没找到 SOF
    if (marker === 0xda) return null;

    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;

    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }

    offset += 2 + segmentLength;
  }
  return null;
}

function parseWebp(buf: Buffer): ImageSize | null {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;

  const chunk = buf.toString('ascii', 12, 16);

  if (chunk === 'VP8 ') {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }

  if (chunk === 'VP8X') {
    return {
      width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
      height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
    };
  }

  return null;
}
