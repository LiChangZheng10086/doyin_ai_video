import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useRuntimeStatus } from '../hooks/useRuntimeStatus';
import type { RuntimeChannelId, RuntimeItem } from '../types/index.js';
import { formatAge } from '../utils/runtime';
import { RuntimeStatusList } from './RuntimeStatusList';

/**
 * 设置页 › 运行环境（**深检层**，spec §6.2）。
 *
 * 这是**唯一常驻的状态呈现处**：三个渠道 + 两项发布链路依赖 + 深检动作 + 逐层诊断 +
 * 可照抄的动作 + （默认收起的）诊断信息。
 *
 * 它是免费检查的**唯一消费者**，深检是手动动作 —— 理由是登录态验证会开浏览器、会与
 * 发布抢同一个 profile（spec §5.2）。
 */

export interface RuntimeEnvironmentPanelProps {
  /** 「去登录」：把设置页切到对应登录分组（分组切换由 SettingsPage 掌管）。 */
  onGoToSection?: (target: RuntimeChannelId) => void;
}

export function RuntimeEnvironmentPanel({ onGoToSection }: RuntimeEnvironmentPanelProps) {
  const { status, loading, error, check, refresh, verify, cancel } = useRuntimeStatus();
  const now = new Date();

  const items: RuntimeItem[] = status ? [...status.channels, ...status.dependencies] : [];

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-ink">运行环境</h2>
          <p className="mt-1 text-sm text-ink-muted leading-relaxed">
            免费检查零副作用（不开浏览器、不写文件）；「验证登录态」会打开浏览器，
            <strong>同渠道的发布请等它结束</strong>。
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {status && (
            <span className="text-xs text-ink-subtle">
              本次检查：{formatAge(status.checkedAt, now)}
            </span>
          )}
          <button
            type="button"
            className="flex items-center gap-1 rounded border border-line-ui px-3 py-1.5 text-sm text-ink hover:bg-elevated disabled:opacity-50"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
            重新检查
          </button>
        </div>
      </header>

      {error && (
        <p className="rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
          {error}
        </p>
      )}

      {!status && loading && <p className="text-sm text-ink-muted">正在检查…</p>}

      {status && (
        <>
          <RuntimeStatusList
            items={items}
            variant="full"
            check={check}
            now={now}
            onVerify={(id) => void verify(id)}
            onCancel={() => void cancel()}
            {...(onGoToSection ? { onLogin: onGoToSection } : {})}
          />
          <Diagnostics buildTag={status.buildTag} />
        </>
      )}
    </section>
  );
}

/**
 * 诊断信息：**默认收起、不进主视觉**（UI 重构 spec §2：「版本与开发端口退出主视觉」）。
 *
 * 它存在是为了那个反复踩的坑：`dist/` 与 `dist-electron/` **互不覆盖**，
 * 「改了没生效」多半是踩了其中一个 —— 两份 mtime 一眼就能看出来。
 */
function Diagnostics({ buildTag }: { buildTag?: { backend?: { path: string; mtime: string }; electron?: { path: string; mtime: string } } }) {
  const hasAny = Boolean(buildTag?.backend || buildTag?.electron);
  if (!hasAny) return null;
  const now = new Date();

  return (
    <details className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-ink-muted">
      <summary className="cursor-pointer text-ink-subtle">诊断信息</summary>
      <div className="mt-2 space-y-1">
        {buildTag?.backend && (
          <p className="font-mono break-all">
            后端 dist/：{buildTag.backend.mtime}（{formatAge(buildTag.backend.mtime, now)}）· {buildTag.backend.path}
          </p>
        )}
        {buildTag?.electron && (
          <p className="font-mono break-all">
            Electron dist-electron/：{buildTag.electron.mtime}（{formatAge(buildTag.electron.mtime, now)}）· {buildTag.electron.path}
          </p>
        )}
      </div>
    </details>
  );
}
