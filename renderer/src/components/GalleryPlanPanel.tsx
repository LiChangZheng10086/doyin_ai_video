import React, { useState } from 'react';
import type { GalleryPlan } from '../../../src/lib/gallery-types';

export function GalleryPlanPanel({ plan, imageUrls, confirmed, disabled, onConfirmChange, onGenerate }: {
  plan: GalleryPlan; imageUrls: string[]; confirmed: boolean; disabled: boolean;
  onConfirmChange: (value: boolean) => void; onGenerate: () => void;
}) {
  const [loaded, setLoaded] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const allLoaded = plan.images.length > 0 && imageUrls.length === plan.images.length && imageUrls.every(url => loaded.includes(url));
  return <section aria-label="自动图集方案" className="mb-6 rounded-lg border border-accent-line bg-panel p-5">
    <h2 className="text-lg font-semibold text-ink">建议生成 {plan.images.length} 张</h2>
    <p className="mt-2 text-sm text-ink-muted">按原内容顺序组织。下方文字是转录参考，图片取自原视频；请核对候选字幕是否完整、清楚并与文字相符。</p>
    {plan.warnings.map((warning, i) => <p key={i} className="mt-2 text-sm text-warning">{warning}</p>)}
    {plan.excluded.length > 0 && <details className="mt-3 text-sm text-warning"><summary className="cursor-pointer">{plan.excluded.length} 个片段未纳入方案</summary>
      <ul className="mt-2 list-inside list-disc">{plan.excluded.map((item, i) => <li key={i}>第 {item.segmentIndex + 1} 个转录片段：{item.reason}</li>)}</ul>
    </details>}
    <div className="mt-5 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {plan.images.map((item, i) => <article key={i} className="min-w-0 rounded-lg border border-line bg-canvas p-3">
        <h3 className="font-medium text-ink">第 {i + 1} 张 · {item.quotes.length} 条</h3>
        <p className="mt-1 break-words text-sm text-ink-muted">{item.title}</p>
        {imageUrls[i] ? <a href={imageUrls[i]} target="_blank" rel="noreferrer" className="mt-3 block">
          <img src={imageUrls[i]} alt={`第${i + 1}张候选字幕拼图`} className="aspect-[3/4] w-full rounded-lg bg-black object-contain"
            onLoad={() => setLoaded(items => items.includes(imageUrls[i]!) ? items : [...items, imageUrls[i]!])} onError={() => { setFailed(true); onConfirmChange(false); }} />
        </a> : <p role="status" className="my-4 text-sm text-ink-muted">正在准备候选预览…</p>}
        <ol className="mt-3 list-inside list-decimal space-y-2 text-sm text-ink">{item.quotes.map((quote, j) => <li key={j} className="break-words">{quote.text}</li>)}</ol>
      </article>)}
    </div>
    {failed && <p role="alert" className="mt-4 text-sm text-danger">候选图片加载失败，请重新规划或刷新后重试。未能核对图片前不能确认生成。</p>}
    <label className="mt-5 flex items-start gap-2 text-sm text-ink"><input type="checkbox" className="mt-1" checked={confirmed} disabled={disabled || !allLoaded || failed}
      onChange={e => onConfirmChange(e.target.checked)} />我已核对整套候选字幕，认可图片数量与内容安排。</label>
    <button disabled={disabled || !confirmed || !allLoaded || failed} onClick={onGenerate}
      className="mt-4 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-on-accent disabled:opacity-50">按此方案生成整套图集</button>
    <p className="mt-2 text-xs text-ink-muted">生成完成后仍可局部拆图、合图或换句。此操作不会发布内容。</p>
  </section>;
}
