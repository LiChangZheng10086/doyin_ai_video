import React from 'react';
import type { StatusTone } from './StatusIndicator';

export interface InlineNoticeProps {
  tone: Exclude<StatusTone, 'neutral' | 'ai'>;
  title: string;
  children?: React.ReactNode;
}

const borderClasses: Record<InlineNoticeProps['tone'], string> = {
  info: 'border-l-blue-500 bg-info-soft text-info',
  processing: 'border-l-cyan-500 bg-running-soft text-running',
  success: 'border-l-emerald-500 bg-success-soft text-success',
  warning: 'border-l-amber-500 bg-warning-soft text-warning',
  danger: 'border-l-red-500 bg-danger-soft text-danger',
};

export function InlineNotice({ tone, title, children }: InlineNoticeProps) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`rounded-lg border-l-4 px-4 py-3 ${borderClasses[tone]}`}
    >
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 text-xs opacity-90">{children}</div>}
    </div>
  );
}
