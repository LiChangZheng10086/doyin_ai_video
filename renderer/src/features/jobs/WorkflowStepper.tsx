import React from 'react';
import type { WorkflowStepView } from './jobPresentation';

export interface WorkflowStepperProps {
  steps: WorkflowStepView[];
}

export function WorkflowStepper({ steps }: WorkflowStepperProps) {
  return (
    <section className="mt-6 rounded-lg border border-line bg-panel p-5">
      <h3 className="mb-4 font-semibold text-ink">主链路</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {steps.map((step) => {
          const stepCardClass = getStepCardClass(step.status);
          const stepIconClass = getStepIconClass(step.status);
          return (
            <div key={step.key} className={`rounded-lg border p-4 ${stepCardClass}`}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className={`flex h-8 w-8 items-center justify-center rounded-full ${stepIconClass}`}>
                  {step.status === 'succeeded' ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  ) : steps.indexOf(step) >= 0 ? (
                    <span className="text-xs font-semibold">{step.index}</span>
                  ) : null}
                </span>
                <span className="text-xs font-medium text-ink-muted">0{step.index}</span>
              </div>
              <h4 className="font-semibold text-ink">{step.label}</h4>
              <p className="mt-1 text-xs text-ink-muted">{step.actionLabel}</p>
              {step.status === 'running' && step.progress !== undefined && (
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-ink-muted">
                    <span>进度</span>
                    <span>{Math.round(step.progress)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-line-strong">
                    <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.min(100, Math.round(step.progress))}%` }} />
                  </div>
                </div>
              )}
              {step.error && (
                <p className="mt-2 line-clamp-2 text-xs text-danger">{step.error}</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function getStepCardClass(status: WorkflowStepView['status']) {
  const classes: Record<WorkflowStepView['status'], string> = {
    pending: 'border-line bg-panel',
    running: 'border-running-line bg-running-soft',
    succeeded: 'border-success-line bg-success-soft',
    failed: 'border-danger-line bg-danger-soft',
    paused: 'border-warning-line bg-warning-soft',
  };
  return classes[status];
}

function getStepIconClass(status: WorkflowStepView['status']) {
  const classes: Record<WorkflowStepView['status'], string> = {
    pending: 'bg-elevated text-ink-muted',
    running: 'bg-running-soft text-running',
    succeeded: 'bg-success-soft text-success',
    failed: 'bg-danger-soft text-danger',
    paused: 'bg-warning-soft text-warning',
  };
  return classes[status];
}
