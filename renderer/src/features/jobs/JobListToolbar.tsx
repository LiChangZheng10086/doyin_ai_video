import React from 'react';
import { Search, LayoutList, Grid3X3 } from 'lucide-react';
import type { JobFilterStatus, ViewMode } from '../../types/index';

const filterOptions: Array<{ id: JobFilterStatus; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'processing', label: '处理中' },
  { id: 'failed', label: '失败' },
  { id: 'done', label: '已完成' },
  { id: 'pending', label: '待执行' },
];

export interface JobListToolbarProps {
  query: string;
  filter: JobFilterStatus;
  viewMode: ViewMode;
  polling: boolean;
  onQueryChange: (value: string) => void;
  onFilterChange: (value: JobFilterStatus) => void;
  onViewModeChange: (mode: ViewMode) => void;
}

export function JobListToolbar({
  query,
  filter,
  viewMode,
  polling,
  onQueryChange,
  onFilterChange,
  onViewModeChange,
}: JobListToolbarProps) {
  return (
    <div className="mb-5 flex flex-col gap-3 rounded-lg border border-tech-border bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tech-muted" />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索标题、来源或摘要"
          className="h-10 w-full rounded-lg border border-tech-border bg-white pl-10 pr-4 text-sm text-tech-text outline-none placeholder:text-tech-muted focus:border-tech-blue focus:ring-2 focus:ring-blue-100"
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {filterOptions.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onFilterChange(item.id)}
              className={`h-8 rounded-lg px-3 text-xs font-medium transition-colors ${
                filter === item.id
                  ? 'bg-tech-text text-white'
                  : 'bg-gray-100 text-tech-muted hover:bg-gray-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex h-8 shrink-0 rounded-lg border border-tech-border bg-gray-100 p-0.5">
          <button
            type="button"
            aria-label="列表视图"
            aria-pressed={viewMode === 'list'}
            onClick={() => onViewModeChange('list')}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              viewMode === 'list' ? 'bg-white text-tech-blue shadow-sm' : 'text-tech-muted'
            }`}
          >
            <LayoutList size={15} />
          </button>
          <button
            type="button"
            aria-label="卡片视图"
            aria-pressed={viewMode === 'card'}
            onClick={() => onViewModeChange('card')}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              viewMode === 'card' ? 'bg-white text-tech-blue shadow-sm' : 'text-tech-muted'
            }`}
          >
            <Grid3X3 size={15} />
          </button>
        </div>
        {polling && (
          <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-tech-muted">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            同步中
          </span>
        )}
      </div>
    </div>
  );
}
