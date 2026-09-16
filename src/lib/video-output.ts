import { open, readFile, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { JobRecord, ScriptAsset } from "../types.js";

export interface ResolvedVideoFile {
  path: string;
  size: number;
  mimeType: "video/mp4";
  handle: FileHandle;
  identity: { dev: number; ino: number };
  close(): Promise<void>;
}

export type VideoOutputErrorCode =
  | "publish_video_missing"
  | "publish_video_unreadable"
  | "source_video_missing"
  | "source_video_unreadable";

const VIDEO_OUTPUT_MESSAGES: Record<VideoOutputErrorCode, string> = {
  publish_video_missing: "未找到可用成片，请重新生成视频",
  publish_video_unreadable: "成片文件不可读取，请检查文件权限后重试",
  source_video_missing: "未找到原视频，请先执行视频转录",
  source_video_unreadable: "原视频文件不可读取，请检查文件权限后重试",
};

/** 同一套校验在「成片」与「原视频」两条路径上各自使用的错误码。 */
interface VideoErrorCodes {
  missing: VideoOutputErrorCode;
  unreadable: VideoOutputErrorCode;
}

const PUBLISH_VIDEO_CODES: VideoErrorCodes = {
  missing: "publish_video_missing",
  unreadable: "publish_video_unreadable",
};

const SOURCE_VIDEO_CODES: VideoErrorCodes = {
  missing: "source_video_missing",
  unreadable: "source_video_unreadable",
};

export class VideoOutputError extends Error {
  readonly status = 422;

  constructor(readonly code: VideoOutputErrorCode) {
    super(VIDEO_OUTPUT_MESSAGES[code]);
    this.name = "VideoOutputError";
  }
}

/**
 * 解析成片：候选来自脚本资产的 `hyperframesVideo.videoPath`，回退到 `job.videoOutputPath`。
 */
export async function resolveJobVideo(
  storageRoot: string,
  job: JobRecord,
): Promise<ResolvedVideoFile> {
  const script = await readScript(storageRoot, job.id);
  const candidate: unknown = script?.hyperframesVideo?.videoPath ?? job.videoOutputPath;
  return resolveContainedMp4(storageRoot, candidate, PUBLISH_VIDEO_CODES);
}

/**
 * 解析已下载的抖音原视频：候选来自 `job.videoPath`（`raw/videos/<jobId>.mp4`）。
 *
 * 「视频转录」步骤会顺手把原视频下载到本地，此后用户在详情页就能直接观看它，
 * 不必等到「生成视频」产出成片。未下载时按 `source_video_missing` 提示先做转录。
 */
export async function resolveSourceVideo(
  storageRoot: string,
  job: JobRecord,
): Promise<ResolvedVideoFile> {
  return resolveContainedMp4(storageRoot, job.videoPath, SOURCE_VIDEO_CODES);
}

/**
 * 把候选路径解析成一个已打开、且确实位于 storage 根内的 MP4 句柄。
 *
 * 安全约束集中在这里，成片与原视频共用同一份实现：`job.videoPath` 与
 * `job.videoOutputPath` 都是持久化的绝对路径，任何绕过根目录约束的分支
 * 都等于对外提供任意文件读取。
 */
async function resolveContainedMp4(
  storageRoot: string,
  candidate: unknown,
  codes: VideoErrorCodes,
): Promise<ResolvedVideoFile> {
  if (!candidate) throw new VideoOutputError(codes.missing);
  if (typeof candidate !== "string") throw new VideoOutputError(codes.unreadable);
  if (path.extname(candidate).toLowerCase() !== ".mp4") {
    throw new VideoOutputError(codes.unreadable);
  }

  const storageRootPath = path.resolve(storageRoot);
  const canonicalRoot = await realpath(storageRootPath);
  const candidatePath = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(storageRootPath, candidate.replace(/^storage[\\/]/u, ""));
  if (!isInsideRoot(storageRootPath, candidatePath) && !isInsideRoot(canonicalRoot, candidatePath)) {
    throw new VideoOutputError(codes.unreadable);
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(candidatePath, "r");
    const fileStats = await handle.stat();
    const pathStats = await stat(candidatePath);
    const canonicalPath = await realpath(candidatePath);
    assertInsideRoot(canonicalRoot, canonicalPath, codes);
    if (fileStats.dev !== pathStats.dev || fileStats.ino !== pathStats.ino) {
      throw new VideoOutputError(codes.unreadable);
    }
    if (!fileStats.isFile()) throw new VideoOutputError(codes.unreadable);
    if (fileStats.size === 0) throw new VideoOutputError(codes.missing);

    let closed = false;
    const openedHandle = handle;
    return {
      path: canonicalPath,
      size: fileStats.size,
      mimeType: "video/mp4",
      handle: openedHandle,
      identity: { dev: fileStats.dev, ino: fileStats.ino },
      close: async () => {
        if (closed) return;
        await openedHandle.close();
        closed = true;
      },
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof VideoOutputError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new VideoOutputError(codes.missing);
    }
    throw new VideoOutputError(codes.unreadable);
  }

}

async function readScript(storageRoot: string, jobId: string): Promise<ScriptAsset | undefined> {
  try {
    const content = await readFile(
      path.join(storageRoot, "processed", "scripts", `${jobId}.json`),
      "utf8",
    );
    return JSON.parse(content) as ScriptAsset;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new VideoOutputError("publish_video_unreadable");
  }
}

function assertInsideRoot(storageRoot: string, candidate: string, codes: VideoErrorCodes): void {
  if (!isInsideRoot(storageRoot, candidate)) {
    throw new VideoOutputError(codes.unreadable);
  }
}

function isInsideRoot(storageRoot: string, candidate: string): boolean {
  const relative = path.relative(storageRoot, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
