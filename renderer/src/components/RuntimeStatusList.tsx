import React from 'react';
import type { RuntimeChannelId, RuntimeCheckSummary, RuntimeItem } from '../types/index.js';
import {
  checkStatusLabel,
  compactAllReadyLabel,
  isRuntimeChannel,
  runningCheckLabel,
  verifiedLabel,
  visibleItems,
} from '../utils/runtime';
import { RuntimeStateBadge } from './RuntimeStateBadge';

/**
 * 运行环境状态行 —— **一个组件、两种尺寸**，渲染同一份模型。
 *
 * 发布中心用 `compact`（只显示非 ready，贴着决策现场），设置页「运行环境」用 `full`
 * （全显 + 逐层诊断 + 动作）。**判定全在服务端**：这里只读 `item.state`，绝不自己算红灯
 * （INV-7）—— 两处呈现因此不可能漂。
 */

export interface RuntimeStatusListProps {
  items: RuntimeItem[];
  variant: 'compact' | 'full';
  /** 当前或最近一次深检（可空）。 */
  check?: RuntimeCheckSummary | null;
  /** 「去登录」；不传则不渲染（只读场景）。 */
  onLogin?: (id: RuntimeChannelId) => void;
  /** 「验证登录态」；只在 `full` 下渲染。 */
  onVerify?: (id: RuntimeChannelId) => void;
  /** 「取消检测」；不传则不渲染。 */
  onCancel?: (checkId: string) => void;
  /** 便于用例固定「N 分钟前」的基准时刻。 */
  now?: Date;
}

export function RuntimeStatusList({
  items,
  variant,
  check,
  onLogin,
  onVerify,
  onCancel,
  now = new Date(),
}: RuntimeStatusListProps) {
  const visible = visibleItems(items, variant);

  if (visible.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink-muted">
        {compactAllReadyLabel()}
      </div>
    );
  }

  return (
    <ul className="space-y-2" data-runtime-variant={variant}>
      {visible.map((item) => (
        <RuntimeRow
          key={item.id}
          item={item}
          variant={variant}
          now={now}
          {...(onLogin ? { onLogin } : {})}
          {...(onVerify ? { onVerify } : {})}
        />
      ))}
      {check && check.status === 'running' && (
        <li className="rounded-lg border border-running-line bg-running-soft px-3 py-2" data-runtime-check="running">
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink">{checkStatusLabel(check.status)}</span>
            <span className="text-xs text-ink-muted">{runningCheckLabel(check)}</span>
            {onCancel && (
              <button
                type="button"
                className="ml-auto rounded border border-line-ui px-2 py-0.5 text-xs text-ink hover:bg-elevated"
                onClick={() => onCancel(check.checkId)}
              >
                取消检测
              </button>
            )}
          </div>
          {/*
            ⚠️ 这里**没有进度条**：CLI 不吐中间进度，我们拿不到中间态。
            只陈述「已运行多少秒」与耗时区间（INV-5）。
          */}
          <p className="mt-1 text-xs text-ink-subtle">取不到中间进度，所以这里不显示百分比。</p>
        </li>
      )}
    </ul>
  );
}

function RuntimeRow({
  item,
  variant,
  now,
  onLogin,
  onVerify,
}: {
  item: RuntimeItem;
  variant: 'compact' | 'full';
  now: Date;
  onLogin?: (id: RuntimeChannelId) => void;
  onVerify?: (id: RuntimeChannelId) => void;
}) {
  const verified = verifiedLabel(item, now);
  const channel = isRuntimeChannel(item.id);
  // 概览条只在**真的发不出去**时才摊开可照抄的动作，避免发布现场被塞满
  const showGuidance = (item.guidance?.length ?? 0) > 0 && (variant === 'full' || item.state === 'blocked');

  return (
    <li
      className="rounded-lg border border-line bg-panel px-3 py-2"
      data-runtime-item={item.id}
      data-runtime-state={item.state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{item.label}</span>
        <RuntimeStateBadge state={item.state} />
        <span className="min-w-0 flex-1 truncate text-xs text-ink-muted" title={item.detail}>
          {item.detail}
        </span>
        {/* 只有带时间戳的 verified 才有资格谈有效性（INV-1） */}
        {verified && <span className="text-xs text-ink-subtle">{verified}</span>}
        <div className="ml-auto flex shrink-0 gap-2">
          {channel && onLogin && (
            <button
              type="button"
              className="rounded border border-line-ui px-2 py-0.5 text-xs text-ink hover:bg-elevated"
              onClick={() => onLogin(item.id as RuntimeChannelId)}
            >
              去登录
            </button>
          )}
          {channel && variant === 'full' && onVerify && (
            <button
              type="button"
              className="rounded border border-accent-line bg-accent-soft px-2 py-0.5 text-xs text-accent hover:bg-elevated"
              onClick={() => onVerify(item.id as RuntimeChannelId)}
            >
              验证登录态
            </button>
          )}
        </div>
      </div>

      {showGuidance && (
        <div className="mt-2 rounded border border-line bg-well px-2 py-1.5">
          <p className="mb-1 text-[11px] text-ink-subtle">可照抄的动作</p>
          {item.guidance!.map((line) => (
            <p key={line} className="font-mono text-[11px] leading-relaxed text-ink-muted">
              {line}
            </p>
          ))}
        </div>
      )}

      {variant === 'full' && item.evidence && <RuntimeEvidence item={item} />}
    </li>
  );
}

function RuntimeEvidence({ item }: { item: RuntimeItem }) {
  const evidence = item.evidence!;
  const attempts = evidence.attempts ?? [];
  const paths = evidence.paths ?? [];
  if (attempts.length === 0 && paths.length === 0 && !evidence.errno && !evidence.notes?.length) return null;

  return (
    <details className="mt-2 text-xs text-ink-muted">
      <summary className="cursor-pointer text-ink-subtle">逐层诊断</summary>
      <div className="mt-1 space-y-1">
        {paths.map((entry) => (
          <p key={`${entry.label}:${entry.value}`} className="font-mono break-all">
            {entry.label}：{entry.value}
          </p>
        ))}
        {attempts.map((attempt) => (
          <p key={attempt.layer} className="font-mono break-all">
            {attempt.layer} {attempt.ok ? '✓' : '✕'} {attempt.detail}
          </p>
        ))}
        {evidence.errno && <p className="font-mono">errno：{evidence.errno}</p>}
        {evidence.notes?.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
    </details>
  );
}
