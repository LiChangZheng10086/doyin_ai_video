import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useRuntimeStatus } from '../hooks/useRuntimeStatus';
import { formatAge } from '../utils/runtime';
import { RuntimeStatusList } from './RuntimeStatusList';

/**
 * 发布中心 · 概览条（**概览层**，spec §6.1）。
 *
 * 贴着决策现场：打开发布中心**不做任何操作**就能看到五项状态（AC-1），但全部来自
 * **零副作用**的免费检查 —— 会开浏览器的深检留在设置页手动触发（它要与发布抢 profile）。
 *
 * 与设置页共用 `useRuntimeStatus()` 与 `RuntimeStatusList`：同一份数据、同一个组件，
 * 只是 `variant="compact"`。红灯判定仍然只在服务端（INV-7）。
 */

export function RuntimeOverviewStrip({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { status, loading, error, check, refresh } = useRuntimeStatus();
  const now = new Date();

  if (!status) {
    // 首次取数期间不占位、不闪烁；取不到时才说话（下面那段）
    if (!error) return null;
    return (
      <p className="mb-4 rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-xs text-warning" role="status">
        运行环境状态取不到：{error}
      </p>
    );
  }

  const items = [...status.channels, ...status.dependencies];
  const blockedOrUnknown = items.some((item) => item.state !== 'ready');

  return (
    <section className="mb-4 rounded-lg border border-line bg-panel px-3 py-2" aria-label="运行环境状态">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-subtle">运行环境</span>
        {/* spec §6.1：概览条也要说明结论的**时效**（用户据此决定要不要重新检查） */}
        <span className="text-xs text-ink-subtle">本次检查：{formatAge(status.checkedAt, now)}</span>
        <div className="min-w-0 flex-1">
          <RuntimeStatusList items={items} variant="compact" check={check} now={now} />
        </div>
        {blockedOrUnknown && onOpenSettings && (
          <button
            type="button"
            className="rounded border border-line-ui px-2 py-0.5 text-xs text-ink hover:bg-elevated"
            onClick={onOpenSettings}
          >
            查看
          </button>
        )}
        <button
          type="button"
          className="flex items-center gap-1 rounded border border-line-ui px-2 py-0.5 text-xs text-ink hover:bg-elevated disabled:opacity-50"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="重新检查运行环境"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          重新检查
        </button>
      </div>
    </section>
  );
}
