/**
 * 微信公众号图片处理：封面（2.35:1）与正文图（<1MB jpg）。
 *
 * 与项目里 `media.ts` 同模式：把 ffmpeg 包成一层薄封装，`ffmpegBinary` 由调用方注入，
 * 测试用临时目录里的 shell stub 冒充 —— **绝不调用真实 ffmpeg、绝不联网、绝不动用户的源图**。
 *
 * ## 为什么要自己处理（而不是把原图直接传给微信）
 *
 * 官方限额（spec §1.3，逐条核对过文档）：
 *
 * | 用途 | 接口 | 限额 |
 * | --- | --- | --- |
 * | 封面 | `material/add_material` | 图片 **≤10MB**；且 news 封面**裁剪比例只支持 `2.35_1` 与 `1_1`** |
 * | 正文图 | `media/uploadimg` | **仅 jpg/png，必须 <1MB** |
 *
 * 我们的静帧与 `cover.jpg` 都是 1080×1920（9:16），**不裁就上传 = 让系统随机裁封面**；
 * 素材库图片允许 webp 且单张可到 20MB，**不转不压就上传 = 接口直接拒**。
 *
 * ## 两条纪律
 *
 * 1. **源文件只读**：产物一律写到调用方给的目录，绝不改动用户的静帧或素材原图（有用例守住）。
 * 2. **失败不留半成品**：ffmpeg 失败或压不到限额时，把已经写出的产物删掉再抛错 ——
 *    否则包目录里会留下一个看起来正常、其实不完整的图（Task 5 的打包事务也依赖这一点）。
 */

import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { CommandError, runCommand } from "./command.js";

/** 封面尺寸：900 / 383 ≈ 2.35，对应官方唯一支持的 `2.35_1` 裁剪比例。 */
export const WECHAT_COVER_WIDTH = 900;
export const WECHAT_COVER_HEIGHT = 383;
export const WECHAT_COVER_RATIO = "2.35_1";
export const WECHAT_COVER_FILE_NAME = "wechat-cover.jpg";

/**
 * 源图大小的兜底上限。
 *
 * 素材库图片上传上限是 20MB（见 `assets-store.ts` 的 `MAX_BYTES.image`），静帧约 500KB/张，
 * 所以超过这个数的输入必然是别处来的异常文件：**明确报错，而不是默默啃一个可能很大的文件**。
 */
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

const CONTENT_IMAGE_MAX_BYTES = 1024 * 1024;
const COVER_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 120_000;

/**
 * 正文图的降质阶梯：先按长边 1080 压，不够就继续降画质、再降尺寸，直到 <1MB。
 *
 * 只降画质不降尺寸对某些图无效（噪声多的照片压不动），所以两轴都动。
 */
const CONTENT_IMAGE_LADDER: ReadonlyArray<{ maxLongEdge: number; quality: number }> = [
  { maxLongEdge: 1080, quality: 4 },
  { maxLongEdge: 1080, quality: 7 },
  { maxLongEdge: 900, quality: 9 },
  { maxLongEdge: 720, quality: 11 },
];

export type WechatMediaErrorCode =
  | "wechat_media_ffmpeg_unavailable"
  | "wechat_media_source_missing"
  | "wechat_media_source_too_large"
  | "wechat_media_ffmpeg_failed"
  | "wechat_media_too_large_after_compress";

export class WechatMediaError extends Error {
  readonly status = 422;

  constructor(
    readonly code: WechatMediaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WechatMediaError";
  }
}

export interface WechatMediaCommandRunner {
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

export interface WechatMediaConfig {
  /** ffmpeg 可执行文件；缺省用 PATH 里的 `ffmpeg`（与 `media.ts` 同一口径）。 */
  ffmpegBinary?: string;
  /** 注入子进程执行器（测试用假 ffmpeg）。 */
  commandRunner?: WechatMediaCommandRunner;
  timeoutMs?: number;
}

export interface PreparedWechatImage {
  /** 产物绝对路径（已落盘、已校验大小）。 */
  path: string;
  bytes: number;
}

/** 正文图文件名：`01.jpg`、`12.jpg` —— 与图文包 `images/NN` 同一套零填充排序约定。 */
export function contentImageFileName(index: number): string {
  const safe = Number.isFinite(index) && index > 0 ? Math.floor(index) : 1;
  return `${String(safe).padStart(2, "0")}.jpg`;
}

export class WechatMediaService {
  private readonly runner: WechatMediaCommandRunner;

  constructor(private readonly config: WechatMediaConfig = {}) {
    this.runner = config.commandRunner ?? { run: runCommand };
  }

