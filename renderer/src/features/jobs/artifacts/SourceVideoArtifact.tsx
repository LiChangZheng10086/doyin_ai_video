import React from 'react';

export interface SourceVideoArtifactProps {
  /** 任务记录里的原视频路径（`raw/videos/<jobId>.mp4`）；为空表示还没做过视频转录。 */
  videoPath?: string;
  streamUrl: string | null;
  streamError: boolean;
  onVideoError: () => void;
}

/**
 * 原视频面板：播放「视频转录」步骤顺手下载的抖音原片。
 *
 * 三态 —— 未下载时只做引导、不偷偷发起网络请求；有路径但取流失败时明确报不可读，
 * 而不是留一个空白播放器让用户以为视频坏了。
 */
export function SourceVideoArtifact({
  videoPath,
  streamUrl,
  streamError,
  onVideoError,
}: SourceVideoArtifactProps) {
  if (!videoPath) {
    return (
      <div className="rounded-lg border border-dashed border-tech-border bg-gray-50 py-14 text-center">
        <h3 className="font-semibold text-tech-text">原视频尚未下载</h3>
        <p className="mt-2 text-sm text-tech-muted">
          先执行「视频转录」，原视频会同时下载到本地，之后就能在这里直接观看。
        </p>
      </div>
    );
  }

  if (streamError) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-700">
        <p className="font-semibold">原视频文件不可读取</p>
        <p className="mt-1 text-sm">文件可能已被移动或删除，可重新执行视频转录后重试。</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-tech-text">原视频</h3>
        <p className="mt-1 text-sm text-tech-muted">视频转录步骤下载的抖音原片，未经洗稿与渲染。</p>
      </div>

      {streamUrl ? (
        <div className="rounded-lg border border-tech-border bg-black p-3">
          <video
            src={streamUrl}
            controls
            playsInline
            onError={onVideoError}
            className="mx-auto aspect-[9/16] max-h-[72vh] w-full max-w-sm rounded-md bg-black"
          />
        </div>
      ) : null}
    </div>
  );
}
