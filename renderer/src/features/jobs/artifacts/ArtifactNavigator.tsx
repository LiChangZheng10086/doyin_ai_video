import React from 'react';
import { useRovingTabs } from '../../../components/ui/useRovingTabs';

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
  ready: 'bg-success-soft text-success',
  processing: 'bg-running-soft text-running',
  waiting: 'bg-elevated text-ink-muted',
  failed: 'bg-danger-soft text-danger',
};

export function ArtifactNavigator({ active, items, onChange }: ArtifactNavigatorProps) {
  // 方向键切换 + roving tabindex：整组只占一个 Tab 停靠点
  const roving = useRovingTabs(items.map((item) => item.key), active, (key) =>
    onChange(key as ArtifactKey),
  );
  return (
    <div
      role="tablist"
      aria-label="成果切换"
      onKeyDown={roving.onKeyDown}
      className="flex overflow-x-auto border-b border-line bg-elevated px-2 pt-2"
    >
      {items.map((item) => {
        const isActive = active === item.key;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={roving.tabIndexFor(item.key)}
            ref={(node) => { roving.refs.current[item.key] = node; }}
            onClick={() => onChange(item.key)}
            className={`mr-1 flex min-w-[130px] items-center justify-between gap-2 rounded-t-lg px-4 py-3 text-left text-sm font-semibold transition-all ${
              isActive
                ? 'bg-panel text-ink shadow-sm'
                : 'text-ink-muted hover:bg-panel/60'
            }`}
          >
            <span>{item.label}</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${stateClasses[item.state]}`}>
              {stateLabels[item.state]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
