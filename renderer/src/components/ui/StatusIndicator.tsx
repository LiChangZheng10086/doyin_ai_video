import React from 'react';
import type { LucideIcon } from 'lucide-react';

export type StatusTone = 'neutral' | 'info' | 'processing' | 'success' | 'warning' | 'danger' | 'ai';

const toneClasses: Record<StatusTone, string> = {
  neutral: 'border-tech-border bg-white text-tech-muted',
  info: 'border-blue-200 bg-blue-50 text-blue-700',
  processing: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
  danger: 'border-red-200 bg-red-50 text-red-700',
  ai: 'border-purple-200 bg-purple-50 text-purple-700',
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
