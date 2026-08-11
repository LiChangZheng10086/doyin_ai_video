import React from 'react';
import { Trash2, Wand2 } from 'lucide-react';
import type { JobOverview } from '../../types/index';
import { getJobVisualState } from './jobPresentation';
import { ContentPreview } from './ContentPreview';

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
          className="cursor-pointer overflow-hidden rounded-lg border border-tech-border bg-white transition-all hover:border-tech-blue hover:shadow-lg"
        >
          <ContentPreview title={job.preview.coverTitle || job.preview.displayTitle} imageUrl={job.preview.coverUrl} />
          <div className="p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="line-clamp-1 font-semibold text-tech-text">{job.preview.displayTitle}</h3>
                <p className="mt-1 line-clamp-1 text-sm text-tech-muted">
                  {job.preview.sourcePlatform} · {job.preview.subtitle}
                </p>
              </div>
              <JobCardStatus job={job} />
            </div>
            {job.preview.summary && (
              <p className="mb-4 line-clamp-2 text-sm leading-6 text-tech-muted">{job.preview.summary}</p>
            )}
            <div className="mb-4 flex flex-wrap gap-2">
              <ArtifactPill ready={job.preview.hasTranscript} label="转录" />
              <ArtifactPill ready={job.preview.hasRewrite} label="洗稿" />
              <ArtifactPill ready={job.preview.hasVideoPrompts} label="分镜" />
              <ArtifactPill ready={job.preview.hasVideo} label="成片" />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-tech-border pt-3">
              <span className="inline-flex items-center gap-2 text-sm font-medium text-tech-text">
                <Wand2 size={15} className="text-tech-purple" />
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
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 text-red-600 transition-all hover:bg-red-50 disabled:opacity-50"
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
    info: 'border-blue-200 bg-blue-50 text-blue-700',
    processing: 'border-cyan-200 bg-cyan-50 text-cyan-700',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    danger: 'border-red-200 bg-red-50 text-red-700',
  };
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium shrink-0 ${toneClasses[state.tone]}`}>
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

function ArtifactPill({ ready, label }: { ready: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
        ready ? 'bg-purple-50 text-tech-purple' : 'bg-gray-100 text-tech-muted'
      }`}
    >
      {label}
    </span>
  );
}
