import { open } from "node:fs/promises";
import { Router, type Express, type NextFunction, type Request, type Response } from "express";
import multer, { MulterError } from "multer";
import { AssetError, type AssetKind, type AssetStore } from "./assets-store.js";
import { sendRangeResponse } from "./range-response.js";

export interface AssetRouteDeps {
  assets: AssetStore;
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
      res.json({ assets: await deps.assets.list(kindParam) });
    } catch (error) {
      next(error);
    }
  });

  for (const [route, kind] of Object.entries(KIND_BY_ROUTE)) {
    router.post(`/assets/${route}`, upload.array("files"), async (req, res, next) => {
      try {
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        if (files.length === 0) {
          res.status(400).json({ code: "asset_files_required", message: "请至少选择一个文件" });
          return;
        }

        const created = [];
        for (const file of files) {
          created.push(await deps.assets.add(kind, {
            originalName: decodeMultipartFilename(file.originalname),
            data: file.buffer,
          }));
        }
        res.status(201).json({ assets: created });
      } catch (error) {
        next(error);
      }
    });
  }

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
  if (error instanceof AssetError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof MulterError) {
    // LIMIT_FILE_SIZE 是明确的「太大」；文件数超限属于请求本身不合法
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const message = error.code === "LIMIT_FILE_SIZE" ? "文件超出大小上限" : "上传的文件数量超出上限";
    res.status(status).json({ code: `asset_upload_${error.code.toLowerCase()}`, message });
    return;
  }
  next(error);
}

export { body as assetRequestBody };
