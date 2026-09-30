import { open } from "node:fs/promises";
import { Router, type Express, type NextFunction, type Request, type Response } from "express";
import multer, { MulterError } from "multer";
import { AssetError, searchImageAssets, validateImageMetadata, type AssetKind, type AssetStore } from "./assets-store.js";
import { ImagePromptError, type ImagePromptService } from './image-prompts.js';
import { LocalAuthError, requireActor, type LocalSessionStore } from './local-auth.js';
import { sendRangeResponse } from "./range-response.js";

export interface AssetRouteDeps {
  assets: AssetStore;
  prompts?: ImagePromptService;
  sessions?: LocalSessionStore;
  /** 上传限额，测试可注入更小的值以免构造大文件。 */
  limits?: { maxFileBytes?: number; maxFiles?: number };
}

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024; // 与 store 里音频上限一致，逐 kind 的细限由 store 兜底
const DEFAULT_MAX_FILES = 20;

const KIND_BY_ROUTE: Record<string, AssetKind> = {
  images: "image",
  audio: "audio",
};

function body(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

/**
 * 修正 multipart 文件名的编码。
 *
 * busboy/multer 按 latin1 解码 `filename`，所以「封面.png」会变成 `å°\x81é\x9D¢.png`。
 * 只在确实像乱码时才回退转换，避免把本来就是合法 UTF-8 的名字二次破坏：
 * 纯 ASCII 不动；已经含 latin1 之外字符的说明已是正确 UTF-8，也不动。
 */
export function decodeMultipartFilename(name: string): string {
  if (!/[\u0080-\u00ff]/u.test(name)) return name;
  if (/[^\u0000-\u00ff]/u.test(name)) return name;
  return Buffer.from(name, "latin1").toString("utf8");
}

/**
 * 素材库路由：上传、列表、原文件预览（支持 Range）、删除。
 *
 * 上传走 multer 的 memoryStorage，再用 `AssetStore` 落盘 —— 白名单、大小、种类
 * 校验集中在 store 一层，路由只负责把错误映射成 HTTP 状态码。
 */
export function registerAssetRoutes(app: Express, deps: AssetRouteDeps): void {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: deps.limits?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      files: deps.limits?.maxFiles ?? DEFAULT_MAX_FILES,
    },
  });

  router.get("/assets", async (req, res, next) => {
    try {
      const kindParam = typeof req.query.kind === "string" ? req.query.kind : undefined;
      if (kindParam !== undefined && kindParam !== "image" && kindParam !== "audio") {
        res.status(400).json({ code: "asset_kind_invalid", message: "素材种类无效" });
        return;
      }
      const query = req.query.q;
      if (query !== undefined && (typeof query !== 'string' || (kindParam !== 'image' && query !== ''))) throw new AssetError('asset_metadata_invalid', 400, '图片搜索参数无效');
      const all = await deps.assets.list(kindParam);
      res.json({ assets: query === undefined ? all : searchImageAssets(all, query), total: all.length });
    } catch (error) {
      next(error);
    }
  });

  for (const [route, kind] of Object.entries(KIND_BY_ROUTE)) {
    const parser = kind === 'image' ? multer({ storage: multer.memoryStorage(), limits: {
      fileSize: deps.limits?.maxFileBytes ?? 20 * 1024 * 1024, files: deps.limits?.maxFiles ?? DEFAULT_MAX_FILES,
      fieldSize: 1024 * 1024, fields: 3,
    } }).array('files') : upload.array('files');
    router.post(`/assets/${route}`, parser, async (req, res, next) => {
      try {
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        if (files.length === 0) {
          res.status(400).json({ code: "asset_files_required", message: "请至少选择一个文件" });
          return;
        }

        const input = body(req);
        const hasMetadata = Object.keys(input).length > 0;
        if (kind === 'audio' && hasMetadata) throw new AssetError('asset_metadata_invalid', 400, '音频不接受图片元数据');
        if (hasMetadata) {
          if (!deps.sessions) throw new LocalAuthError('local_session_required', 401, '本机会话不可用');
          await new Promise<void>((resolve, reject) => requireActor(deps.sessions!)(req, res, e => e ? reject(e) : resolve()));
          if (Object.keys(input).some(key => !['metadata', 'imagePromptId', 'imagePromptVersion'].includes(key))) throw new AssetError('asset_metadata_invalid', 400);
        }
        let metadata = files.map(() => ({} as ReturnType<typeof validateImageMetadata>));
        if (input.metadata !== undefined) {
          let values: unknown; try { values = typeof input.metadata === 'string' ? JSON.parse(input.metadata) : undefined; } catch { /* Invalid below. */ }
          if (!Array.isArray(values) || values.length !== files.length) throw new AssetError('asset_metadata_invalid', 400, '图片信息必须与文件数量和顺序一致');
          metadata = values.map(validateImageMetadata);
        }
        let snapshot;
        if (input.imagePromptId !== undefined || input.imagePromptVersion !== undefined) {
          if (typeof input.imagePromptId !== 'string' || typeof input.imagePromptVersion !== 'string' || !/^[1-9]\d*$/.test(input.imagePromptVersion)) throw new AssetError('asset_metadata_invalid', 400, '提示词绑定参数无效');
          if (!deps.prompts) throw new AssetError('asset_metadata_invalid', 400, '提示词服务不可用');
          if (metadata.some(item => item.generationPrompt !== undefined)) throw new AssetError('asset_metadata_invalid', 400, '绑定上传请先保存草稿中的最终提示词');
          snapshot = await deps.prompts.snapshot(input.imagePromptId, Number(input.imagePromptVersion));
        }
        const created = []; const failures: Array<{ index: number; code: string; message: string }> = [];
        let failureStatus = 400;
        for (const [index, file] of files.entries()) {
          try { created.push(await deps.assets.add(kind, { originalName: decodeMultipartFilename(file.originalname), data: file.buffer,
            ...(kind === 'image' ? { metadata: metadata[index], imagePrompt: snapshot } : {}),
          })); }
          catch (e) {
            if (kind === 'audio') throw e;
            failureStatus = e instanceof AssetError ? e.status : 500;
            failures.push({ index, code: e instanceof AssetError ? e.code : 'asset_upload_failed',
              message: e instanceof AssetError ? e.message : '图片保存失败，请检查本地存储' });
            if (!(e instanceof AssetError)) {
              for (let i = index + 1; i < files.length; i++) failures.push({ index: i, code: 'asset_upload_not_attempted', message: '存储失败后未继续上传' });
              break;
            }
          }
        }
        res.status(failures.length ? (created.length ? 200 : failureStatus) : 201).json({ assets: created,
          ...(failures.length ? { failures, ...(!created.length ? { code: failures[0].code, message: failures[0].message } : {}) } : {}),
        });
      } catch (error) {
        next(error);
      }
    });
  }

  router.patch('/assets/:id/metadata', async (req, res, next) => {
    try {
      if (!deps.sessions) throw new LocalAuthError('local_session_required', 401, '本机会话不可用');
      await new Promise<void>((resolve, reject) => requireActor(deps.sessions!)(req, res, e => e ? reject(e) : resolve()));
      res.json({ asset: await deps.assets.updateImageMetadata(req.params.id, req.body) });
    } catch (e) { next(e); }
  });

  router.get("/assets/:id/raw", async (req, res, next) => {
    try {
      const resolved = await deps.assets.resolveFile(req.params.id);
      if (!resolved) {
        res.status(404).json({ message: "asset not found" });
        return;
      }

      const handle = await open(resolved.path, "r");
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size === 0) {
          res.status(404).json({ message: "asset not found" });
          return;
        }
        await sendRangeResponse(req, res, {
          size: stats.size,
          mimeType: resolved.mimeType,
          createReadStream: (options) => handle.createReadStream(options),
          close: async () => {
            await handle.close();
          },
        });
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  router.delete("/assets/:id", async (req, res, next) => {
    try {
      const removed = await deps.assets.remove(req.params.id);
      if (!removed) {
        res.status(404).json({ message: "asset not found" });
        return;
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use("/api", router);
  app.use("/api/assets", assetErrorHandler);
}

function assetErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof AssetError || error instanceof ImagePromptError || error instanceof LocalAuthError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof MulterError) {
    // LIMIT_FILE_SIZE 是明确的「太大」；文件数超限属于请求本身不合法
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const message = error.code === "LIMIT_FILE_SIZE" ? "文件超出大小上限" : "上传的文件或文字字段超出上限";
    res.status(status).json({ code: `asset_upload_${error.code.toLowerCase()}`, message });
    return;
  }
  if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
    res.status(400).json({ code: 'asset_metadata_invalid', message: '请求 JSON 无效' }); return;
  }
  next(error);
}

export { body as assetRequestBody };
