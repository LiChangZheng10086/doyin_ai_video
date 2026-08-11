import React from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { Job, PipelineStep } from '../../types/index';

export interface JobContextSidebarProps {
  job: Job;
}

const STEP_LABELS: Record<PipelineStep, string> = {
  transcribe: '视频转录',
  clean: 'AI 洗稿',
  generate_video_prompts: '生成分镜',
  generate_video: '生成视频',
};

const STEP_ORDER: PipelineStep[] = ['transcribe', 'clean', 'generate_video_prompts', 'generate_video'];

export function JobContextSidebar({ job }: JobContextSidebarProps) {
  const events = buildTimeline(job);

  return (
    <aside className="space-y-6">
      {/* Activity */}
      <div className="rounded-lg border border-tech-border bg-white p-5">
        <h3 className="font-semibold text-tech-text">活动记录</h3>
        <p className="mt-1 text-sm text-tech-muted">关键步骤时间线</p>
        <div className="mt-5 space-y-4">
          {events.length === 0 ? (
            <p className="text-sm text-tech-muted">等待第一步开始。</p>
          ) : events.map((event, index) => (
            <div key={`${event.label}-${index}`} className="flex gap-3">
              <span className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${event.failed ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-tech-blue'}`}>
                {event.failed ? <XCircle size={14} /> : <CheckCircle2 size={14} />}
              </span>
              <div>
                <p className="text-sm font-medium text-tech-text">{event.label}</p>
                <p className="text-xs text-tech-muted">{formatDateTime(event.time)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Advanced info */}
      <details className="rounded-lg border border-tech-border bg-white p-5">
        <summary className="cursor-pointer font-semibold text-tech-text">高级信息</summary>
        <div className="mt-4 space-y-4">
          <Field label="任务 ID" value={job.id} />
          <Field label="创建时间" value={new Date(job.createdAt).toLocaleString('zh-CN')} />
          <Field label="更新时间" value={new Date(job.updatedAt).toLocaleString('zh-CN')} />
          <Field label="视频文件" value={job.videoPath} />
          <Field label="音频文件" value={job.audioPath} />
          <Field label="成片文件" value={job.videoOutputPath} />
          <Field label="HyperFrames 项目" value={job.videoProjectPath} />
          <Field label="存储路径" value={job.storagePath} />
          {(job.errorMessage || job.error || job.downloadErrorMessage || job.audioErrorMessage || job.transcriptErrorMessage) && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <p className="mb-2 font-semibold">错误详情</p>
              <pre className="whitespace-pre-wrap font-mono text-xs">
                {job.errorMessage || job.error || job.downloadErrorMessage || job.audioErrorMessage || job.transcriptErrorMessage}
              </pre>
            </div>
          )}
        </div>
      </details>
    </aside>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase text-tech-muted">{label}</label>
      <p className="break-all rounded bg-gray-50 px-3 py-2 font-mono text-xs text-tech-text">{value}</p>
    </div>
  );
}

function buildTimeline(job: Job) {
  if (!job.steps) return [];
  return STEP_ORDER.flatMap((step) => {
    const state = job.steps?.[step];
    if (!state) return [];
    const events: Array<{ label: string; time: string; failed?: boolean }> = [];
    if (state.startedAt) {
      events.push({ label: `开始${STEP_LABELS[step]}`, time: state.startedAt });
    }
    if (state.finishedAt) {
      events.push({
        label: state.status === 'failed' ? `${STEP_LABELS[step]}失败` : `${STEP_LABELS[step]}完成`,
        time: state.finishedAt,
        failed: state.status === 'failed',
      });
    }
    return events;
  });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
