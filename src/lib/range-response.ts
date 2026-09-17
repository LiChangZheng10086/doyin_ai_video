import type { Readable } from "node:stream";
import type { Request, Response } from "express";

/**
 * 一个可被 Range 请求分段发送的目标。
 *
 * 抽成结构类型是为了让「成片视频」与「素材文件」共用同一份实现 —— 它们各自提供
 * 一个已打开的句柄（成片是为了防止路径被替换，素材是为了避免重复 stat）。
 */
export interface RangeServeTarget {
  size: number;
  mimeType: string;
  createReadStream(options: { start: number; end: number; autoClose: boolean }): Readable;
  close(): Promise<void>;
}

/**
 * 按 Range 语义发送文件：支持 `206` + `Content-Range`、`HEAD`、以及越界 `416`。
 *
 * 音频试听要能拖动进度条，图片预览要能按段取，都依赖这里。
 */
export async function sendRangeResponse(
  req: Request,
  res: Response,
  target: RangeServeTarget,
  downloadFilename?: string,
): Promise<void> {
  try {
    res.setHeader("Accept-Ranges", "bytes");
    if (downloadFilename) res.attachment(downloadFilename);
    else res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Type", target.mimeType);

    const parsedRange = req.headers.range ? req.range(target.size, { combine: true }) : undefined;
    if (parsedRange === -1 || parsedRange === -2) {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${target.size}`);
      res.end();
      return;
    }

    const range = Array.isArray(parsedRange) && parsedRange.length === 1 ? parsedRange[0] : undefined;
    const start = range?.start ?? 0;
    const end = range?.end ?? target.size - 1;
    if (range) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${target.size}`);
    }
    res.setHeader("Content-Length", String(end - start + 1));
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = target.createReadStream({ start, end, autoClose: false });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        res.off("finish", onFinish);
        res.off("close", onClose);
        stream.off("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onFinish = () => settle();
      const onClose = () => {
        if (!res.writableFinished) stream.destroy();
        settle();
      };
      const onError = (error: Error) => settle(error);
      res.once("finish", onFinish);
      res.once("close", onClose);
      stream.once("error", onError);
      stream.pipe(res);
    });
  } finally {
    await target.close().catch(() => undefined);
  }
}
