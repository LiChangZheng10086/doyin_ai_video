import React, { useState } from 'react';
import type { Gallery, GalleryTranslation } from '../../../src/lib/gallery-types';
import { ConfirmDialog } from './ui/ConfirmDialog';

export function GalleryTranslationPanel({ gallery, duration, disabled, dirty, onTranslate, onEdit }: {
 gallery: Gallery; duration: number; disabled: boolean; dirty: boolean;
 onTranslate: (start: number, end: number) => void; onEdit: (translation: GalleryTranslation) => void;
}) {
 const [start,setStart] = useState(gallery.translation?.start ?? 0);
 const [end,setEnd] = useState(gallery.translation?.end ?? Math.min(duration,120));
 const [replace,setReplace] = useState(false);
 const valid=Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&end<=duration;
 const field='mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink';
 const translate=()=>{setReplace(false);onTranslate(start,end);};
 return <section aria-label="中文译文与原文核对" className="mb-5 rounded-lg border border-line bg-panel p-5">
  <h2 className="font-semibold text-ink">中文译文 · 原文保留供核对</h2>
  <p className="mt-2 text-sm text-ink-muted">先选择励志片段，再翻译并逐句核对。默认选取前两分钟，原文全文仍在来源作品中；与边界重叠的字幕会完整保留。图片将绘制中文译文，不代表原视频自带中文字幕。</p>
  <fieldset disabled={disabled} className="mt-4 flex flex-wrap items-end gap-3">
   <label className="text-sm text-ink">翻译开始（秒）<input aria-label="翻译开始（秒）" type="number" value={Number.isFinite(start)?start:''} min={0} max={duration} step={.1} className={field} onChange={e=>setStart(e.target.valueAsNumber)}/></label>
   <label className="text-sm text-ink">翻译结束（秒）<input aria-label="翻译结束（秒）" type="number" value={Number.isFinite(end)?end:''} min={0} max={duration} step={.1} className={field} onChange={e=>setEnd(e.target.valueAsNumber)}/></label>
   <button disabled={dirty||!valid} className="rounded-lg bg-accent px-4 py-2 text-sm text-on-accent disabled:opacity-50" onClick={()=>gallery.translation?setReplace(true):translate()}>翻译所选片段</button>
  </fieldset>
  {!valid&&<p className="mt-2 text-sm text-warning">请选择视频时长内的有效范围。</p>}
  {dirty&&<p className="mt-2 text-sm text-warning">请先保存修改，再翻译新片段。</p>}
  {gallery.translation&&<>
   <p className="mt-4 text-sm text-ink-muted">当前译文：{gallery.translation.start.toFixed(1)}～{gallery.translation.end.toFixed(1)} 秒，共 {gallery.translation.cues.length} 条。修改中文后保存，再重新规划图片。</p>
   <div className="mt-3 max-h-[560px] space-y-3 overflow-y-auto">{gallery.translation.cues.map((cue,i)=><article key={cue.segmentIndex} className="rounded-lg border border-line p-3">
    <p className="text-xs text-ink-muted">{i+1} · {cue.start.toFixed(1)}～{cue.end.toFixed(1)} 秒 · 原文</p><p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{cue.original}</p>
    <label className="mt-2 block text-sm text-ink">中文译文 {i+1}<textarea aria-label={`中文译文 ${i+1}`} value={cue.text} rows={2} maxLength={240} disabled={disabled} className={field}
     onChange={e=>onEdit({...gallery.translation!,cues:gallery.translation!.cues.map((c,n)=>n===i?{...c,text:e.target.value}:c)})}/></label>
   </article>)}</div>
  </>}
  <ConfirmDialog open={replace} title="重新翻译片段" description="将替换已保存译文并使旧图片方案失效。失败保留原译文和旧图；原文与已建发布包保留。" confirmLabel="重新翻译" onConfirm={translate} onClose={()=>setReplace(false)} busy={disabled}/>
 </section>;
}
