import React from 'react';
import type { LucideIcon } from 'lucide-react';

export type StatusTone = 'neutral' | 'info' | 'processing' | 'success' | 'warning' | 'danger' | 'ai';

const toneClasses: Record<StatusTone, string> = {
  neutral: 'border-line bg-panel text-ink-muted',
  info: 'border-info-line bg-info-soft text-info',
  processing: 'border-running-line bg-running-soft text-running',
  success: 'border-success-line bg-success-soft text-success',
  warning: 'border-warning-line bg-warning-soft text-warning',
  danger: 'border-danger-line bg-danger-soft text-danger',
  ai: 'border-ai-line bg-ai-soft text-ai',
};

export interface StatusIndicatorProps {
  tone: StatusTone;
  label: string;
  icon?: LucideIcon;
  busy?: boolean;
  compact?: boolean;
}

export function StatusIndicator({ tone, label, icon: Icon, busy, compact }: StatusIndicatorProps) {
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${toneClasses[tone]} ${compact ? 'px-2 py-0.5 text-[11px]' : ''}`}
    >
      {busy ? (
        <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : Icon ? (
        <Icon size={12} />
      ) : (
        <span className={`inline-block h-2 w-2 rounded-full ${tone === 'processing' ? 'animate-pulse' : ''}`} />
      )}
      {label}
    </span>
  );
}
