import React from 'react';
import { Wand2 } from 'lucide-react';
import type { JobOverview } from '../../types/index';
import { getJobVisualState, formatDate } from './jobPresentation';
import { ContentPreview } from './ContentPreview';
import { ProgressRail, railSegmentsFromSteps } from '../../components/ui/ProgressRail';

export interface JobListViewProps {
  jobs: JobOverview[];
  deletingId: string | null;
  onOpen: (jobId: string) => void;
  onRequestDelete: (jobId: string) => void;
}

export function JobListView({ jobs, deletingId, onOpen, onRequestDelete }: JobListViewProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      {/* Desktop column headings */}
      <div className="grid grid-cols-[minmax(240px,1.4fr)_minmax(130px,0.8fr)_minmax(110px,0.6fr)_minmax(150px,0.8fr)_120px] gap-3 border-b border-line bg-elevated px-4 py-2.5 text-xs font-medium text-ink-muted max-lg:hidden">
        <span>作品</span>
        <span>更新时间</span>
        <span>状态</span>
        <span>下一步</span>
        <span className="text-right">操作</span>
      </div>
      <div className="divide-y divide-line">
        {jobs.map((job) => (
          <div
            key={job.id}
            /*
             * `group` 是必须的：行内删除按钮写的是 `opacity-0 group-hover:opacity-100`，
             * 而改造前整个文件只有那一处出现 `group`、祖先节点没有任何 group 类，
             * 于是 `group-hover` 永不生效 —— 窗口宽度 <1024px（lg 断点）时删除按钮
             * 永久不可见，却仍在 Tab 序列里、仍可点。Electron 窗口最小宽度是 800，
             * 所以这是个真实可达的区间。
             */
            className="group grid w-full grid-cols-1 gap-3 px-4 py-3.5 transition-colors hover:bg-elevated lg:grid-cols-[minmax(240px,1.4fr)_minmax(130px,0.8fr)_minmax(110px,0.6fr)_minmax(150px,0.8fr)_120px] lg:items-center"
          >
            {/* Title column */}
            <div
              className="flex min-w-0 items-center gap-3 cursor-pointer"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(job.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onOpen(job.id);
              }}
            >
              <ContentPreview
                title={job.preview.coverTitle || job.preview.displayTitle}
                imageUrl={job.preview.coverUrl}
                compact
              />
              <div className="min-w-0">
                <h3 className="line-clamp-1 font-semibold text-sm text-ink">{job.preview.displayTitle}</h3>
                <p className="mt-0.5 line-clamp-1 text-xs text-ink-muted">
                  {job.preview.sourcePlatform} · {job.preview.subtitle}
                </p>
                {/* 签名元素：一眼读出这条内容走到哪一步（转录→洗稿→分镜→成片） */}
                <div className="mt-1.5">
                  <ProgressRail segments={railSegmentsFromSteps(job.steps)} />
                </div>
              </div>
            </div>
            {/* Updated time */}
            <div className="text-xs text-ink-muted">{formatDate(job.updatedAt)}</div>
            {/* Status */}
            <JobListStatus job={job} />
            {/* Next action */}
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-ink">
              <Wand2 size={13} className="text-ai shrink-0" />
              <span className="line-clamp-1">{job.preview.nextActionLabel}</span>
            </div>
            {/* Actions */}
            <div className="flex justify-start gap-2 lg:justify-end">
              <button
                type="button"
                onClick={() => onOpen(job.id)}
                className="rounded-lg bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent-soft"
              >
                打开
              </button>
              {!job.deletedAt && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRequestDelete(job.id);
                  }}
                  disabled={deletingId === job.id}
                  className="rounded-lg border border-danger-line px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger-soft disabled:opacity-50 opacity-0 group-hover:opacity-100 lg:opacity-100"
                >
                  删除
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function JobListStatus({ job }: { job: JobOverview }) {
  const state = getJobVisualState(job);
  const toneClasses: Record<string, string> = {
    info: 'border-info-line bg-info-soft text-info',
    processing: 'border-running-line bg-running-soft text-running',
    success: 'border-success-line bg-success-soft text-success',
    danger: 'border-danger-line bg-danger-soft text-danger',
  };
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${toneClasses[state.tone]}`}>
      {state.busy && <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {!state.busy && (
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            state.tone === 'success' ? 'bg-success' : state.tone === 'danger' ? 'bg-danger' : state.tone === 'processing' ? 'bg-running' : 'bg-info'
          }`}
        />
      )}
      {state.label}
    </span>
  );
}
