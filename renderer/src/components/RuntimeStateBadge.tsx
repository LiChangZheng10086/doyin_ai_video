import React from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react';
import type { RuntimeState } from '../types/index.js';
import { runtimeStateMeta, type RuntimeStateMeta } from '../utils/runtime';

/**
 * 状态徽章：**图标 + 文字**，颜色只做辅助。
 *
 * UI 重构 spec §5.1 要求「状态不能只靠颜色表达，必须同时显示图标或文字」——
 * 色盲用户、以及把所有状态点看成同一片灰的低对比屏幕，都只能靠这一条。
 */

const ICONS = {
  check: CheckCircle2,
  warn: AlertTriangle,
  x: XCircle,
  help: HelpCircle,
} as const;

/** 只用**既有** token，本设计不新增 design token（`theme.test.ts` 是门禁）。 */
const TONES: Record<RuntimeStateMeta['tone'], string> = {
  success: 'border-success-line bg-success-soft text-success',
  warning: 'border-warning-line bg-warning-soft text-warning',
  danger: 'border-danger-line bg-danger-soft text-danger',
  subtle: 'border-line bg-elevated text-ink-subtle',
};

export function RuntimeStateBadge({ state }: { state: RuntimeState }) {
  const meta = runtimeStateMeta(state);
  const Icon = ICONS[meta.icon];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${TONES[meta.tone]}`}
      data-runtime-state={state}
    >
      <Icon size={12} aria-hidden="true" />
      {meta.label}
    </span>
  );
}
