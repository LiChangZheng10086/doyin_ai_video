import React from 'react';
import type { GalleryOperation } from '../../../src/lib/gallery-types';

const stageNames: Record<GalleryOperation['stage'], string> = { content: 'AI整理内容', ocr: '识别原视频字幕', candidates: '制作候选图片', render: '生成成品图片', copy: '整理配套文案' };
const statusNames: Record<GalleryOperation['status'], string> = { running: '处理中', pausing: '暂停中', paused: '已暂停', completed: '已完成', failed: '失败', interrupted: '已中断' };
export function GalleryOperationPanel({ operation, disabled, onPause, onResume }: {
  operation: GalleryOperation; disabled: boolean; onPause: () => void; onResume: () => void;
}) {
  const percentage = operation.total > 0 ? Math.floor(operation.completed / operation.total * 100) : null;
  return <section aria-label="图集处理进度" className="mb-5 rounded-lg border border-line bg-panel p-5">
    <h2 className="font-semibold text-ink">{stageNames[operation.stage]} · {statusNames[operation.status]}</h2>
    <p role="status" className="mt-2 text-sm text-ink-muted">{operation.completed} / {operation.total} {percentage !== null && `· ${percentage}%`}</p>
    <progress aria-label={`${stageNames[operation.stage]}进度`} {...(operation.total > 0 ? { value: operation.completed, max: operation.total } : {})} className="mt-3 h-3 w-full accent-accent" />
    {operation.status === 'running' && <button disabled={disabled} onClick={onPause} className="mt-3 rounded-lg border border-line px-3 py-2 text-sm text-ink disabled:opacity-50">暂停</button>}
    {operation.status === 'pausing' && <p className="mt-3 text-sm text-ink-muted">正在等待当前处理单元安全结束，随后停止后续处理。</p>}
    {operation.status === 'paused' && <button disabled={disabled} onClick={onResume} className="mt-3 rounded-lg bg-accent px-3 py-2 text-sm text-on-accent disabled:opacity-50">继续</button>}
    {['running', 'pausing', 'paused'].includes(operation.status) && <p className="mt-3 text-xs text-ink-muted">可离开此页面并操作其他作品，返回后可查看进度。退出应用会中断本次处理。</p>}
    {operation.status === 'interrupted' && <p role="alert" className="mt-3 text-sm text-warning">应用退出后处理已中断，请核对来源并重新发起。旧成品保留供参考。</p>}
    {operation.error && <p role="alert" className="mt-3 break-words text-sm text-danger">{operation.error}</p>}
  </section>;
}
