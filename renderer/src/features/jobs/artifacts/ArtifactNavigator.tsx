import React from 'react';

export type ArtifactKey = 'transcript' | 'script' | 'shots' | 'video';
export type ArtifactState = 'ready' | 'processing' | 'waiting' | 'failed';

export interface ArtifactNavigatorProps {
  active: ArtifactKey;
  items: Array<{ key: ArtifactKey; label: string; state: ArtifactState }>;
  onChange: (key: ArtifactKey) => void;
}

const stateLabels: Record<ArtifactState, string> = {
  ready: '可用',
  processing: '处理中',
  waiting: '等待中',
  failed: '失败',
};

const stateClasses: Record<ArtifactState, string> = {
  ready: 'bg-emerald-50 text-emerald-700',
  processing: 'bg-cyan-50 text-cyan-700',
  waiting: 'bg-gray-100 text-tech-muted',
  failed: 'bg-red-50 text-red-700',
};

export function ArtifactNavigator({ active, items, onChange }: ArtifactNavigatorProps) {
  return (
    <div role="tablist" className="flex overflow-x-auto border-b border-tech-border bg-gray-50 px-2 pt-2">
      {items.map((item) => {
        const isActive = active === item.key;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.key)}
            className={`mr-1 flex min-w-[130px] items-center justify-between gap-2 rounded-t-lg px-4 py-3 text-left text-sm font-semibold transition-all ${
              isActive
                ? 'bg-white text-tech-text shadow-sm'
                : 'text-tech-muted hover:bg-white/60'
            }`}
          >
            <span>{item.label}</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${stateClasses[item.state]}`}>
              {stateLabels[item.state]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
