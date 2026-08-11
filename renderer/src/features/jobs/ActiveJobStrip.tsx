import React from 'react';
import { Wand2 } from 'lucide-react';
import type { JobOverview } from '../../types/index';
import { getJobVisualState } from './jobPresentation';
import { ContentPreview } from './ContentPreview';

export interface ActiveJobStripProps {
  job: JobOverview;
  onOpen: (id: string) => void;
}

export function ActiveJobStrip({ job, onOpen }: ActiveJobStripProps) {
  const visualState = getJobVisualState(job);
  const currentStep = job.preview.currentStep && job.steps ? job.steps[job.preview.currentStep] : null;
  const progress = currentStep?.progress;

  return (
    <div className="rounded-lg border border-tech-border bg-white p-4">
      <div className="flex items-center gap-4">
        <ContentPreview
          title={job.preview.coverTitle || job.preview.displayTitle}
          imageUrl={job.preview.coverUrl}
          compact
        />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-tech-muted uppercase tracking-wide">
            当前创作
          </p>
          <h3 className="mt-0.5 line-clamp-1 text-sm font-semibold text-tech-text">
            {job.preview.displayTitle}
          </h3>
          <p className="mt-1 line-clamp-1 text-xs text-tech-muted">
            {job.preview.sourcePlatform} · {job.preview.subtitle}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Wand2 size={13} className="text-tech-purple shrink-0" />
            <span className="text-xs font-medium text-tech-text">{job.preview.nextActionLabel}</span>
            {progress !== undefined && (
              <span className="text-xs font-mono text-tech-muted">{Math.round(progress)}%</span>
            )}
          </div>
          {progress !== undefined ? (
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-tech-blue transition-all duration-500"
                style={{ width: `${Math.min(100, Math.round(progress))}%` }}
              />
            </div>
          ) : currentStep?.status === 'running' ? (
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
              <div className="h-full w-1/2 animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-tech-blue" />
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onOpen(job.id)}
          className="shrink-0 rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white hover:bg-tech-blue-dark transition-colors"
        >
          继续创作
        </button>
      </div>
    </div>
  );
}
