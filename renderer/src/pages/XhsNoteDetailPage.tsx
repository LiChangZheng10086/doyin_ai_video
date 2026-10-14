import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { apiClient, parseApiError, type ApiClient } from '../services/api';
import { renderXhsNoteCards } from '../utils/xhs-note-cards';
import type { XhsNote, XhsNoteDraft, XhsNotePreview } from '../../../src/lib/xhs-notes';
import type { AssetRecord } from '../types';

const sourceKeys = ['sourceText', 'sourceAuthor', 'sourceUrl', 'audience', 'voiceSample', 'instructions'] as const;
const draftKeys = [...sourceKeys, 'title', 'description', 'hashtags', 'cards', 'reviewNotes', 'imageMode', 'imageAssetIds'] as const;
const inputClass = 'mt-2 w-full rounded-lg border border-line-ui bg-well p-3 text-sm leading-6 text-ink';
const panelClass = 'min-w-0 space-y-4 rounded-lg border border-line bg-panel p-4 sm:p-5';

export function editXhsNote(note: XhsNote, patch: Partial<XhsNoteDraft>): XhsNote {
  const next = { ...note, ...patch };
  if (sourceKeys.some(key => patch[key] !== undefined && patch[key] !== note[key])) next.contentSourceHash = undefined;
  if (patch.cards && JSON.stringify(patch.cards) !== JSON.stringify(note.cards)) next.cardImageHash = undefined;
  return next;
}

export function xhsNoteChanges(saved: XhsNote, draft: XhsNote): Partial<XhsNoteDraft> & { version: number } {
  return { ...Object.fromEntries(draftKeys.filter(key => JSON.stringify(saved[key]) !== JSON.stringify(draft[key])).map(key =>
    [key, key === 'hashtags' || key === 'reviewNotes' ? draft[key].filter(line => line.trim()) : draft[key]])), version: saved.version };
}

export async function bindXhsNoteCardImages(
  saved: XhsNote,
  client: Pick<ApiClient, 'uploadImageAssets' | 'saveXhsNote'> = apiClient,
  render: typeof renderXhsNoteCards = renderXhsNoteCards,
): Promise<XhsNote> {
  // 上传期间只能绑定渲染快照的版本；409 不得换用新版本重试。
  const version = saved.version;
  const files = await render(saved.cards);
  const result = await client.uploadImageAssets(files);
  if (result.failures?.length || result.assets.length !== files.length) {
    throw new Error('图卡上传未全部成功，原有选图保留。已上传的图片仍在素材库，请重试整套生成。' + (result.failures?.map(f => f.message).join('；') || ''));
  }
  return client.saveXhsNote(saved.id, { version, imageMode: 'cards', imageAssetIds: result.assets.map(asset => asset.id) });
}

export function XhsNoteDetailPage() {
  const { id } = useParams();
  const [note, setNote] = useState<XhsNote | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setNote(null); setError('');
    if (id) void apiClient.getXhsNote(id).then(result => { if (active) setNote(result); }).catch(e => { if (active) setError(parseApiError(e).message); });
    return () => { active = false; };
  }, [id]);
  if (!note) return <Layout><Link to="/xhs-notes" className="text-sm text-accent">返回小红书创作</Link><p role={error ? 'alert' : 'status'} className="mt-4 text-sm text-ink-muted">{error || '正在加载笔记…'}</p></Layout>;
  return <XhsNoteWorkspace key={note.id} initial={note} />;
}

