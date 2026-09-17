import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LocalStorage } from "./storage.js";

export type AssetKind = "image" | "audio";

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  /** 磁盘上的文件名：服务端生成的 uuid + 白名单扩展名。绝不采用客户端提供的名字。 */
  filename: string;
  /** 客户端上传时的原始文件名，仅用于展示。 */
  originalName: string;
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  createdAt: string;
}

export type AssetErrorCode =
  | "asset_extension_forbidden"
  | "asset_too_large"
  | "asset_kind_mismatch";

const ASSET_ERROR_MESSAGES: Record<AssetErrorCode, string> = {
  asset_extension_forbidden: "不支持的文件类型",
  asset_too_large: "文件超出大小上限",
  asset_kind_mismatch: "文件类型与素材种类不匹配",
};

export class AssetError extends Error {
  constructor(
    readonly code: AssetErrorCode,
    readonly status: number,
    message: string = ASSET_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "AssetError";
  }
}

interface AssetsIndex {
  schemaVersion: 1;
  assets: Record<string, AssetRecord>;
}

const ASSETS_INDEX = "cache/assets-index.json";

const KIND_DIRECTORY: Record<AssetKind, string> = {
  image: path.join("assets", "images"),
  audio: path.join("assets", "audio"),
};

const KIND_EXTENSIONS: Record<AssetKind, ReadonlySet<string>> = {
  image: new Set([".jpg", ".jpeg", ".png", ".webp"]),
  audio: new Set([".mp3", ".wav", ".m4a", ".aac"]),
};

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
};

const MAX_BYTES: Record<AssetKind, number> = {
  image: 20 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
};

export interface ResolvedAssetFile {
  path: string;
  size: number;
  mimeType: string;
  record: AssetRecord;
}

/**
 * 素材库：图片与音频的上传、索引、读取与删除。
 *
 * 安全要点：落盘文件名一律由服务端生成（uuid + 白名单扩展名），客户端提供的名字
 * 只作为 `originalName` 存进索引用于展示，**绝不参与路径拼接**；读取与删除都会校验
 * 解析后的路径仍落在 `assets/` 之内。
 */
export class AssetStore {
  constructor(private readonly storage: LocalStorage) {}

  async add(kind: AssetKind, input: { originalName: string; data: Buffer }): Promise<AssetRecord> {
    const extension = path.extname(input.originalName).toLowerCase();
    const allowedHere = KIND_EXTENSIONS[kind].has(extension);
    const otherKind: AssetKind = kind === "image" ? "audio" : "image";
    // 先区分「种类搞错了」与「类型根本不允许」：前者更常见的成因是把音频当成图片传了
    if (!allowedHere && KIND_EXTENSIONS[otherKind].has(extension)) {
      throw new AssetError("asset_kind_mismatch", 415);
    }
    if (!allowedHere) {
      throw new AssetError("asset_extension_forbidden", 415);
    }
    if (input.data.byteLength > MAX_BYTES[kind]) {
      throw new AssetError("asset_too_large", 413);
    }

    const id = randomUUID();
    const filename = `${id}${extension}`;
    const directory = KIND_DIRECTORY[kind];
    await mkdir(this.storage.resolve(directory), { recursive: true });
    await writeFile(this.storage.resolve(directory, filename), input.data);

    const record: AssetRecord = {
      id,
      kind,
      filename,
      originalName: input.originalName,
      bytes: input.data.byteLength,
      createdAt: new Date().toISOString(),
      ...(kind === "image" ? readImageSize(input.data) : readAudioDuration(input.data)),
    };

    const index = await this.readIndex();
    index.assets[id] = record;
    await this.storage.writeJsonAtomic(ASSETS_INDEX, index);
    return record;
  }

  async list(kind?: AssetKind): Promise<AssetRecord[]> {
    const index = await this.readIndex();
    return Object.values(index.assets)
      .filter((record) => (kind ? record.kind === kind : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async get(id: string): Promise<AssetRecord | null> {
    const index = await this.readIndex();
    return index.assets[id] ?? null;
  }

  async remove(id: string): Promise<boolean> {
    const index = await this.readIndex();
    const record = index.assets[id];
    if (!record) return false;

    delete index.assets[id];
    await this.storage.writeJsonAtomic(ASSETS_INDEX, index);
    const filePath = this.filePathFor(record);
    if (filePath) await rm(filePath, { force: true }).catch(() => undefined);
    return true;
  }

  async resolveFile(id: string): Promise<ResolvedAssetFile | null> {
    const record = await this.get(id);
    if (!record) return null;

    const filePath = this.filePathFor(record);
    if (!filePath) return null;
    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) return null;
      return {
        path: filePath,
        size: stats.size,
        mimeType: MIME_TYPES[path.extname(record.filename).toLowerCase()] ?? "application/octet-stream",
        record,
      };
    } catch {
      return null;
    }
  }

  /** 把记录解析成绝对路径，并确认它仍落在 assets 目录内（防越界的最后一道）。 */
  private filePathFor(record: AssetRecord): string | null {
    const directory = this.storage.resolve(KIND_DIRECTORY[record.kind]);
    const candidate = path.resolve(directory, record.filename);
    const relative = path.relative(directory, candidate);
    if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return null;
    }
    return candidate;
  }

  private async readIndex(): Promise<AssetsIndex> {
    try {
      const index = await this.storage.readJson<AssetsIndex>(ASSETS_INDEX);
      if (!index || typeof index !== "object" || typeof index.assets !== "object" || index.assets === null) {
        return { schemaVersion: 1, assets: {} };
      }
      return index;
    } catch {
      return { schemaVersion: 1, assets: {} };
    }
  }
}

/** PNG / JPEG 头部尺寸解析；无法识别时返回空对象（尺寸是可选元数据）。 */
function readImageSize(data: Buffer): { width?: number; height?: number } {
  return readPngSize(data) ?? readJpegSize(data) ?? {};
}

function readPngSize(data: Buffer): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.byteLength < 24) return null;
  if (!signature.every((byte, index) => data[index] === byte)) return null;
  if (data.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function readJpegSize(data: Buffer): { width: number; height: number } | null {
  if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.byteLength) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    const segmentLength = data.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

/** WAV 时长可由 fmt/data 两个 chunk 直接算出；其它音频容器暂不解析。 */
function readAudioDuration(data: Buffer): { durationMs?: number } {
  if (data.byteLength < 44) return {};
  if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") return {};

  let offset = 12;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= data.byteLength) {
    const chunkId = data.toString("ascii", offset, offset + 4);
    const chunkSize = data.readUInt32LE(offset + 4);
    if (chunkId === "fmt " && offset + 8 + 16 <= data.byteLength) {
      byteRate = data.readUInt32LE(offset + 16);
    }
    if (chunkId === "data") {
      dataBytes = Math.min(chunkSize, data.byteLength - offset - 8);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (!byteRate || dataBytes === undefined || byteRate <= 0) return {};
  return { durationMs: Math.round((dataBytes / byteRate) * 1000) };
}
