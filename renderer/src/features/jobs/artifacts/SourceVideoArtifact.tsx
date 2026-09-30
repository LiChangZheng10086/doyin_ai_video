import React from 'react';
import { Link } from 'react-router-dom';

export interface SourceVideoArtifactProps {
  /** 任务记录里的原视频路径（`raw/videos/<jobId>.mp4`）；为空表示还没做过视频转录。 */
  videoPath?: string;
  streamUrl: string | null;
  streamError: boolean;
  onVideoError: () => void;
  jobId?: string;
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
  jobId,
}: SourceVideoArtifactProps) {
  if (!videoPath) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-elevated py-14 text-center">
        <h3 className="font-semibold text-ink">原视频尚未下载</h3>
        <p className="mt-2 text-sm text-ink-muted">
          先执行「视频转录」，原视频会同时下载到本地，之后就能在这里直接观看。
        </p>
      </div>
    );
  }

  if (streamError) {
    return (
      <div className="rounded-lg border border-warning-line bg-warning-soft p-4 text-warning">
        <p className="font-semibold">原视频文件不可读取</p>
        <p className="mt-1 text-sm">文件可能已被移动或删除，可重新执行视频转录后重试。</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-ink">原视频</h3>
        <p className="mt-1 text-sm text-ink-muted">视频转录步骤下载的抖音原片，未经洗稿与渲染。</p>
        {jobId && <Link to={`/galleries?sourceJobId=${encodeURIComponent(jobId)}`} className="mt-3 inline-flex rounded-lg border border-accent-line px-4 py-2 text-sm text-accent hover:bg-accent-soft">制作字幕图集</Link>}
      </div>

      {streamUrl ? (
        <div className="rounded-lg border border-line bg-black p-3">
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
