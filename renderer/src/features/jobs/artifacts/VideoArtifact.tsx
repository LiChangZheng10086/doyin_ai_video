import React from 'react';
import { Download, Send } from 'lucide-react';
import type { HyperframesVideoOutput } from '../../../types/index';

export interface VideoArtifactProps {
  output: HyperframesVideoOutput;
  jobId: string;
  title: string;
  videoError: string | null;
  videoUrl: string | null;
  streamUrl: string | null;
  streamError: boolean;
  publishError: string;
  onOpenPublishing: () => void;
  onVideoError: () => void;
}

export function VideoArtifact({
  output,
  videoError,
  videoUrl,
  streamUrl,
  streamError,
  publishError,
  onOpenPublishing,
  onVideoError,
}: VideoArtifactProps) {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-tech-text">视频成片</h3>
          <p className="mt-1 text-sm text-tech-muted">HyperFrames 本地渲染的 9:16 无声动效版。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onOpenPublishing}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-tech-purple px-4 py-2.5 font-medium text-white transition-all hover:opacity-90"
          >
            <Send size={17} />
            加入发布中心
          </button>
          {videoUrl && (
            <a
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-tech-blue px-4 py-2.5 font-medium text-white transition-all hover:bg-tech-blue-dark"
            >
              <Download size={17} />
              下载 MP4
            </a>
          )}
        </div>
      </div>

      {publishError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-700">
          <p className="font-semibold">需要选择操作者</p>
          <p className="mt-1 text-sm">{publishError}</p>
        </div>
      )}

      {videoError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-700">
          <p className="font-semibold">本次渲染失败，正在显示上一版成片</p>
          <p className="mt-1 text-sm">{videoError}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Metric label="渲染器" value={output.provider} />
        <Metric label="尺寸" value={`${output.width}x${output.height} · ${output.aspectRatio}`} />
        <Metric label="时长" value={formatSeconds(output.duration)} />
      </div>

      {streamUrl && !streamError ? (
        <div className="rounded-lg border border-tech-border bg-black p-3">
          <video
            src={streamUrl}
            controls
            playsInline
            onError={onVideoError}
            className="mx-auto aspect-[9/16] max-h-[72vh] w-full max-w-sm rounded-md bg-black"
          />
        </div>
      ) : streamError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-700">
          <p className="font-semibold">视频预览加载失败</p>
          <p className="mt-1 text-sm">可以先下载 MP4 到本地查看。</p>
        </div>
      ) : null}

      <details className="rounded-lg border border-tech-border bg-white">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-tech-muted hover:text-tech-text">
          高级信息
        </summary>
        <div className="px-4 pb-4 space-y-3">
          <div className="rounded-lg bg-gray-50 p-4">
            <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">视频文件</label>
            <p className="break-all font-mono text-xs text-tech-text">{output.videoPath}</p>
          </div>
          <div className="rounded-lg bg-gray-50 p-4">
            <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">HyperFrames 项目</label>
            <p className="break-all font-mono text-xs text-tech-text">{output.projectPath}</p>
          </div>
        </div>
      </details>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-4 py-3">
      <label className="mb-1 block text-xs text-tech-muted">{label}</label>
      <p className="text-sm text-tech-text">{value}</p>
    </div>
  );
}

function formatSeconds(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