  /** 封面：等比放大到覆盖 900×383 再居中裁切，保证构图居中而不是被系统随机裁。 */
  async prepareCoverImage(srcPath: string, outDir: string): Promise<PreparedWechatImage> {
    const binary = this.requireBinary();
    await this.assertReadableSource(srcPath);

    const target = path.join(outDir, WECHAT_COVER_FILE_NAME);
    const filter = `scale=${WECHAT_COVER_WIDTH}:${WECHAT_COVER_HEIGHT}:force_original_aspect_ratio=increase,crop=${WECHAT_COVER_WIDTH}:${WECHAT_COVER_HEIGHT}`;
    const args = ["-y", "-i", srcPath, "-vf", filter, "-frames:v", "1", "-q:v", "3", target];

    await this.execute(binary, args, target);
    const bytes = await this.readProducedBytes(target);
    if (bytes > COVER_MAX_BYTES) {
      await this.discard(target);
      throw new WechatMediaError(
        "wechat_media_too_large_after_compress",
        `封面处理结果为 ${formatBytes(bytes)}，超过微信永久素材 ${formatBytes(COVER_MAX_BYTES)} 的上限。`,
      );
    }
    return { path: target, bytes };
  }

  /** 正文配图：逐级降质直到 <1MB；`index` 为 1 基序号，决定文件名。 */
  async prepareContentImage(
    srcPath: string,
    outDir: string,
    index: number,
  ): Promise<PreparedWechatImage> {
    const binary = this.requireBinary();
    await this.assertReadableSource(srcPath);

    const target = path.join(outDir, contentImageFileName(index));
    let lastBytes = 0;

    for (const step of CONTENT_IMAGE_LADDER) {
      const filter = longEdgeFilter(step.maxLongEdge);
      const args = [
        "-y",
        "-i",
        srcPath,
        "-vf",
        filter,
        "-frames:v",
        "1",
        "-q:v",
        String(step.quality),
        target,
      ];
      await this.execute(binary, args, target);
      lastBytes = await this.readProducedBytes(target);
      if (lastBytes < CONTENT_IMAGE_MAX_BYTES) {
        return { path: target, bytes: lastBytes };
      }
      // 本轮产物超限：删掉再试下一档，绝不把超限的图留在包目录里。
      await this.discard(target);
    }

    throw new WechatMediaError(
      "wechat_media_too_large_after_compress",
      `正文图压缩到最低档仍为 ${formatBytes(lastBytes)}，超过微信正文图 ${formatBytes(
        CONTENT_IMAGE_MAX_BYTES,
      )}（1MB）的上限：请换一张更简单的图片，或先自行压缩后重试。`,
    );
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
      throw new WechatMediaError("wechat_media_ffmpeg_failed", describeFfmpegFailure(binary, error));
    }
  }

  private async readProducedBytes(target: string): Promise<number> {
    try {
      return (await stat(target)).size;
    } catch {
      // ffmpeg 退出码 0 但没产出文件：这种情况必须报错，不能当成「0 字节的成功」。
      throw new WechatMediaError(
        "wechat_media_ffmpeg_failed",
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
      throw new WechatMediaError("wechat_media_source_missing", `找不到要处理的图片：${srcPath}`);
    }
    if (!info.isFile()) {
      throw new WechatMediaError("wechat_media_source_missing", `要处理的图片不是文件：${srcPath}`);
    }
    if (info.size > MAX_SOURCE_IMAGE_BYTES) {
      throw new WechatMediaError(
        "wechat_media_source_too_large",
        `源图 ${formatBytes(info.size)} 超过 ${formatBytes(MAX_SOURCE_IMAGE_BYTES)} 的处理上限（素材库图片上限为 20MB）：请换一张更小的图片。`,
      );
    }
  }

  private requireBinary(): string {
    const configured = this.config.ffmpegBinary;
    if (configured !== undefined && configured.trim().length === 0) {
      throw new WechatMediaError(
        "wechat_media_ffmpeg_unavailable",
        "未配置 ffmpeg（ffmpegBinary / FFMPEG_BINARY 为空），无法处理图片；请安装 ffmpeg 或在配置里给出它的路径后重试。",
      );
    }
    return configured?.trim() ?? "ffmpeg";
  }
}

/**
 * 限制**长边**的 ffmpeg 滤镜。
 *
 * 不能只写 `scale=1080:-2`：那是限宽不限高，1080×1920 的静帧高度仍是 1920，
 * 等于没压。这里按横竖方向分别取长边。
 */
function longEdgeFilter(maxLongEdge: number): string {
  return [
    "scale=",
    `'if(gt(iw,ih),min(${maxLongEdge},iw),-2)'`,
    ":",
    `'if(gt(iw,ih),-2,min(${maxLongEdge},ih))'`,
  ].join("");
}

function describeFfmpegFailure(binary: string, error: unknown): string {
  if (error instanceof CommandError) {
    const detail = (error.stderr || error.stdout || error.message).trim().split("\n").slice(-3).join(" ");
    return `ffmpeg（${binary}）处理图片失败：${truncate(detail, 300)}`;
  }
  return `无法运行 ffmpeg（${binary}）处理图片：${truncate(
    error instanceof Error ? error.message : String(error),
    300,
  )}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}
