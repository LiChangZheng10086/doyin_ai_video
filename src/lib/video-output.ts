import { open, readFile, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { JobRecord, ScriptAsset } from "../types.js";

export interface ResolvedVideoFile {
  path: string;
  size: number;
  mimeType: "video/mp4";
  handle: FileHandle;
  close(): Promise<void>;
}

export type VideoOutputErrorCode = "publish_video_missing" | "publish_video_unreadable";

const VIDEO_OUTPUT_MESSAGES: Record<VideoOutputErrorCode, string> = {
  publish_video_missing: "未找到可用成片，请重新生成视频",
  publish_video_unreadable: "成片文件不可读取，请检查文件权限后重试",
};

export class VideoOutputError extends Error {
  readonly status = 422;

  constructor(readonly code: VideoOutputErrorCode) {
    super(VIDEO_OUTPUT_MESSAGES[code]);
    this.name = "VideoOutputError";
  }
}

export async function resolveJobVideo(
  storageRoot: string,
  job: JobRecord,
): Promise<ResolvedVideoFile> {
  const script = await readScript(storageRoot, job.id);
  const candidate: unknown = script?.hyperframesVideo?.videoPath ?? job.videoOutputPath;
  if (!candidate) throw new VideoOutputError("publish_video_missing");
  if (typeof candidate !== "string") throw new VideoOutputError("publish_video_unreadable");
  if (path.extname(candidate).toLowerCase() !== ".mp4") {
    throw new VideoOutputError("publish_video_unreadable");
  }

  const storageRootPath = path.resolve(storageRoot);
  const canonicalRoot = await realpath(storageRootPath);
  const candidatePath = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(storageRootPath, candidate.replace(/^storage[\\/]/u, ""));
  if (!isInsideRoot(storageRootPath, candidatePath) && !isInsideRoot(canonicalRoot, candidatePath)) {
    throw new VideoOutputError("publish_video_unreadable");
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(candidatePath, "r");
    const fileStats = await handle.stat();
    const pathStats = await stat(candidatePath);
    const canonicalPath = await realpath(candidatePath);
    assertInsideRoot(canonicalRoot, canonicalPath);
    if (fileStats.dev !== pathStats.dev || fileStats.ino !== pathStats.ino) {
      throw new VideoOutputError("publish_video_unreadable");
    }
    if (!fileStats.isFile()) throw new VideoOutputError("publish_video_unreadable");
    if (fileStats.size === 0) throw new VideoOutputError("publish_video_missing");

    let closed = false;
    const openedHandle = handle;
    return {
      path: canonicalPath,
      size: fileStats.size,
      mimeType: "video/mp4",
      handle: openedHandle,
      close: async () => {
        if (closed) return;
        closed = true;
        await openedHandle.close();
      },
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof VideoOutputError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new VideoOutputError("publish_video_missing");
    }
    throw new VideoOutputError("publish_video_unreadable");
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

function assertInsideRoot(storageRoot: string, candidate: string): void {
  if (!isInsideRoot(storageRoot, candidate)) {
    throw new VideoOutputError("publish_video_unreadable");
  }
}

function isInsideRoot(storageRoot: string, candidate: string): boolean {
  const relative = path.relative(storageRoot, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
