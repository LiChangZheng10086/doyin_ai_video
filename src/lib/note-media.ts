/**
 * **图文包配图**处理：把任意比例的图裁成 **3:4（1080×1440）PNG**（无损）。
 *
 * ⚠️ **本模块是平台中立的**（不是"小红书专用"）。为什么：2026-09-20 用户拍板「**打包时裁**」
 * （spec §2 D2 的方案甲）—— 也就是**所有**图文包的 `images/` 直接就是 3:4，抖音那条路一样走这里。
 * 所以文件名与常量都不带平台前缀；若叫 `xhs-media.ts`，三个月后会有人问
 * 「为什么纯抖音的图文包要过一遍小红书的东西」。
 *
 * 选 3:4 的**依据**确实来自小红书发布页原文（见下），但 3:4 在抖音图文上同样是更优比例，
 * 所以这是一个**平台中立的目标比例**，只是当初由小红的规则定下来。
 *
 * ### 为什么必须自己裁（一手证据）
 * 发布页原文写着：「**不限制宽高比例，推荐上传 3:4 至 2:1 之间**、分辨率不低于 720×960 的照片」
 *（2026-09-20 只读侦察实测，见 spec §3）。而我们的场景静帧是 **1080×1920（9:16 ≈ 0.5625）**
 * —— **落在推荐区间之外**（3:4 = 0.75 是最矮的一端），直接传会被平台裁切或留白。
 *
 * ### 与 `toutiao-media.ts` / `wechat-media.ts` 的关系
 * ffmpeg 管线形状相同，但**错误码与常量各自独立**，刻意**不去改那两个模块** ——
 * 它们的错误码与文案被各自的用例逐字断言，为图文配图改它们的契约风险大于收益
 *（这与 `toutiao-media.ts` 当初对 `wechat-media.ts` 的取舍是同一条理由）。
 * 区别在于：那两个是**平台封面**（16:9 / 2.35:1），本模块是**图文包配图**（3:4）。
 *
 * ### 产物纪律
 * 产物**直接写目标名**、失败或超限时**删掉再抛错**，绝不在包目录里留半成品。
 */

import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command.js";

/**
 * 源图大小的兜底上限。
 *
 * 与 `wechat-media.ts` / `toutiao-media.ts` 的 `MAX_SOURCE_IMAGE_BYTES` **同口径**
 *（同一批输入：场景静帧与素材库图片，后者上传上限就是 20MB）：超过这个数的输入必然是
 * 别处来的异常文件，明确报错而不是默默啃。三处相等这件事有用例守住，防止数字悄悄漂移。
 */
export const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 图文配图的目标口径。
 *
 * - **比例/尺寸**：**1080×1440（3:4）**。依据是小程序发布页原文「不限制宽高比例，
 *   推荐上传 **3:4 至 2:1 之间**、分辨率不低于 720×960」（2026-09-20 侦察实测），
 *   而我们的场景静帧是 1080×1920（9:16 ≈ 0.5625）—— **落在推荐区间之外**。
 * - **单图上限 32MB**：取自那条页面原文「最大 32MB 的图片文件」
 *  （⚠️ 不是第三方汇总说的 20MB）。它同时也是抖音图文里更严的一份，所以直接当**通用上限**用。
 *
 * ⚠️ **平台专属的数字不放在这里**：张数上限 18（实测「1/18」）与可接受格式
 * （png/jpg/jpeg/webp）都属于**小红书那侧的闸门** —— 它们在 `xhs-page.ts` 的
 * `XHS_MAX_IMAGES` 与发布页校验里，别混进这个中立模块。
 */
export const NOTE_IMAGE_LIMITS = {
  width: 1080,
  height: 1440,
  maxBytes: 32 * 1024 * 1024,
} as const;

const IMAGE_TIMEOUT_MS = 120_000;

export type NoteMediaErrorCode =
  | "note_media_ffmpeg_unavailable"
  | "note_media_source_missing"
  | "note_media_source_too_large"
  | "note_media_ffmpeg_failed"
  | "note_media_too_large_after_compress";

export class NoteMediaError extends Error {
  readonly status = 422;

  constructor(
    readonly code: NoteMediaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NoteMediaError";
  }
}

