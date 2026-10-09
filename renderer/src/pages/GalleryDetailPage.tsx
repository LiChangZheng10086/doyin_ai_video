import React, { useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { Layout } from '../components/Layout';
import { GalleryPlanPanel } from '../components/GalleryPlanPanel';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { apiClient, parseApiError } from '../services/api';
import type { Gallery, GalleryImage, GalleryPreview, GallerySource } from '../../../src/lib/gallery-types';
import type { RawTranscript } from '../types';
import { duplicateGalleryImage, moveGalleryImage, splitGalleryImage, mergeGalleryImage } from '../utils/gallery';

const fieldClass = 'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink focus:outline-accent';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-elevated disabled:opacity-50';

export function GalleryDetailPage() {
  const { id = '' } = useParams();
  const [gallery, setGallery] = useState<Gallery | null>(null);
  const [source, setSource] = useState<GallerySource | null>(null);
  const [transcript, setTranscript] = useState<RawTranscript | null>(null);
  const [error, setError] = useState('');
  const [sourceError, setSourceError] = useState('');
  useEffect(() => {
    let active = true; setGallery(null); setSource(null); setError(''); setSourceError('');
    void apiClient.getGallery(id).then(async g => {
      const [info, text] = await Promise.all([apiClient.getGallerySource(id).catch(e => { if (active) setSourceError(parseApiError(e).message); return null; }), apiClient.getJobRawTranscript(g.sourceJobId).catch(() => null)]);
      if (active) { setGallery(g); setSource(info); setTranscript(text); }
    }).catch(e => { if (active) setError(parseApiError(e).message); });
    return () => { active = false; };
  }, [id]);
  return <Layout>{error ? <div role="alert" className="text-danger">{error}<Link to="/galleries" className="ml-3 underline">返回图集</Link></div> : gallery ?
    <GalleryWorkspace key={gallery.id} initial={gallery} source={source ?? { width: 1, height: 1, duration: 0 }} sourceError={sourceError} transcript={transcript} /> : <p role="status" className="text-ink-muted">正在加载创作草稿…</p>}</Layout>;
}

export function GalleryWorkspace({ initial, source, sourceError = '', transcript }: { initial: Gallery; source: GallerySource; sourceError?: string; transcript: RawTranscript | null }) {
  const navigate = useNavigate();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<GalleryPreview | null>(null);
  const [rights, setRights] = useState(false);
  const [tagText, setTagText] = useState(initial.hashtags.join(' '));
  const [activeTranscript, setActiveTranscript] = useState(transcript);
  const [targetLines, setTargetLines] = useState(8);
  const [calibrate, setCalibrate] = useState(false);
  const [bandTop, setBandTop] = useState(0.78);
  const [bandBottom, setBandBottom] = useState(0.96);
  const [planConfirmed, setPlanConfirmed] = useState(false);
  const [planImageUrls, setPlanImageUrls] = useState<string[]>([]);
  const [retranscribeOpen, setRetranscribeOpen] = useState(false);
  const [copyReplaceOpen, setCopyReplaceOpen] = useState(false);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [frame, setFrame] = useState<{ url: string; time: number } | null>(null);
  const [frameBusy, setFrameBusy] = useState(false);
  const [frameError, setFrameError] = useState('');
  const frameRequest = useRef(0);
  const frameUrl = useRef('');
  const mounted = useRef(true);
  const image = draft.images[selected]!;
  const segments = (activeTranscript?.segments ?? []).flatMap(s => typeof s.start === 'number' && typeof s.end === 'number'
    && Number.isFinite(s.start) && Number.isFinite(s.end) ? [{ start: s.start, end: s.end, text: s.text }] : []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const imagesDirty = JSON.stringify(draft.images) !== JSON.stringify(saved.images);
  const working = !!busy || saved.status === 'running';
  const locked = working || !!sourceError;
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm('还有未保存的图集修改，确定离开？')) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);
  const accept = (g: Gallery) => { setSaved(g); setDraft(g); setTagText(g.hashtags.join(' ')); setPreview(null); setRights(false); setPlanConfirmed(false); };
  const edit = (patch: Partial<Gallery>) => { setDraft(g => ({ ...g, ...patch })); setPreview(null); setRights(false); setPlanConfirmed(false); setNotice(''); };
  const editImage = (patch: Partial<GalleryImage>) => edit({ images: draft.images.map((item, i) => i === selected ? { ...item, ...patch } : item) });
  const save = async () => {
    const g = dirty ? await apiClient.saveGallery(draft.id, { ...draft, version: saved.version }) : saved;
    accept(g); return g;
  };
  const action = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(''); setNotice('');
    try { await fn(); }
    catch (e) { setError(parseApiError(e).message); }
    finally { setBusy(''); }
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; frameRequest.current++; if (frameUrl.current) URL.revokeObjectURL(frameUrl.current); };
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    let active = true;
    if (saved.generated) void Promise.all(saved.generated.hashes.map((_, i) => apiClient.getGalleryImageUrl(saved.id, i, saved.generated!.id))).then(urls => { if (active) setImageUrls(urls); });
    return () => { active = false; };
  }, [saved.id, saved.version]);
  useEffect(() => {
    let active = true; setPlanImageUrls([]);
    if (saved.plan) void Promise.all(saved.plan.images.map((_, i) => apiClient.getGalleryPlanImageUrl(saved.id, i, saved.plan!.id, saved.version)))
      .then(urls => { if (active) setPlanImageUrls(urls); }).catch(e => { if (active) setError(parseApiError(e).message); });
    return () => { active = false; };
  }, [saved.id, saved.version, saved.plan?.id]);
  useEffect(() => {
    if (saved.status !== 'running') return;
    const timer = window.setInterval(() => {
      void apiClient.getGallery(saved.id).then(g => { if (g.status !== 'running') accept(g); }).catch(e => setError(parseApiError(e).message));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [saved.id, saved.status]);
  const showFrame = async (time: number) => {
    const token = ++frameRequest.current;
    setFrameBusy(true); setFrameError('');
    try {
      const url = await apiClient.getGalleryFrame(draft.id, time);
      if (token !== frameRequest.current || !mounted.current) { URL.revokeObjectURL(url); return; }
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
      frameUrl.current = url; setFrame({ url, time });
    } catch (e) { if (token === frameRequest.current) setFrameError(parseApiError(e).message); }
    finally { if (token === frameRequest.current) setFrameBusy(false); }
  };
  const generate = async () => {
    const g = await save();
    try { accept(await apiClient.renderGallery(g.id, g.version)); setNotice('整套图集已生成，请逐张核对字幕，再准备发布。'); }
    catch (e) { accept(await apiClient.getGallery(g.id)); throw e; }
  };
  const plan = async () => {
    const g = await apiClient.planGallery(saved.id, { version: saved.version, targetLines, ...(calibrate ? { bandTop, bandBottom } : {}) });
    accept(g); select(0); setNotice('图片方案已准备，请核对整套候选和配套文案。已有文案会保留。');
  };
  const generateCopy = async () => {
    const g = await save();
    accept(await apiClient.generateGalleryCopy(g.id, g.version));
    setNotice('配套文案已生成，图片与方案已保留。请核对人物、数字和来源事实。');
  };
  const generatePlan = async () => {
    if (!saved.plan || dirty || !planConfirmed) return;
    try { accept(await apiClient.renderGalleryPlan(saved.id, saved.version, saved.plan.id, true)); select(0); setNotice('整套图集已生成，可继续局部微调或准备发布。'); }
    catch (e) { accept(await apiClient.getGallery(saved.id)); throw e; }
  };
  const retranscribe = async () => {
    await apiClient.retranscribeJob(saved.sourceJobId);
    setActiveTranscript(await apiClient.getJobRawTranscript(saved.sourceJobId));
    setRetranscribeOpen(false); setNotice('转录已更新，请重新规划；原有图集与发布包已保留。');
  };
  const viewPreview = async () => {
    const g = await save(); const result = await apiClient.previewGallery(g.id, g.version); setPreview(result);
  };
  const publish = async () => {
    if (!preview || dirty) return;
    await apiClient.createGalleryPackage(draft.id, preview.previewRevision, rights);
    navigate(`/publishing?channel=douyin&contentType=note&status=all`);
  };
  const select = (index: number) => { setSelected(index); setFrame(null); frameRequest.current++; setFrameBusy(false); };
  return <div>
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div><Link to="/galleries" className="text-sm text-accent">← 图集创作</Link><h1 className="mt-2 text-2xl font-semibold text-ink">字幕图集工作台</h1>
        <p className="mt-2 text-sm text-ink-muted">保留原视频字幕，不绘制转录文字。{!sourceError && <>原视频 {source.width}×{source.height} · {source.duration.toFixed(1)} 秒 · </>}<Link className="text-accent" to={`/jobs/${draft.sourceJobId}`}>查看来源</Link></p></div>
      <div className="flex flex-wrap gap-2"><button disabled={locked} className={buttonClass} onClick={() => void action('保存中', async () => { await save(); setNotice('创作草稿已保存'); })}>保存草稿{dirty ? ' *' : ''}</button>
      </div>
    </div>
    {error && <div role="alert" className="mb-4 rounded-lg border border-danger-line bg-danger-soft p-4 text-sm text-danger">{error}</div>}
    {sourceError && <p role="alert" className="mb-4 text-sm text-danger">{sourceError}。已保存的文案与成品仍可查看；恢复来源后才能编辑、生成或建包。</p>}
    {notice && <p role="status" className="mb-4 text-sm text-success">{notice}</p>}
    {saved.error && <p role="alert" className="mb-4 text-sm text-danger">上次生成：{saved.error}</p>}
    {working && <p role="status" className="mb-4 text-sm text-ink-muted">{busy || '图集生成中'}…请等待操作完成，避免关闭应用。</p>}
    <section className="mb-5 rounded-lg border border-line bg-panel p-5">
      <h2 className="font-semibold text-ink">先规划整套图文，再一键生成</h2>
      <p className="mt-2 text-sm text-ink-muted">自动规划字幕图片，并根据完整视频内容整理标题、正文和话题。你只需核对图片与文案，无须逐张创建或逐句输入时间。</p>
      {!!activeTranscript?.qualityIssues?.length && <div role="alert" className="mt-3 text-sm text-warning"><p>转录存在异常，请先重新转录：</p>{activeTranscript.qualityIssues.map((issue, i) => <p key={i}>{issue}</p>)}</div>}
      <div className="mt-4 flex flex-wrap items-center gap-3"><label className="text-sm text-ink">每张目标条数 <select aria-label="每张目标条数" value={targetLines} disabled={locked}
        onChange={e => { setTargetLines(Number(e.target.value)); setPlanConfirmed(false); }} className="ml-2 rounded-lg border border-line bg-canvas px-3 py-2">{[6, 7, 8, 9].map(n => <option key={n} value={n}>{n} 条{n === 8 ? '（默认）' : ''}</option>)}</select></label>
        <button disabled={locked || dirty || !!activeTranscript?.qualityIssues?.length || !segments.length} className="rounded-lg bg-accent px-4 py-2 text-sm text-on-accent disabled:opacity-50" onClick={() => void action('规划图片与文案中', plan)}>{busy === '规划图片与文案中' && <Loader2 size={16} className="mr-2 inline animate-spin" />}自动创作整套图文</button>
        <button disabled={locked || dirty} className={buttonClass} onClick={() => setRetranscribeOpen(true)}>重新转录来源视频</button>
      </div>
      {dirty && <p className="mt-2 text-sm text-warning">请先保存现有修改，再重新规划。新方案在确认前不会替换当前图片。</p>}
      {!segments.length && <p className="mt-2 text-sm text-ink-muted">自动规划需要带时间的转录，请先重新转录来源视频；已有手动草稿可在高级调整中继续编辑。</p>}
      <details className="mt-4"><summary className="cursor-pointer text-sm text-ink-muted">整套字幕区域校准（可选）</summary>
        <label className="mt-3 flex gap-2 text-sm text-ink"><input type="checkbox" checked={calibrate} disabled={locked} onChange={e => { setCalibrate(e.target.checked); setPlanConfirmed(false); }} />用统一区域重新规划；关闭时自动建议区域。</label>
        {calibrate && <div className="mt-3 flex flex-wrap gap-3"><NumberField label="整套字幕上边界（0～1）" value={bandTop} max={1} step={0.01} onChange={n => { setBandTop(n); setPlanConfirmed(false); }} /><NumberField label="整套字幕下边界（0～1）" value={bandBottom} max={1} step={0.01} onChange={n => { setBandBottom(n); setPlanConfirmed(false); }} /></div>}
      </details>
    </section>
    {saved.plan && <GalleryPlanPanel key={`${saved.plan.id}-${saved.version}`} plan={saved.plan} imageUrls={planImageUrls} confirmed={planConfirmed} disabled={locked || dirty}
      onConfirmChange={setPlanConfirmed} onGenerate={() => void action('生成中', generatePlan)} />}
    <details className="mb-6 rounded-lg border border-line bg-panel p-4"><summary className="cursor-pointer font-semibold text-ink">高级调整 · 手动换句、拆图、合图与时间微调</summary>
    <div className="my-4"><button disabled={locked} className={buttonClass} onClick={() => void action('生成中', generate)}>按高级设置重新生成整套图集</button></div>
    <fieldset disabled={locked} className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[220px_minmax(0,1fr)_300px]">
      <section className="min-w-0 rounded-lg border border-line bg-panel p-4"><h2 className="mb-3 font-semibold text-ink">图片顺序 · {draft.images.length} 张</h2>
        <div className="space-y-3">{draft.images.map((item, i) => <div key={i} className={`rounded-lg border p-3 ${i === selected ? 'border-accent-line bg-accent-soft' : 'border-line'}`}>
          <button className="w-full text-left text-sm font-medium text-ink" onClick={() => select(i)}>第 {i + 1} 张 · {item.times.length} 条字幕</button>
          <div className="mt-2 flex gap-1"><button aria-label={`上移第${i + 1}张`} disabled={i === 0} className={buttonClass} onClick={() => { edit({ images: moveGalleryImage(draft.images, i, -1) }); select(i - 1); }}><ArrowUp size={14} /></button>
            <button aria-label={`下移第${i + 1}张`} disabled={i === draft.images.length - 1} className={buttonClass} onClick={() => { edit({ images: moveGalleryImage(draft.images, i, 1) }); select(i + 1); }}><ArrowDown size={14} /></button>
            <button aria-label={`复制第${i + 1}张`} className={buttonClass} disabled={source.imageLimit !== undefined && draft.images.length >= source.imageLimit} onClick={() => { edit({ images: duplicateGalleryImage(draft.images, i) }); select(i + 1); }}><Copy size={14} /></button>
            <button aria-label={`删除第${i + 1}张`} className={buttonClass} disabled={draft.images.length === 1} onClick={() => { edit({ images: draft.images.filter((_, n) => n !== i) }); select(Math.max(0, i - 1)); }}><Trash2 size={14} /></button></div>
        </div>)}</div>
        <div className="mt-3 flex flex-wrap gap-2"><button className={buttonClass} disabled={image.times.length < 2 || (source.imageLimit !== undefined && draft.images.length >= source.imageLimit)} onClick={() => edit({ images: splitGalleryImage(draft.images, selected) })}>拆分当前图</button>
          <button className={buttonClass} disabled={selected >= draft.images.length - 1 || image.times.length + (draft.images[selected + 1]?.times.length ?? 0) > 9} onClick={() => { edit({ images: mergeGalleryImage(draft.images, selected) }); setNotice('已合并字幕，沿用前一张的字幕区域，请核对并重新生成。'); }}>与下一张合图</button></div>
        <button className={`${buttonClass} mt-3 w-full`} disabled={source.imageLimit !== undefined && draft.images.length >= source.imageLimit} onClick={() => { edit({ images: [...draft.images, structuredClone(initial.images[0]!)] }); select(draft.images.length); }}><Plus size={14} />新增拼图</button>
      </section>
      <section className="min-w-0 rounded-lg border border-line bg-panel p-5"><h2 className="font-semibold text-ink">第 {selected + 1} 张 · 画面校准</h2>
        <p className="mb-4 mt-2 text-xs text-ink-muted">转录时间仅供定位。请查看真实画面，微调时间避开字幕切换，逐条检查完整性。</p>
        <div className="flex flex-wrap items-end gap-3"><NumberField label="主画面时间（秒）" value={image.mainTime} max={source.duration} onChange={mainTime => editImage({ mainTime })} />
          <button className={buttonClass} disabled={frameBusy} onClick={() => void showFrame(image.mainTime)}>查看主画面</button></div>
        <div className="my-4 space-y-2">{image.times.map((time, i) => <div key={i} className="flex flex-wrap items-end gap-2">
          <NumberField label={`字幕 ${i + 1} 时间（秒）`} value={time} max={source.duration} onChange={t => editImage({ times: image.times.map((v, n) => n === i ? t : v) })} />
          <button className={buttonClass} disabled={frameBusy} onClick={() => void showFrame(time)}>查看</button>
          <button aria-label={`字幕${i + 1}前移0.2秒`} className={buttonClass} onClick={() => editImage({ times: image.times.map((v, n) => n === i ? Math.max(0, Number((v - 0.2).toFixed(2))) : v) })}>−0.2s</button>
          <button aria-label={`字幕${i + 1}后移0.2秒`} className={buttonClass} onClick={() => editImage({ times: image.times.map((v, n) => n === i ? Number((v + 0.2).toFixed(2)) : v) })}>+0.2s</button>
          <button aria-label={`移除字幕${i + 1}`} disabled={image.times.length === 1} className={buttonClass} onClick={() => editImage({ times: image.times.filter((_, n) => n !== i) })}><Trash2 size={14} /></button>
        </div>)}</div>
        <button disabled={image.times.length >= 9} className={buttonClass} onClick={() => editImage({ times: [...image.times, image.mainTime] })}><Plus size={14} />增加字幕条</button>
        <div className="my-5 grid grid-cols-1 gap-3 sm:grid-cols-3"><NumberField label="字幕上边界（0～1）" value={image.bandTop} max={1} step={0.01} onChange={bandTop => editImage({ bandTop })} />
          <NumberField label="字幕下边界（0～1）" value={image.bandBottom} max={1} step={0.01} onChange={bandBottom => editImage({ bandBottom })} />
          <NumberField label="主画面比例（0.4～0.85）" value={image.mainFraction} min={0.4} max={0.85} step={0.01} onChange={mainFraction => editImage({ mainFraction })} /></div>
        <p className="mb-4 text-xs text-ink-muted">字幕按原比例适配，不拉伸文字。裁切范围尽量贴合字幕，避免文字缩得过小。</p>
        <details className="mb-4 rounded-lg border border-line p-3"><summary className="cursor-pointer text-sm text-ink">主画面取景（默认保留完整画面）</summary>
          <div className="mt-3 grid grid-cols-2 gap-3">{(['left', 'right', 'top', 'bottom'] as const).map(key => {
            const crop = image.mainCrop ?? { left: 0, right: 1, top: 0, bottom: 1 };
            return <NumberField key={key} label={`取景${{ left: '左', right: '右', top: '上', bottom: '下' }[key]}边界（0～1）`} value={crop[key]} max={1} step={0.01} onChange={n => editImage({ mainCrop: { ...crop, [key]: n } })} />;
          })}</div><button className={`${buttonClass} mt-3`} onClick={() => editImage({ mainCrop: undefined })}>恢复完整画面</button>
        </details>
        {frameBusy && <p role="status" className="text-sm text-ink-muted">正在提取真实画面…</p>}
        {frameError && <p role="alert" className="text-sm text-danger">{frameError}</p>}
        {frame ? <div className="rounded-lg border border-line bg-black p-3"><p className="mb-3 text-xs text-white">候选帧 {frame.time.toFixed(2)}s · 标框为字幕区域</p>
          <div className="relative mx-auto max-h-[60vh] max-w-sm overflow-hidden" style={{ aspectRatio: `${source.width}/${source.height}` }}><img src={frame.url} alt={`${frame.time.toFixed(2)}秒原视频画面`} className="h-full w-full object-contain" />
            <div className="pointer-events-none absolute left-0 right-0 border-2 border-red-500 bg-red-500/10" style={{ top: `${image.bandTop * 100}%`, height: `${(image.bandBottom - image.bandTop) * 100}%` }} /></div>
          <div className="mx-auto mt-4 max-w-sm overflow-hidden border border-line" style={{ aspectRatio: `${source.width}/${source.height * (image.bandBottom - image.bandTop)}` }}>
            <img src={frame.url} alt="字幕裁切预览" className="block w-full max-w-none" style={{ transform: `translateY(-${image.bandTop * 100}%)` }} />
          </div></div> : <div className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-ink-muted">点击「查看」核对主画面或字幕。只有原视频已经带字幕，才能制作原生拼图。</div>}
      </section>
      <section className="min-w-0 rounded-lg border border-line bg-panel p-4"><h2 className="font-semibold text-ink">转录选句</h2><p className="my-2 text-xs text-ink-muted">点击分段，将中点时间追加为字幕候选。文字不会写入图片。</p>
        <div className="max-h-[720px] space-y-2 overflow-y-auto">{segments.length ? segments.map((segment, i) => <button key={i} disabled={image.times.length >= 9} onClick={() => { const t = Math.min(source.duration - 0.01, Math.max(0, (segment.start + segment.end) / 2)); editImage({ times: [...image.times, Number(t.toFixed(2))] }); void showFrame(t); }} className="block w-full rounded-lg border border-line p-3 text-left hover:bg-elevated disabled:opacity-50">
          <span className="font-mono text-xs text-accent">{segment.start.toFixed(1)}–{segment.end.toFixed(1)}s</span><p className="mt-1 text-sm text-ink">{segment.text}</p></button>) : <p className="text-sm text-ink-muted">没有带时间戳的转录，可直接填写时间点；也可回作品执行视频转录。</p>}</div>
      </section>
    </fieldset></details>
    <section className="mt-6 rounded-lg border border-line bg-panel p-5"><h2 className="font-semibold text-ink">整套成品预览</h2>
      <p className="my-2 text-sm text-ink-muted">{saved.status === 'ready' && !imagesDirty ? '按发布顺序逐张检查。文案修改不需要重新生成图片，保存后检查发布预览。' : '修改画面或顺序后须保存并重新生成。下方旧图仅供参考。'}</p>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">{imageUrls.map((url, i) => <a key={url} href={url} target="_blank" rel="noreferrer" className="block"><img src={url} alt={`成品第${i + 1}张`} className="aspect-[3/4] w-full rounded-lg border border-line bg-black object-contain" /><p className="mt-1 text-xs text-ink-muted">第 {i + 1} 张 · 点击查看大图</p></a>)}</div>
    </section>
    <section className="mt-6 rounded-lg border border-line bg-panel p-5"><h2 className="font-semibold text-ink">抖音图文文案</h2>
      <p className="mt-2 text-sm text-ink-muted">正文按背景、编号要点和互动结尾组织。修改文案不需要重新生成图片。人物、数字和经历仍须对照原视频核对。</p>
      {saved.copyError && <p role="alert" className="mt-3 text-sm text-warning">{saved.copyError}</p>}
      {saved.copyReference?.notes.map((note, i) => <p key={i} className="mt-2 text-sm text-warning">待核对：{note}</p>)}
      <button disabled={locked || !segments.length || !!activeTranscript?.qualityIssues?.length} className={`${buttonClass} mt-3`} onClick={() => {
        if (draft.description.trim()) setCopyReplaceOpen(true); else void action('生成文案中', generateCopy);
      }}>{draft.description.trim() ? '重新生成文案' : '生成图文文案'}</button>
      <fieldset disabled={locked} className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2"><div className="space-y-4"><label className="block text-sm text-ink">标题 · {[...draft.title].length}{source.copyLimits ? ` / ${source.copyLimits.titleMax}` : ''}<input value={draft.title} onChange={e => edit({ title: e.target.value })} className={`${fieldClass} mt-2`} /></label>
        <label className="block text-sm text-ink">话题（空格分隔）· {draft.hashtags.length}{source.copyLimits ? ` / ${source.copyLimits.hashtagMax}` : ''}<input value={tagText} onChange={e => { setTagText(e.target.value); edit({ hashtags: e.target.value.split(/\s+/).filter(Boolean) }); }} className={`${fieldClass} mt-2`} /></label></div>
        <label className="block text-sm text-ink">正文 · {[...draft.description].length}{source.copyLimits ? ` / ${source.copyLimits.descriptionMax}` : ''}<textarea value={draft.description} onChange={e => edit({ description: e.target.value })} rows={12} className={`${fieldClass} mt-2`} /></label></fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3"><button disabled={locked} onClick={() => void action('预览检查中', viewPreview)} className={buttonClass}>检查发布预览</button><p className="text-xs text-ink-muted">整套图片准备好后，保存文案并检查发布限额。</p></div>
      {preview && <div className="mt-4 space-y-3 text-sm text-ink"><p>{preview.imageCount} 张图片 · 标题上限 {preview.copyLimits.titleMax} · 正文上限 {preview.copyLimits.descriptionMax} · 话题上限 {preview.copyLimits.hashtagMax}</p>
        {preview.violations.map((v, i) => <p key={i} role="alert" className="text-danger">{v.message}</p>)}
        <label className="flex items-start gap-2"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} disabled={locked} className="mt-1" />我已逐张核对原生字幕，确认拥有原视频及生成图集的发布使用权。</label>
        <button disabled={locked || !rights || dirty || preview.violations.length > 0} onClick={() => void action('创建发布包中', publish)} className="rounded-lg bg-accent px-4 py-2.5 text-on-accent disabled:opacity-50">创建抖音图文发布包</button>
        <p className="text-xs text-ink-muted">此操作只准备发布包。到「发布 → 抖音 → 图文」再次预览后，由你点击提交；不会自动向抖音发送内容。</p>
      </div>}
    </section>
    <ConfirmDialog open={copyReplaceOpen} title="重新生成配套文案" description="将替换当前标题、正文和话题。图片及候选方案会保留；生成失败保留原文案。" confirmLabel="重新生成并替换" busy={working}
      onConfirm={() => { setCopyReplaceOpen(false); void action('生成文案中', generateCopy); }} onClose={() => setCopyReplaceOpen(false)} />
    <ConfirmDialog open={retranscribeOpen} title="重新转录来源视频" description="将保留旧转录和历史成果。新转录通过检查后，来源作品的洗稿、提示词与视频需重新生成；已有图集和发布包不变。" confirmLabel="重新转录" busy={working}
      onConfirm={() => { setRetranscribeOpen(false); void action('重新转录中', retranscribe); }} onClose={() => setRetranscribeOpen(false)} />
  </div>;
}

function NumberField({ label, value, onChange, min = 0, max, step = 0.1 }: { label: string; value: number; onChange: (n: number) => void; min?: number; max: number; step?: number }) {
  return <label className="block min-w-0 text-xs text-ink-muted">{label}<input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ''} onChange={e => onChange(e.target.valueAsNumber)} className={`${fieldClass} mt-1`} /></label>;
}
