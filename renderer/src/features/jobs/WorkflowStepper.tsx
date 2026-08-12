import React from 'react';
import type { WorkflowStepView } from './jobPresentation';

export interface WorkflowStepperProps {
  steps: WorkflowStepView[];
}

export function WorkflowStepper({ steps }: WorkflowStepperProps) {
  return (
    <section className="mt-6 rounded-lg border border-tech-border bg-white p-5">
      <h3 className="mb-4 font-semibold text-tech-text">主链路</h3>
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
                <span className="text-xs font-medium text-tech-muted">0{step.index}</span>
              </div>
              <h4 className="font-semibold text-tech-text">{step.label}</h4>
              <p className="mt-1 text-xs text-tech-muted">{step.actionLabel}</p>
              {step.status === 'running' && step.progress !== undefined && (
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-tech-muted">
                    <span>进度</span>
                    <span>{Math.round(step.progress)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-gray-200">
                    <div className="h-full rounded-full bg-tech-blue transition-all" style={{ width: `${Math.min(100, Math.round(step.progress))}%` }} />
                  </div>
                </div>
              )}
              {step.error && (
                <p className="mt-2 line-clamp-2 text-xs text-red-600">{step.error}</p>
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
    pending: 'border-tech-border bg-white',
    running: 'border-cyan-200 bg-cyan-50',
    succeeded: 'border-emerald-200 bg-emerald-50',
    failed: 'border-red-200 bg-red-50',
    paused: 'border-amber-200 bg-amber-50',
  };
  return classes[status];
}

function getStepIconClass(status: WorkflowStepView['status']) {
  const classes: Record<WorkflowStepView['status'], string> = {
    pending: 'bg-gray-100 text-tech-muted',
    running: 'bg-cyan-100 text-cyan-700',
    succeeded: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-red-100 text-red-700',
    paused: 'bg-amber-100 text-amber-700',
  };
  return classes[status];
}
