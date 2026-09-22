import React from 'react';

/*
 * 4 步链路进度轨 —— 本次改版的**签名元素**。
 *
 * 为什么是它：这个产品最核心的信息不是「有多少条内容」，而是**每条内容走到哪一步**
 * （转录 → 洗稿 → 分镜 → 成片）。改造前这个信息散落在步骤卡的角标、按钮文案和
 * 状态徽章里，要读完一整屏才知道。这里把它压成一条可一瞥读出的窄轨，
 * 挂在每个作品 / 每个发布任务上。
 *
 * 状态用**颜色 + 形状**双重编码（清单要求「颜色不能是唯一指示方式」）：
 *   待执行 = 空槽（低对比底）
 *   进行中 = 呼吸块（animate-pulse）
 *   已完成 = 实心块
 *   失败   = 实心块 + 危险色
 * 并且整条轨带 role="img" + 中文 aria-label，读屏能一次听全。
 *
 * 注意 animate-pulse 是 Tailwind 内置动画，不依赖自定义 @keyframes ——
 * 项目里就吃过一次「引用了不存在的 keyframes，进度条静止」的亏。
 */

export type RailState = 'pending' | 'running' | 'succeeded' | 'failed';

export interface RailSegment {
  label: string;
  state: RailState;
}

const STATE_CLASS: Record<RailState, string> = {
  pending: 'bg-line',
  running: 'bg-running animate-pulse',
  succeeded: 'bg-success',
  failed: 'bg-danger',
};

const STATE_TEXT: Record<RailState, string> = {
  pending: '待执行',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
};

export interface ProgressRailProps {
  segments: RailSegment[];
  /** 紧随其后的说明文字（省略则只显示轨） */
  caption?: string;
  className?: string;
}

export function ProgressRail({ segments, caption, className = '' }: ProgressRailProps) {
  const summary = segments.map((s) => `${s.label} ${STATE_TEXT[s.state]}`).join(' · ');
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span role="img" aria-label={summary} title={summary} className="inline-flex items-center gap-[3px]">
        {segments.map((segment) => (
          <span
            key={segment.label}
            className={`h-1 w-4 shrink-0 rounded-full ${STATE_CLASS[segment.state]}`}
          />
        ))}
      </span>
      {caption && <span className="text-xs text-ink-muted">{caption}</span>}
    </span>
  );
}

/** 主链路的四步（顺序即产品语义，来自 PipelineStep）。 */
export const PIPELINE_LABELS = ['转录', '洗稿', '分镜', '成片'] as const;

/**
 * 把 JobRecord.steps / PipelineStepState 映射成轨道分段。
 *
 * 状态语义只有服务端一份：这里只做「已存在的状态 → 轨道状态」的投影，
 * 不重算任何判定（前端复刻判定 = 必然漂移的第二真源）。
 */
export function railSegmentsFromSteps(
  steps: Record<string, { status?: string } | undefined> | undefined,
): RailSegment[] {
  const keys = ['transcribe', 'clean', 'generate_video_prompts', 'generate_video'];
  return PIPELINE_LABELS.map((label, index) => {
    const status = steps?.[keys[index]!]?.status;
    const state: RailState =
      status === 'succeeded'
        ? 'succeeded'
        : status === 'running'
          ? 'running'
          : status === 'failed'
            ? 'failed'
            : 'pending';
    return { label, state };
  });
}
