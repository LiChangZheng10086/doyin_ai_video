/**
 * 运行环境状态一览的**纯函数**（渲染层唯一的判断逻辑）。
 *
 * 纪律（spec §6.3 / INV-7）：**红灯判定不在这里** —— 四态由服务端给定，前端只做
 * 「状态 → 图标/文案/色调」的映射与尺寸过滤。凡是"什么算异常"的问题，答案都在
 * 服务端的 `state` 字段里。
 *
 * INV-1 在渲染层同样成立：**免费层的文案不谈有效性**。带时间戳的 `verified` 才有资格
 * 说「登录态有效」，所以那句文案只能由 `verifiedLabel()` 产出。
 */

import type {
  RuntimeChannelId,
  RuntimeCheckSummary,
  RuntimeItem,
  RuntimeItemId,
  RuntimeState,
  RuntimeVerifiedRecord,
} from '../types/index.js';

/** 三个发布渠道才有深检通路；`ffmpeg` / `storage` 没有「登录态」可验。 */
export function isRuntimeChannel(id: RuntimeItemId): id is RuntimeChannelId {
  return id === 'douyin' || id === 'toutiao' || id === 'xiaohongshu';
}

export interface RuntimeStateMeta {
  /** 状态词。**必须与图标同时出现**（UI 重构 spec §5.1：状态不能只靠颜色表达）。 */
  label: string;
  /** 图标键（组件侧映射到 lucide 组件；纯函数不 import React）。 */
  icon: 'check' | 'warn' | 'x' | 'help';
  /** 色调键（组件侧映射到**既有** token；本设计不新增 design token）。 */
  tone: 'success' | 'warning' | 'danger' | 'subtle';
}

export function runtimeStateMeta(state: RuntimeState): RuntimeStateMeta {
  switch (state) {
    case 'ready':
      return { label: '就绪', icon: 'check', tone: 'success' };
    case 'degraded':
      return { label: '待确认', icon: 'warn', tone: 'warning' };
    case 'blocked':
      return { label: '不可用', icon: 'x', tone: 'danger' };
    default:
      return { label: '未知', icon: 'help', tone: 'subtle' };
  }
}

/**
 * 概览条上「就绪」项在**窄屏**收起、桌面端全显（spec §6.1 的断点口径）。
 *
 * ⚠️ 这里是**纯 CSS 断点**，不是 JS 判定 —— 服务端渲染的用例、以及首屏无闪烁都靠它。
 * （早先的实现把「只显示非 ready」当成了 compact 的恒定行为，于是桌面端也只显示坏的那几项，
 * 违反 AC-1「打开发布中心即可看到**五项**」。走查时发现并改正。）
 *
 * `full`（设置页）没有这一层：它的每一项都要看。
 */
export function compactVisibilityClass(state: RuntimeState, variant: 'compact' | 'full'): string {
  if (variant === 'full') return '';
  return state === 'ready' ? 'hidden md:block' : '';
}

/** 五项全就绪 —— 只有此时才在窄屏收成一行「环境正常」。 */
export function allReady(items: RuntimeItem[]): boolean {
  return items.length > 0 && items.every((item) => item.state === 'ready');
}

/** 概览条全绿时窄屏显示的那一行。 */
export function compactAllReadyLabel(): string {
  return '环境正常';
}

/**
 * 已运行时长。
 *
 * ⚠️ **不显示百分比、不显示进度条**（INV-5）：`sau` 那条 CLI 不吐任何中间进度，
 * 我们拿不到中间态，所以只陈述事实。
 */
export function formatElapsed(ms: number | undefined): string {
  const seconds = Math.max(0, Math.round((ms ?? 0) / 1000));
  if (seconds < 60) return `已运行 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `已运行 ${minutes} 分 ${seconds % 60} 秒`;
}

/**
 * 深检的耗时预期。
 *
 * 抖音那条是**事实**不是估计：`CHECK_TIMEOUT_MS = 300_000`，上游每次 goto 超时 90s ×
 * 最多重试 3 次。界面必须说出来，否则用户会把它当成卡死。
 */
export function runtimeCheckExpectation(id: RuntimeItemId): string {
  return id === 'douyin' ? '通常 10–30 秒，最坏 5 分钟' : '通常几秒到十几秒';
}

/** 「N 分钟前 / N 小时前」——用于带时间戳的结论。 */
export function formatAge(at: string, now: Date): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return '时间未知';
  const seconds = Math.max(0, Math.round((now.getTime() - parsed) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

/**
 * 「2 小时前 · 登录态有效」。
 *
 * ⚠️ **这是全仓唯一有资格说「有效」的地方** —— 它读的是服务端下发的、带时间戳的
 * `verified` 记录，不是免费层能给出的推断（INV-1）。没有记录就返回 `undefined`，
 * 界面于是什么都不说，而不是编一个「未知」之外的结论。
 */
export function verifiedLabel(item: Pick<RuntimeItem, 'verified'>, now: Date): string | undefined {
  const record: RuntimeVerifiedRecord | undefined = item.verified;
  if (!record) return undefined;
  return `${formatAge(record.at, now)} · 登录态${record.state === 'valid' ? '有效' : '已失效'}`;
}

/** 深检进行中的一行文案：「已运行 42 秒 · 通常 10–30 秒，最坏 5 分钟」。 */
export function runningCheckLabel(check: Pick<RuntimeCheckSummary, 'id' | 'elapsedMs'>): string {
  return `${formatElapsed(check.elapsedMs)} · ${runtimeCheckExpectation(check.id)}`;
}

/** 深检终态的短标签（用于概览条/设置页的状态行）。 */
export function checkStatusLabel(status: RuntimeCheckSummary['status']): string {
  switch (status) {
    case 'running':
      return '检测中';
    case 'succeeded':
      return '已完成';
    case 'cancelled':
      return '已取消';
    default:
      return '未完成';
  }
}
