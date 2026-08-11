import React from 'react';
import { Wand2 } from 'lucide-react';
import type { JobOverview } from '../../types/index';
import { getJobVisualState, formatDate } from './jobPresentation';
import { ContentPreview } from './ContentPreview';

export interface JobListViewProps {
  jobs: JobOverview[];
  deletingId: string | null;
  onOpen: (jobId: string) => void;
  onRequestDelete: (jobId: string) => void;
}

export function JobListView({ jobs, deletingId, onOpen, onRequestDelete }: JobListViewProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-tech-border bg-white">
      {/* Desktop column headings */}
      <div className="grid grid-cols-[minmax(240px,1.4fr)_minmax(130px,0.8fr)_minmax(110px,0.6fr)_minmax(150px,0.8fr)_96px] gap-3 border-b border-tech-border bg-gray-50 px-4 py-2.5 text-xs font-medium text-tech-muted max-lg:hidden">
        <span>作品</span>
        <span>更新时间</span>
        <span>状态</span>
        <span>下一步</span>
        <span className="text-right">操作</span>
      </div>
      <div className="divide-y divide-tech-border">
        {jobs.map((job) => (
          <div
            key={job.id}
            className="grid w-full grid-cols-1 gap-3 px-4 py-3.5 transition-colors hover:bg-gray-50 lg:grid-cols-[minmax(240px,1.4fr)_minmax(130px,0.8fr)_minmax(110px,0.6fr)_minmax(150px,0.8fr)_96px] lg:items-center"
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
                <h3 className="line-clamp-1 font-semibold text-sm text-tech-text">{job.preview.displayTitle}</h3>
                <p className="mt-0.5 line-clamp-1 text-xs text-tech-muted">
                  {job.preview.sourcePlatform} · {job.preview.subtitle}
                </p>
              </div>
            </div>
            {/* Updated time */}
            <div className="text-xs text-tech-muted">{formatDate(job.updatedAt)}</div>
            {/* Status */}
            <JobListStatus job={job} />
            {/* Next action */}
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-tech-text">
              <Wand2 size={13} className="text-tech-purple shrink-0" />
              <span className="line-clamp-1">{job.preview.nextActionLabel}</span>
            </div>
            {/* Actions */}
            <div className="flex justify-start gap-2 lg:justify-end">
              <button
                type="button"
                onClick={() => onOpen(job.id)}
                className="rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-medium text-tech-blue hover:bg-blue-100"
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
                  className="rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 opacity-0 group-hover:opacity-100 lg:opacity-100"
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
    info: 'border-blue-200 bg-blue-50 text-blue-700',
    processing: 'border-cyan-200 bg-cyan-50 text-cyan-700',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    danger: 'border-red-200 bg-red-50 text-red-700',
  };
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${toneClasses[state.tone]}`}>
      {state.busy && <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {!state.busy && (
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            state.tone === 'success' ? 'bg-emerald-500' : state.tone === 'danger' ? 'bg-red-500' : state.tone === 'processing' ? 'bg-cyan-500' : 'bg-blue-500'
          }`}
        />
      )}
      {state.label}
    </span>
  );
}