export interface NoteMediaCommandRunner {
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

export interface NoteMediaConfig {
  /** ffmpeg 可执行文件；缺省用 PATH 里的 `ffmpeg`（与 `media.ts` 同一口径）。 */
  ffmpegBinary?: string;
  /** 注入子进程执行器（测试用假 ffmpeg）。 */
  commandRunner?: NoteMediaCommandRunner;
  timeoutMs?: number;
}

export interface PreparedXhsNoteImage {
  /** 产物绝对路径（已落盘、已校验大小）。 */
  path: string;
  bytes: number;
}

/**
 * 包内图片文件名：**序号补到两位**。
 *
 * 补零是为了让**字典序 == 场景序**（`note-02` 必须排在 `note-10` 前面）——
 * 图文包的图片顺序就是内容顺序，名字不稳定会让「按名字排序」的地方悄悄错位。
 *
 * ⚠️ **产物是 PNG 而不是 JPEG**（2026-09-20 实测后改的，不是随手选）：
 * 我们的图是 **HyperFrames 渲染出来的文字密集帧**，JPEG 会在字边留伪影；
 * 而实测同一张 1080×1920 锐利帧裁成 3:4 后，**PNG 211KB vs JPEG(q3) 152KB —— 只大 39%**，
 * 对「单图 ≤32MB、一次 ≤18 张」的平台口径来说完全不是问题（18 张约 3.8MB）。
 * 顺带保住 `.png` 后缀，包内 `images/01.png` 这类既有路径与断言都不用动。
 */
export function noteImageFileName(index: number): string {
  return `note-${String(index).padStart(2, "0")}.png`;
}

export class NoteMediaService {
  private readonly runner: NoteMediaCommandRunner;

  constructor(private readonly config: NoteMediaConfig = {}) {
    this.runner = config.commandRunner ?? { run: runCommand };
  }

  /**
   * 等比放大到**覆盖** 1080×1440 再**居中裁切**，保证构图居中而不是被平台随机裁。
   *
   * 产物固定为 `note-<NN>.jpg`；失败/超限一律删掉再抛错。
   */
  async prepareNoteImage(srcPath: string, outDir: string, index: number): Promise<PreparedXhsNoteImage> {
    const binary = this.requireBinary();
    await this.assertReadableSource(srcPath);

    const target = path.join(outDir, noteImageFileName(index));
    const { width, height, maxBytes } = NOTE_IMAGE_LIMITS;
    const filter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    // 不带 `-q:v`：输出是 PNG，走无损。
    const args = ["-y", "-i", srcPath, "-vf", filter, "-frames:v", "1", target];

    await this.execute(binary, args, target);
    const bytes = await this.readProducedBytes(target);
    if (bytes > maxBytes) {
      await this.discard(target);
      throw new NoteMediaError(
        "note_media_too_large_after_compress",
        `配图处理结果为 ${formatBytes(bytes)}，超过单图 ${formatBytes(maxBytes)}（32MB）的上限。`,
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
      throw new NoteMediaError("note_media_ffmpeg_failed", describeFfmpegFailure(binary, error));
    }
  }

  private async readProducedBytes(target: string): Promise<number> {
    try {
      return (await stat(target)).size;
    } catch {
      // ffmpeg 退出码 0 但没产出文件：必须报错，不能当成「0 字节的成功」。
      throw new NoteMediaError(
        "note_media_ffmpeg_failed",
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
      throw new NoteMediaError("note_media_source_missing", `找不到要处理的图片：${srcPath}`);
    }
    if (!info.isFile()) {
      throw new NoteMediaError("note_media_source_missing", `要处理的图片不是文件：${srcPath}`);
    }
    if (info.size > MAX_SOURCE_IMAGE_BYTES) {
      throw new NoteMediaError(
        "note_media_source_too_large",
        `源图 ${formatBytes(info.size)} 超过 ${formatBytes(MAX_SOURCE_IMAGE_BYTES)}（20MB）的处理上限：请换一张更小的图片。`,
      );
    }
  }

  private requireBinary(): string {
    const configured = this.config.ffmpegBinary;
    if (configured !== undefined && configured.trim().length === 0) {
      throw new NoteMediaError(
        "note_media_ffmpeg_unavailable",
        "未配置 ffmpeg（ffmpegBinary / FFMPEG_BINARY 为空），无法裁切图文配图；"
          + "请安装 ffmpeg 或在配置里给出它的路径后重启后端。",
      );
    }
    return configured?.trim() ?? "ffmpeg";
  }
}

function describeFfmpegFailure(binary: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `ffmpeg（${binary}）裁切图文配图失败：${truncate(detail, 500)}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
