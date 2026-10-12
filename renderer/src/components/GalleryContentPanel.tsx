import React, { useState } from 'react';
import type { GalleryContentPlan } from '../../../src/lib/gallery-types';

export function GalleryContentPanel({ plan, disabled, onSave, onOrganize, onGenerate, onSelectionChange }: {
  plan: GalleryContentPlan; disabled: boolean; onSave: (selectedIds: string[]) => Promise<void>;
  onOrganize: () => void; onGenerate: (selectedIds: string[]) => void; onSelectionChange?: (dirty: boolean) => void;
}) {
  const [selectedIds, setSelectedIds] = useState(() => plan.items.filter(item => item.selected).map(item => item.id));
  const [confirmed, setConfirmed] = useState(false);
  const dirty = JSON.stringify(selectedIds) !== JSON.stringify(plan.items.filter(item => item.selected).map(item => item.id));
  const overLimit = plan.estimatedImages > 35;
  const select = (ids: string[]) => { setSelectedIds(ids); setConfirmed(false); onSelectionChange?.(JSON.stringify(ids) !== JSON.stringify(plan.items.filter(item => item.selected).map(item => item.id))); };
  return <section aria-label="图集文字方案" className="mb-5 rounded-lg border border-accent-line bg-panel p-5">
    <h2 className="text-lg font-semibold text-ink">先核对文字内容</h2>
    <p className="mt-2 text-sm text-ink">保留 {selectedIds.length} 条 · 剔除 {plan.items.length - selectedIds.length} 条 · 预计 {plan.estimatedImages} 张</p>
    <p className="mt-2 text-sm text-ink-muted">所有原句仍保留在下方。AI只建议保留或剔除，不改写原句；可重新勾选恢复内容。实际图片数量将在候选制作前再次检查。</p>
    {overLimit && <p role="alert" className="mt-3 text-sm text-danger">预计超过 35 张，请先整理内容或调整每张条数，再保存选择；确认前不会识别字幕或绘图。</p>}
    {dirty && <p role="status" className="mt-3 text-sm text-warning">选择已修改，请保存内容选择，重新估算张数后再确认。</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <button disabled={disabled || dirty} onClick={onOrganize} className="rounded-lg border border-line px-3 py-2 text-sm text-ink disabled:opacity-50">AI整理内容</button>
      <button disabled={disabled || selectedIds.length === plan.items.length} onClick={() => select(plan.items.map(item => item.id))} className="rounded-lg border border-line px-3 py-2 text-sm text-ink disabled:opacity-50">恢复全部内容</button>
      <button disabled={disabled || !dirty || !selectedIds.length} onClick={() => void onSave(selectedIds)} className="rounded-lg border border-line px-3 py-2 text-sm text-ink disabled:opacity-50">保存内容选择</button>
    </div>
    <ol className="mt-4 max-h-[32rem] space-y-3 overflow-y-auto">{plan.items.map((item, i) => <li key={item.id} className="rounded-lg border border-line bg-canvas p-3">
      <label className="flex items-start gap-3 text-sm text-ink"><input type="checkbox" checked={selectedIds.includes(item.id)} disabled={disabled} className="mt-1"
        onChange={e => select(plan.items.filter(candidate => candidate.id === item.id ? e.target.checked : selectedIds.includes(candidate.id)).map(candidate => candidate.id))} />
        <span className="min-w-0"><span className="font-mono text-xs text-ink-muted">第 {i + 1} 条 · {item.start.toFixed(1)}–{item.end.toFixed(1)}s</span>
          <span className="mt-1 block break-words">{item.text}</span>{item.originalText && <span className="mt-1 block break-words text-xs text-ink-muted">原文：{item.originalText}</span>}
          {item.reason && <span className="mt-1 block break-words text-xs text-ink-muted">建议理由：{item.reason}</span>}</span>
      </label>
    </li>)}</ol>
    <label className="mt-4 flex items-start gap-2 text-sm text-ink"><input type="checkbox" checked={confirmed} disabled={disabled || dirty || overLimit || !selectedIds.length} className="mt-1" onChange={e => setConfirmed(e.target.checked)} />我已核对原句与时间，认可保留和剔除的内容。</label>
    <button disabled={disabled || dirty || overLimit || !selectedIds.length || !confirmed} onClick={() => onGenerate(selectedIds)} className="mt-4 rounded-lg bg-accent px-4 py-2.5 text-sm text-on-accent disabled:opacity-50">认可文字，生成候选</button>
  </section>;
}
