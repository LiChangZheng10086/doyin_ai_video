/**
 * 今日头条封面处理：把任意比例的图裁成平台要的 **16:9（1280×720）JPEG**。
 *
 * 为什么必须自己裁：我们的场景静帧是 1080×1920 竖图，直接交给头条只会被系统随机裁
 * （与公众号封面必须自己裁成 2.35:1 同理，见 spec §2）。
 *
 * 与 `wechat-media.ts` 的关系：ffmpeg 管线形状相同，但**错误码与平台常量各自独立**。
 * 刻意不去改 `wechat-media.ts` —— 它是暂停中的公众号特性的已测模块，其 `wechat_media_*`
 * 错误码与文案被 14 个用例逐字断言；为头条改它的契约，风险大于收益（spec §3.4 记了这条取舍）。
 */

import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command.js";
import { TOUTIAO_ARTICLE_LIMITS } from "./toutiao-article.js";

/**
 * 源图大小的兜底上限。
 *
 * 与 `wechat-media.ts` 的 `MAX_SOURCE_IMAGE_BYTES` **同口径**（同一批输入：场景静帧与素材库图片，
 * 后者上传上限就是 20MB）：超过这个数的输入必然是别处来的异常文件，明确报错而不是默默啃。
 * 两个常量相等这件事有专门的用例守住，防止两处数字悄悄漂移。
 */
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

/** 包内封面文件名：与 article 包目录约定一致（`wechat-cover.jpg` 是公众号那一份）。 */
export const TOUTIAO_COVER_FILE_NAME = "cover.jpg";

const IMAGE_TIMEOUT_MS = 120_000;

export type ToutiaoMediaErrorCode =
  | "toutiao_media_ffmpeg_unavailable"
  | "toutiao_media_source_missing"
  | "toutiao_media_source_too_large"
  | "toutiao_media_ffmpeg_failed"
  | "toutiao_media_too_large_after_compress";

export class ToutiaoMediaError extends Error {
  readonly status = 422;

  constructor(
    readonly code: ToutiaoMediaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToutiaoMediaError";
  }
}

export interface ToutiaoMediaCommandRunner {
  run(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      captureStdout?: boolean;
      captureStderr?: boolean;
      timeoutMs?: number;
    },
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface ToutiaoMediaConfig {
  /** ffmpeg 可执行文件；缺省用 PATH 里的 `ffmpeg`（与 `media.ts` 同一口径）。 */
  ffmpegBinary?: string;
  /** 注入子进程执行器（测试用假 ffmpeg）。 */
  commandRunner?: ToutiaoMediaCommandRunner;
  timeoutMs?: number;
}

export interface PreparedToutiaoCover {
  /** 产物绝对路径（已落盘、已校验大小）。 */
  path: string;
  bytes: number;
}

export class ToutiaoMediaService {
  private readonly runner: ToutiaoMediaCommandRunner;

  constructor(private readonly config: ToutiaoMediaConfig = {}) {
    this.runner = config.commandRunner ?? { run: runCommand };
  }

  /** 等比放大到覆盖 1280×720 再居中裁切，保证构图居中而不是被平台随机裁。 */
  async prepareCoverImage(srcPath: string, outDir: string): Promise<PreparedToutiaoCover> {
    const binary = this.requireBinary();
    await this.assertReadableSource(srcPath);

    const target = path.join(outDir, TOUTIAO_COVER_FILE_NAME);
    const { coverWidth, coverHeight, coverBytes } = TOUTIAO_ARTICLE_LIMITS;
    const filter = `scale=${coverWidth}:${coverHeight}:force_original_aspect_ratio=increase,crop=${coverWidth}:${coverHeight}`;
    const args = ["-y", "-i", srcPath, "-vf", filter, "-frames:v", "1", "-q:v", "3", target];

    await this.execute(binary, args, target);
    const bytes = await this.readProducedBytes(target);
    if (bytes > coverBytes) {
      await this.discard(target);
      throw new ToutiaoMediaError(
        "toutiao_media_too_large_after_compress",
        `封面处理结果为 ${formatBytes(bytes)}，超过头条封面 ${formatBytes(coverBytes)} 的上限。`,
      );
    }
    return { path: target, bytes };
  }

  private async execute(binary: string, args: string[], target: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await this.runner.run(binary, args, {
        captureStderr: true,
        timeoutMs: this.config.timeoutMs ?? IMAGE_TIMEOUT_MS,
      });
    } catch (error) {
      await this.discard(target);
      throw new ToutiaoMediaError("toutiao_media_ffmpeg_failed", describeFfmpegFailure(binary, error));
    }
  }

  private async readProducedBytes(target: string): Promise<number> {
    try {
      return (await stat(target)).size;
    } catch {
      // ffmpeg 退出码 0 但没产出文件：这种情况必须报错，不能当成「0 字节的成功」。
      throw new ToutiaoMediaError(
        "toutiao_media_ffmpeg_failed",
        `ffmpeg 执行成功但没有产出图片文件（${path.basename(target)}）。`,
      );
    }
  }

  private async discard(target: string): Promise<void> {
    await rm(target, { force: true }).catch(() => undefined);
  }

  private async assertReadableSource(srcPath: string): Promise<void> {
    let info;
    try {
      info = await stat(srcPath);
    } catch {
      throw new ToutiaoMediaError("toutiao_media_source_missing", `找不到要处理的图片：${srcPath}`);
    }
    if (!info.isFile()) {
      throw new ToutiaoMediaError("toutiao_media_source_missing", `要处理的图片不是文件：${srcPath}`);
    }
    if (info.size > MAX_SOURCE_IMAGE_BYTES) {
      throw new ToutiaoMediaError(
        "toutiao_media_source_too_large",
        `源图 ${formatBytes(info.size)} 超过 ${formatBytes(MAX_SOURCE_IMAGE_BYTES)} 的处理上限（素材库图片上限为 20MB）：请换一张更小的图片。`,
      );
    }
  }

  private requireBinary(): string {
    const configured = this.config.ffmpegBinary;
    if (configured !== undefined && configured.trim().length === 0) {
      throw new ToutiaoMediaError(
        "toutiao_media_ffmpeg_unavailable",
        "未配置 ffmpeg（ffmpegBinary / FFMPEG_BINARY 为空），无法处理封面；请安装 ffmpeg 或在配置里给出它的路径后重试。",
      );
    }
    return configured?.trim() ?? "ffmpeg";
  }
}

function describeFfmpegFailure(binary: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `ffmpeg（${binary}）处理封面失败：${truncate(detail, 500)}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
