import React from 'react';
import type { StatusTone } from './StatusIndicator';

export interface InlineNoticeProps {
  tone: Exclude<StatusTone, 'neutral' | 'ai'>;
  title: string;
  children?: React.ReactNode;
}

const borderClasses: Record<InlineNoticeProps['tone'], string> = {
  info: 'border-l-blue-500 bg-blue-50 text-blue-800',
  processing: 'border-l-cyan-500 bg-cyan-50 text-cyan-800',
  success: 'border-l-emerald-500 bg-emerald-50 text-emerald-800',
  warning: 'border-l-amber-500 bg-amber-50 text-amber-800',
  danger: 'border-l-red-500 bg-red-50 text-red-800',
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
