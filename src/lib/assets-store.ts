import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LocalStorage } from "./storage.js";
import { promptText, promptTags, promptVersion, type ImagePromptRecord } from './image-prompts.js';

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
  description?: string;
  tags?: string[];
  generationPrompt?: string;
  imagePromptId?: string;
  imagePromptVersion?: number;
  metadataVersion?: number;
  createdAt: string;
}

export interface ImageAssetMetadata { description?: string; tags?: string[]; generationPrompt?: string; }
export function validateImageMetadata(value: unknown): ImageAssetMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['description', 'tags', 'generationPrompt'].includes(key))) {
    throw new AssetError('asset_metadata_invalid', 400);
  }
  const input = value as Record<string, unknown>; const metadata: ImageAssetMetadata = {};
  try {
    if (input.description !== undefined) metadata.description = promptText(input.description, 1000, '图片描述');
    if (input.tags !== undefined) metadata.tags = promptTags(input.tags);
    if (input.generationPrompt !== undefined) metadata.generationPrompt = promptText(input.generationPrompt, 8000, '最终提示词');
  } catch (e) { throw new AssetError('asset_metadata_invalid', 400, (e as Error).message); }
  return metadata;
}

export function searchImageAssets(records: AssetRecord[], value: unknown): AssetRecord[] {
  if (value === undefined) return records;
  let query: string;
  try { query = promptText(value, 200, '搜索关键词').toLowerCase(); }
  catch { throw new AssetError('asset_metadata_invalid', 400, '搜索关键词无效或超过 200 字符'); }
  if (!query) return records;
  const words = [...new Set(query.split(/\s+/u))];
  const matches = records.filter(record => record.kind === 'image').map(record => {
    const actual = [record.description ?? '', ...(record.tags ?? [])].map(x => x.toLowerCase());
    const fields = [...actual, record.originalName.toLowerCase(), (record.generationPrompt ?? '').toLowerCase()];
    return { record, matched: words.every(word => fields.some(text => text.includes(word))),
      score: words.filter(word => actual.some(text => text.includes(word))).length };
  });
  return matches.filter(x => x.matched).sort((a, b) => b.score - a.score
    || b.record.createdAt.localeCompare(a.record.createdAt) || a.record.id.localeCompare(b.record.id)).map(x => x.record);
}

export type AssetErrorCode =
  | "asset_extension_forbidden"
  | "asset_too_large"
  | "asset_metadata_invalid"
  | "asset_version_conflict"
  | "asset_not_found"
  | "asset_kind_mismatch";

const ASSET_ERROR_MESSAGES: Record<AssetErrorCode, string> = {
  asset_extension_forbidden: "不支持的文件类型",
  asset_too_large: "文件超出大小上限",
  asset_kind_mismatch: "文件类型与素材种类不匹配",
  asset_metadata_invalid: '图片元数据无效',
  asset_version_conflict: '图片信息已变更，请刷新核对；本次输入已保留',
  asset_not_found: '素材不存在',
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
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: LocalStorage) {}

  // ponytail: one local index; serialize writes, use transactions for multi-process writers.
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.writes.then(action);
    this.writes = operation.catch(() => {});
    return operation;
  }

  add(kind: AssetKind, input: { originalName: string; data: Buffer;
    metadata?: ImageAssetMetadata; imagePrompt?: Pick<ImagePromptRecord, 'id' | 'version' | 'prompt'> }): Promise<AssetRecord> {
    return this.mutate(async () => {
    if (kind !== 'image' && (input.metadata !== undefined || input.imagePrompt !== undefined)) throw new AssetError('asset_metadata_invalid', 400, '音频不接受图片元数据');
    const metadata = input.metadata === undefined ? {} : validateImageMetadata(input.metadata);
      const index = await this.readIndex();
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

      const record: AssetRecord = {
        id,
        kind,
        filename,
        originalName: input.originalName,
        bytes: input.data.byteLength,
        createdAt: new Date().toISOString(),
        ...(kind === "image" ? readImageSize(input.data) : readAudioDuration(input.data)),
      ...(kind === 'image' ? { ...metadata, metadataVersion: 1 } : {}),
      ...(input.imagePrompt ? { imagePromptId: input.imagePrompt.id, imagePromptVersion: input.imagePrompt.version, generationPrompt: input.imagePrompt.prompt } : {}),
      };

      index.assets[id] = record;
      try {
        await writeFile(this.storage.resolve(directory, filename), input.data);
        await this.storage.writeJsonAtomic(ASSETS_INDEX, index);
      }
      catch (error) { await rm(this.storage.resolve(directory, filename), { force: true }).catch(() => undefined); throw error; }
      return record;
    });
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

  updateImageMetadata(id: string, value: unknown): Promise<AssetRecord> {
    return this.mutate(async () => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetError('asset_metadata_invalid', 400);
      const { version, ...fields } = value as Record<string, unknown>;
      let expected: number;
      try { expected = promptVersion(version); } catch { throw new AssetError('asset_metadata_invalid', 400, '请提供当前版本'); }
      const metadata = validateImageMetadata(fields); const index = await this.readIndex();
      const record = Object.hasOwn(index.assets, id) ? index.assets[id] : undefined;
      if (!record) throw new AssetError('asset_not_found', 404);
      if (record.kind !== 'image') throw new AssetError('asset_metadata_invalid', 400, '仅图片可编辑这些信息');
      if ((record.metadataVersion ?? 1) !== expected) throw new AssetError('asset_version_conflict', 409);
      Object.assign(record, metadata); record.metadataVersion = expected + 1;
      if (metadata.generationPrompt !== undefined) { delete record.imagePromptId; delete record.imagePromptVersion; }
      await this.storage.writeJsonAtomic(ASSETS_INDEX, index); return record;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const index = await this.readIndex();
      const record = index.assets[id];
      if (!record) return false;

      delete index.assets[id];
      await this.storage.writeJsonAtomic(ASSETS_INDEX, index);
      const filePath = this.filePathFor(record);
      if (filePath) await rm(filePath, { force: true }).catch(() => undefined);
      return true;
    });
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
      if (!index || index.schemaVersion !== 1 || typeof index.assets !== "object" || index.assets === null || Array.isArray(index.assets)
        || Object.entries(index.assets).some(([id, record]) => !record || record.id !== id || !['image', 'audio'].includes(record.kind)
          || typeof record.filename !== 'string' || typeof record.originalName !== 'string' || !Number.isFinite(record.bytes)
          || typeof record.createdAt !== 'string')) throw new Error('素材索引损坏，请先备份检查，未覆盖原文件');
      for (const record of Object.values(index.assets)) {
        try {
        if (record.metadataVersion !== undefined) promptVersion(record.metadataVersion);
        if (record.kind === 'image') validateImageMetadata({
          ...(record.description !== undefined ? { description: record.description } : {}),
          ...(record.tags !== undefined ? { tags: record.tags } : {}),
          ...(record.generationPrompt !== undefined ? { generationPrompt: record.generationPrompt } : {}),
        });
        } catch { throw new Error('素材索引损坏，请先备份检查，未覆盖原文件'); }
      }
      return index;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { schemaVersion: 1, assets: {} };
      if (error instanceof SyntaxError) throw new Error('素材索引损坏，请先备份检查，未覆盖原文件');
      throw error;
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