export function XhsNoteWorkspace({ initial }: { initial: XhsNote }) {
  const navigate = useNavigate();
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [assetError, setAssetError] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [confirm, setConfirm] = useState<'rewrite' | 'reload' | null>(null);
  const [preview, setPreview] = useState<XhsNotePreview | null>(null);
  const [rights, setRights] = useState(false);
  const working = useRef(false);
  const mounted = useRef(true);
  const dirty = Object.keys(xhsNoteChanges(saved, draft)).length > 1;
  const sourceLength = Array.from(draft.sourceText).length;
  const voiceLength = Array.from(draft.voiceSample).length;
  const cardsStale = draft.imageMode === 'cards' && !draft.cardImageHash;
  const limits = preview?.copyLimits ?? { titleMax: 20, descriptionMax: 1000, hashtagMax: 10, hashtagLengthMax: 20 };
  const imageLimit = preview?.imageLimit ?? 18;
  const packageReady = !!preview && preview.note.version === saved.version && !dirty && rights;

  const loadAssets = async () => {
    try { const items = await apiClient.getAssets('image'); if (mounted.current) { setAssets(items); setAssetError(''); } }
    catch (e) { if (mounted.current) setAssetError(parseApiError(e).message); }
  };
  useEffect(() => { mounted.current = true; void loadAssets(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    const ids = Array.from(new Set([...assets.map(asset => asset.id), ...draft.imageAssetIds]));
    void Promise.all(ids.map(async id => [id, await apiClient.getAssetRawUrl(id)] as const))
      .then(entries => { if (active) setUrls(Object.fromEntries(entries)); })
      .catch(e => { if (active) setAssetError(parseApiError(e).message); });
    return () => { active = false; };
  }, [assets, draft.imageAssetIds]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const accept = (note: XhsNote) => { setSaved(note); setDraft(note); setPreview(null); setRights(false); setConflict(false); };
  const edit = (patch: Partial<XhsNoteDraft>) => { setDraft(note => editXhsNote(note, patch)); setPreview(null); setRights(false); setNotice(''); };
  const action = async (label: string, run: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(label); setError(''); setNotice('');
    try { await run(); }
    catch (e) {
      const parsed = parseApiError(e);
      const message = e instanceof Error && e.name !== 'PublishingApiError' ? e.message : parsed.message;
      setError(parsed.status === 409 ? `${message}。当前输入已保留，请核对后重新载入已保存版本。` : message);
      if (parsed.status === 409) { setConflict(true); setPreview(null); setRights(false); }
    } finally { working.current = false; setBusy(''); }
  };
  const save = async () => {
    const note = dirty ? await apiClient.saveXhsNote(saved.id, xhsNoteChanges(saved, draft)) : saved;
    accept(note); return note;
  };
  const rewrite = () => action('正在改写…', async () => {
    setConfirm(null);
    const note = await save();
    accept(await apiClient.rewriteXhsNote(note.id, note.version)); setNotice('笔记已改写，请对照原文核对事实和语气。');
  });
  const requestRewrite = () => {
    if (draft.title || draft.description || draft.hashtags.length || draft.cards.length || draft.reviewNotes.length) setConfirm('rewrite');
    else void rewrite();
  };
  const generateCards = () => action('正在生成并上传图卡…', async () => {
    const note = await save();
    accept(await bindXhsNoteCardImages(note));
    void loadAssets(); setNotice('整套图卡已生成并绑定，可按下方顺序核对图片。');
  });
  const upload = (files: File[]) => action('正在上传图片…', async () => {
    if (!files.length) return;
    if (files.length + draft.imageAssetIds.length > imageLimit) throw new Error(`图片最多 ${imageLimit} 张，请减少选图后重试`);
    const result = await apiClient.uploadImageAssets(files);
    void loadAssets();
    if (result.failures?.length || result.assets.length !== files.length) throw new Error('图片上传未全部成功，原有选图保留；成功上传的图片可在素材库重新选择。' + (result.failures?.map(f => f.message).join('；') || ''));
    edit({ imageAssetIds: [...draft.imageAssetIds, ...result.assets.map(asset => asset.id)] }); setNotice('图片已加入选图，请保存草稿。');
  });
  const moveImage = (index: number, offset: number) => {
    const ids = [...draft.imageAssetIds]; [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]]; edit({ imageAssetIds: ids });
  };
  const editCard = (index: number, patch: Partial<XhsNoteDraft['cards'][number]>) => edit({ cards: draft.cards.map((card, i) => i === index ? { ...card, ...patch } : card) });

  return <Layout>
    <PageHeader title="小红书笔记工作台" description="左侧保留原文与改写要求，右侧编辑成稿。核对事实、归因和使用权后，再准备本地草稿。"
      breadcrumb={<Link to="/xhs-notes" className="text-sm text-accent" onClick={e => { if (dirty && !window.confirm('还有未保存的笔记修改，确定离开？')) e.preventDefault(); }}>返回小红书创作</Link>}
      actions={<><span className="text-xs text-ink-muted">{dirty ? '有未保存修改' : '草稿已保存'}</span><Button disabled={!!busy || !dirty} onClick={() => void action('正在保存…', async () => { await save(); setNotice('草稿已保存'); })}>保存草稿</Button></>} />
    <div aria-live="polite">{busy && <p role="status" className="mb-4 text-sm text-ink-muted">{busy}</p>}{notice && <p role="status" className="mb-4 text-sm text-success">{notice}</p>}</div>
    {error && <div role="alert" className="mb-4 rounded-lg border border-danger-line bg-danger-soft p-4 text-sm text-danger">{error}{conflict && <Button className="ml-2" size="sm" onClick={() => setConfirm('reload')}>重新载入已保存版本</Button>}</div>}
    <div className="grid items-start gap-5 xl:grid-cols-2">
      <section aria-label="原文与改写要求" className={panelClass}>
        <h2 className="font-display text-xl text-ink">原文与改写要求</h2>
        <fieldset disabled={!!busy} className="min-w-0 space-y-4">
          <label className="block text-sm text-ink">其他平台原文<textarea aria-label="其他平台原文" className={inputClass} rows={14} value={draft.sourceText} onChange={e => edit({ sourceText: e.target.value })} /></label>
          <p className="text-xs text-ink-muted">{sourceLength}/40000 · 修改原文或要求后，需要重新改写才能建包。</p>
          {sourceLength > 40000 && <p role="alert" className="text-sm text-warning">原文超过 40000 字，完整输入已保留。请自行整理到限额内再改写，不会自动截断。</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm text-ink-muted">原作者（可选）<input aria-label="原作者" className={inputClass} maxLength={100} value={draft.sourceAuthor} onChange={e => edit({ sourceAuthor: e.target.value })} /></label>
            <label className="text-sm text-ink-muted">出处链接（可选）<input aria-label="出处链接" className={inputClass} maxLength={2000} value={draft.sourceUrl} onChange={e => edit({ sourceUrl: e.target.value })} /><span className="mt-1 block text-xs">仅记录出处，不读取页面</span></label>
          </div>
          <label className="block text-sm text-ink-muted">目标读者<input aria-label="目标读者" className={inputClass} maxLength={500} value={draft.audience} onChange={e => edit({ audience: e.target.value })} /></label>
          <label className="block text-sm text-ink-muted">本人语气样稿<textarea aria-label="本人语气样稿" className={inputClass} rows={4} value={draft.voiceSample} onChange={e => edit({ voiceSample: e.target.value })} placeholder="只参考表达，不搬用样稿中的经历与事实" /><span className="mt-1 block text-xs">{voiceLength}/5000</span></label>
          {voiceLength > 5000 && <p role="alert" className="text-sm text-warning">语气样稿超过 5000 字，完整输入已保留。请整理后再改写。</p>}
          <label className="block text-sm text-ink-muted">改写要求<textarea aria-label="改写要求" className={inputClass} rows={3} maxLength={2000} value={draft.instructions} onChange={e => edit({ instructions: e.target.value })} /></label>
        </fieldset>
        <Button variant="ai" disabled={!!busy || !draft.sourceText.trim() || sourceLength > 40000 || voiceLength > 5000} onClick={requestRewrite}>改写成小红书笔记</Button>
      </section>
      <div className="min-w-0 space-y-5">
        <section aria-label="笔记文案" className={panelClass}>
          <h2 className="font-display text-xl text-ink">笔记文案</h2>
          {!draft.contentSourceHash && <p role="status" className="text-sm text-warning">当前原文尚未成功改写，已有成稿仅供参考。修改标题或正文不能恢复来源绑定。</p>}
          <fieldset disabled={!!busy} className="min-w-0 space-y-4">
            <label className="block text-sm text-ink">笔记标题<input aria-label="笔记标题" className={inputClass} value={draft.title} onChange={e => edit({ title: e.target.value })} /><span className="mt-1 block text-xs text-ink-muted">{Array.from(draft.title).length}/{limits.titleMax}</span></label>
            <label className="block text-sm text-ink">笔记正文<textarea aria-label="笔记正文" className={inputClass} rows={10} value={draft.description} onChange={e => edit({ description: e.target.value })} /><span className="mt-1 block text-xs text-ink-muted">{Array.from(draft.description).length}/{limits.descriptionMax}</span></label>
            <label className="block text-sm text-ink">话题（每行一个）<textarea aria-label="话题" className={inputClass} rows={3} value={draft.hashtags.join('\n')} onChange={e => edit({ hashtags: e.target.value.split('\n') })} /><span className="mt-1 block text-xs text-ink-muted">最多 {limits.hashtagMax} 个，每个 {limits.hashtagLengthMax} 字；发布预览由服务端复核。</span></label>
            <label className="block text-sm text-ink-muted">审校意见（每行一条）<textarea aria-label="审校意见" className={inputClass} rows={3} value={draft.reviewNotes.join('\n')} onChange={e => edit({ reviewNotes: e.target.value.split('\n') })} /></label>
          </fieldset>
          <p className="text-xs leading-6 text-ink-muted">模型未外部核验事实，请对照原文检查数字、否定、条件和作者经历。</p>
        </section>
        <section aria-label="笔记配图" className={panelClass}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-display text-xl text-ink">笔记配图</h2><span className="text-xs text-ink-muted">已选 {draft.imageAssetIds.length}/{imageLimit} 张</span></div>
          <div role="tablist" aria-label="图片来源" className="flex flex-wrap gap-2">{(['library', 'cards'] as const).map(mode => <Button key={mode} role="tab" aria-selected={draft.imageMode === mode} aria-controls={`xhs-images-${mode}`} id={`xhs-tab-${mode}`} variant={draft.imageMode === mode ? 'accent' : 'outline'} disabled={!!busy} onClick={() => edit({ imageMode: mode })}>{mode === 'library' ? '上传 / 素材库' : '文字图卡'}</Button>)}</div>
          <div role="tabpanel" id={`xhs-images-${draft.imageMode}`} aria-labelledby={`xhs-tab-${draft.imageMode}`}>
            {draft.imageMode === 'library' ? <div className="space-y-3">
              <label className="block text-sm text-ink-muted">上传并选入图片<input aria-label="上传图片" type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={!!busy} className="mt-2 block w-full text-xs file:mr-3 file:rounded-lg file:border file:border-line-ui file:bg-panel file:px-3 file:py-2 file:text-ink" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void upload(files); }} /></label>
              {assetError && <p role="alert" className="text-xs text-danger">{assetError}<Button size="sm" onClick={() => void loadAssets()}>重试素材加载</Button></p>}
              <div className="grid max-h-80 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">{assets.map(asset => {
                const order = draft.imageAssetIds.indexOf(asset.id);
                return <button type="button" key={asset.id} aria-label={`选择图片：${asset.originalName}`} aria-pressed={order >= 0} disabled={!!busy || (order < 0 && draft.imageAssetIds.length >= imageLimit)} onClick={() => edit({ imageAssetIds: order >= 0 ? draft.imageAssetIds.filter(id => id !== asset.id) : [...draft.imageAssetIds, asset.id] })}
                  className={`relative min-w-0 rounded-lg border p-1 ${order >= 0 ? 'border-accent bg-accent-soft' : 'border-line-ui bg-well'} disabled:opacity-50`}>
                  {urls[asset.id] && <img src={urls[asset.id]} alt={asset.originalName} className="aspect-[3/4] w-full rounded object-contain" loading="lazy" />}
                  {order >= 0 && <span className="absolute left-1 top-1 rounded bg-accent px-2 py-1 text-xs text-on-accent">{order + 1}</span>}
                  <span className="block truncate text-xs text-ink-muted">{asset.originalName}</span>
                </button>;
              })}</div>
              {!assets.length && !assetError && <p className="text-xs text-ink-muted">可上传本机图片，或先在素材库添加图片。</p>}
            </div> : <div className="space-y-4">
              <p className="text-xs leading-6 text-ink-muted">本地生成 1080×1440 PNG。第 1 张作为封面，其后为内容页；文字放不下时请拆页。</p>
              {draft.cards.map((card, index) => <fieldset key={index} disabled={!!busy} className="space-y-2 rounded-lg border border-line p-3">
                <legend className="px-1 text-sm text-ink">{index === 0 ? '封面' : `内容页 ${index + 1}`}</legend>
                <label className="block text-xs text-ink-muted">图卡标题<input aria-label={`第 ${index + 1} 张图卡标题`} className={inputClass} value={card.title} onChange={e => editCard(index, { title: e.target.value })} /><span className="mt-1 block">{Array.from(card.title).length}/100</span></label>
                <label className="block text-xs text-ink-muted">图卡正文<textarea aria-label={`第 ${index + 1} 张图卡正文`} className={inputClass} rows={4} value={card.body} onChange={e => editCard(index, { body: e.target.value })} /><span className="mt-1 block">{Array.from(card.body).length}/600</span></label>
                <Button size="sm" variant="subtleDanger" onClick={() => edit({ cards: draft.cards.filter((_, i) => i !== index) })}>移除第 {index + 1} 张图卡</Button>
              </fieldset>)}
              <div className="flex flex-wrap gap-2"><Button disabled={!!busy || draft.cards.length >= 18} onClick={() => edit({ cards: [...draft.cards, { title: '', body: '' }] })}>添加图卡</Button><Button variant="heavy" disabled={!!busy || !draft.cards.length} onClick={() => void generateCards()}>保存并生成整套图卡</Button></div>
              {cardsStale && <p role="status" className="text-sm text-warning">图卡尚未生成或已修改，请重新生成整套图片。原有图片仅供参考，不能用于建包。</p>}
            </div>}
          </div>
          <h3 className="text-sm font-medium text-ink">图片顺序与预览</h3>
          <ol className="space-y-2">{draft.imageAssetIds.map((id, index) => <li key={id} className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-line p-2">
            {urls[id] && <img src={urls[id]} alt={`已选第 ${index + 1} 张图片`} className="h-24 w-18 rounded bg-well object-contain" />}
            <div className="min-w-0 flex-1"><p className="break-words text-xs text-ink">第 {index + 1} 张{index === 0 ? ' · 封面' : ''}</p><p className="mt-1 break-all text-xs text-ink-muted">{assets.find(asset => asset.id === id)?.originalName || '已选图片'}</p>
              <div className="mt-2 flex flex-wrap gap-1"><Button size="sm" disabled={!!busy || cardsStale || index === 0} aria-label={`上移第 ${index + 1} 张图片`} onClick={() => moveImage(index, -1)}>上移</Button><Button size="sm" disabled={!!busy || cardsStale || index === draft.imageAssetIds.length - 1} aria-label={`下移第 ${index + 1} 张图片`} onClick={() => moveImage(index, 1)}>下移</Button><Button size="sm" variant="subtleDanger" disabled={!!busy || cardsStale} aria-label={`移除第 ${index + 1} 张图片`} onClick={() => edit({ imageAssetIds: draft.imageAssetIds.filter(item => item !== id) })}>移除</Button></div>
            </div>
          </li>)}</ol>
        </section>
      </div>
    </div>
    <section aria-label="发布前预览" className={`${panelClass} mt-5`}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-display text-xl text-ink">发布前预览</h2><Button disabled={!!busy || !draft.contentSourceHash || cardsStale || !draft.imageAssetIds.length} onClick={() => void action('正在保存并复核预览…', async () => { const note = await save(); setPreview(await apiClient.previewXhsNote(note.id, note.version)); })}>保存并预览笔记</Button></div>
      {preview ? <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <div className="min-w-0 rounded-lg bg-well p-4"><h3 className="break-words font-display text-xl text-ink">{preview.note.title}</h3><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-ink">{preview.note.description}</p><p className="mt-3 break-words text-sm text-accent">{preview.note.hashtags.map(tag => `#${tag}`).join(' ')}</p></div>
        <ol className="grid grid-cols-3 content-start gap-2 sm:grid-cols-4">{preview.imageAssetIds.map((id, index) => <li key={id} className="min-w-0">{urls[id] && <img src={urls[id]} alt={`发布预览第 ${index + 1} 张`} className="aspect-[3/4] w-full rounded bg-well object-contain" />}<span className="mt-1 block text-xs text-ink-muted">第 {index + 1} 张</span></li>)}</ol>
      </div> : <p className="text-sm text-ink-muted">完成当前原文改写并准备图片后，保存并取得最新预览。每次修改都会使预览失效。</p>}
      <label className="flex items-start gap-2 text-sm leading-6 text-ink-muted"><input type="checkbox" className="mt-1" checked={rights} disabled={!!busy || !preview || dirty} onChange={e => setRights(e.target.checked)} />我已核对笔记与图片，确认拥有原文和素材的使用权。</label>
      <p className="text-xs leading-6 text-ink-muted">AI 声明固定开启。这里只创建发布包；发布中心由你触发保存浏览器本地草稿，最终发布由本人完成。风险由你的账号承担。</p>
      <Button variant="primary" disabled={!!busy || !packageReady} onClick={() => void action('正在创建发布包…', async () => {
        if (!preview || !packageReady) return;
        await apiClient.createXhsNotePackage(saved.id, preview.note.version, preview.previewRevision, true);
        navigate('/publishing?channel=xiaohongshu&contentType=note&status=all');
      })}>创建小红书发布包</Button>
    </section>
    <ConfirmDialog open={!!confirm} title={confirm === 'reload' ? '重新载入已保存版本？' : '替换现有笔记与图卡？'}
      description={confirm === 'reload' ? '当前编辑会被已保存版本替换，请先自行保留需要的文字。' : '将先保存当前输入，再根据原文重新改写。成功后替换现有文案和图卡；失败保留当前输入与旧成果。'}
      confirmLabel={confirm === 'reload' ? '重新载入' : '确认重新改写'} busy={!!busy} onClose={() => setConfirm(null)} onConfirm={() => {
        if (confirm === 'reload') void action('正在重新载入…', async () => { accept(await apiClient.getXhsNote(saved.id)); setConfirm(null); });
        else void rewrite();
      }} />
  </Layout>;
}
