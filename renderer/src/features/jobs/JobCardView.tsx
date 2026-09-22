import React from 'react';
import { Trash2, Wand2 } from 'lucide-react';
import type { JobOverview } from '../../types/index';
import { getJobVisualState } from './jobPresentation';
import { ContentPreview } from './ContentPreview';
import { ProgressRail, railSegmentsFromSteps } from '../../components/ui/ProgressRail';

export interface JobCardViewProps {
  jobs: JobOverview[];
  deletingId: string | null;
  onOpen: (jobId: string) => void;
  onRequestDelete: (jobId: string) => void;
}

export function JobCardView({ jobs, deletingId, onOpen, onRequestDelete }: JobCardViewProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {jobs.map((job) => (
        <div
          key={job.id}
          onClick={() => onOpen(job.id)}
          className="cursor-pointer overflow-hidden rounded-lg border border-line bg-panel transition-all hover:border-accent-line hover:shadow-lg"
        >
          <ContentPreview title={job.preview.coverTitle || job.preview.displayTitle} imageUrl={job.preview.coverUrl} />
          <div className="p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="line-clamp-1 font-semibold text-ink">{job.preview.displayTitle}</h3>
                <p className="mt-1 line-clamp-1 text-sm text-ink-muted">
                  {job.preview.sourcePlatform} · {job.preview.subtitle}
                </p>
              </div>
              <JobCardStatus job={job} />
            </div>
            {job.preview.summary && (
              <p className="mb-4 line-clamp-2 text-sm leading-6 text-ink-muted">{job.preview.summary}</p>
            )}
            {/*
              改造前这里是 4 个「转录 / 洗稿 / 分镜 / 成片」胶囊，只表达「有 / 没有」。
              换成链路轨后：① 一次读完全链路；② 能区分「进行中 / 失败 / 待执行」，
              而那三种状态在旧胶囊里都只会显示成灰色。
            */}
            <div className="mb-4">
              <ProgressRail segments={railSegmentsFromSteps(job.steps)} />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <span className="inline-flex items-center gap-2 text-sm font-medium text-ink">
                <Wand2 size={15} className="text-ai" />
                {job.preview.nextActionLabel}
              </span>
              {!job.deletedAt && (
                <button
                  type="button"
                  disabled={deletingId === job.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRequestDelete(job.id);
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-danger-line text-danger transition-all hover:bg-danger-soft disabled:opacity-50"
                  aria-label="删除作品"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function JobCardStatus({ job }: { job: JobOverview }) {
  const state = getJobVisualState(job);
  const toneClasses: Record<string, string> = {
    info: 'border-info-line bg-info-soft text-info',
    processing: 'border-running-line bg-running-soft text-running',
    success: 'border-success-line bg-success-soft text-success',
    danger: 'border-danger-line bg-danger-soft text-danger',
  };
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium shrink-0 ${toneClasses[state.tone]}`}>
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
