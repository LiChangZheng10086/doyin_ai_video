import React, { useEffect, useRef, useState } from 'react';
import type { ImagePromptInput, ImagePromptRecord } from '../../../src/lib/image-prompts';
import { apiClient } from '../services/api';
import { Button } from './ui/Button';
import { imageInputClass, splitImageTags } from './ImageAssetEditor';

type PendingImage = { file: File; description: string; tags: string; error?: string };
export function ImagePromptPanel({ referenceText = '', defaultAspectRatio = '16:9', onAssetsChanged, onDirtyChange }: {
  referenceText?: string; defaultAspectRatio?: ImagePromptInput['aspectRatio'];
  onAssetsChanged: () => Promise<void>; onDirtyChange?: (dirty: boolean, busy: boolean) => void;
}) {
  const [mode, setMode] = useState<'generate' | 'optimize'>('generate');
  const [reference, setReference] = useState(referenceText); const [original, setOriginal] = useState('');
  const [changes, setChanges] = useState('');
  const [settings, setSettings] = useState({ generate: { purpose: 'cover', ratio: defaultAspectRatio ?? '16:9', style: '' }, optimize: { purpose: '', ratio: '', style: '' } });
  const { purpose, ratio, style } = settings[mode];
  const setPurpose = (purpose: string) => setSettings(previous => ({ ...previous, [mode]: { ...previous[mode], purpose } }));
  const setRatio = (ratio: string) => setSettings(previous => ({ ...previous, [mode]: { ...previous[mode], ratio } }));
  const setStyle = (style: string) => setSettings(previous => ({ ...previous, [mode]: { ...previous[mode], style } }));
  const [language, setLanguage] = useState<'zh' | 'en'>('zh'); const [count, setCount] = useState(1);
  const [formEdits, setFormEdits] = useState({ generate: false, optimize: false });
  const formDirty = formEdits.generate || formEdits.optimize;
  const setFormDirty = (dirty: boolean) => setFormEdits(previous => ({ ...previous, [mode]: dirty }));
  const [records, setRecords] = useState<ImagePromptRecord[]>([]); const [base, setBase] = useState<ImagePromptRecord | null>(null);
  const [title, setTitle] = useState(''); const [tags, setTags] = useState(''); const [prompt, setPrompt] = useState('');
  const [latest, setLatest] = useState<ImagePromptRecord | null>(null);
  const [files, setFiles] = useState<PendingImage[]>([]); const [urls, setUrls] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const requestId = useRef(0); const uploadInput = useRef<HTMLInputElement>(null);
  const draftDirty = !!base && (title !== base.title || tags !== base.tags.join('，') || prompt !== base.prompt);
  const dirty = draftDirty || formDirty || files.length > 0;
  useEffect(() => { onDirtyChange?.(dirty, busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false, false); }, [onDirtyChange]);
  useEffect(() => { const previews = files.map(item => URL.createObjectURL(item.file)); setUrls(previews); return () => previews.forEach(url => URL.revokeObjectURL(url)); }, [files]);
  const load = async () => {
    const id = ++requestId.current; setLoading(true);
    try { const saved = await apiClient.getImagePrompts(); if (id === requestId.current) { setRecords(saved); if (base) setLatest(saved.find(item => item.id === base.id) ?? null); } }
    catch (e) { if (id === requestId.current) setError((e as Error).message); }
    finally { if (id === requestId.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { requestId.current++; }; }, []);
  const select = (record: ImagePromptRecord) => {
    setBase(record); setTitle(record.title); setTags(record.tags.join('，')); setPrompt(record.prompt); setLatest(null);
  };
  const canLeaveDraft = () => (!draftDirty && files.length === 0) || window.confirm('提示词编辑或待上传图片尚未保存，放弃这些修改？');
  const choose = (record: ImagePromptRecord) => { if (canLeaveDraft()) { setFiles([]); select(record); setError(''); setNotice(''); } };
  const generate = async () => {
    if (!canLeaveDraft()) return;
    requestId.current++; setLoading(false); setBusy(true); setError(''); setNotice('');
    try {
      const input: ImagePromptInput = { mode, language, count: mode === 'optimize' ? 1 : count,
        ...(mode === 'generate' ? { referenceText: reference } : { originalPrompt: original, changes }),
        ...(purpose ? { purpose: purpose as ImagePromptInput['purpose'] } : {}),
        ...(ratio ? { aspectRatio: ratio as ImagePromptInput['aspectRatio'] } : {}), ...(style.trim() ? { style } : {}) };
      const created = await apiClient.createImagePrompts(input); setRecords(previous => [...created, ...previous]);
      select(created[0]); setFiles([]); setFormDirty(false); setNotice(`已生成并保存 ${created.length} 条提示词，可复制到生图工具。`);
    } catch (e) { const uncertain = (e as { status?: number }).status === undefined; setError(uncertain ? '生成结果暂不确定，请先刷新草稿核对是否已经保存，再决定是否重新生成；重复生成会再次调用 AI。输入已保留。' : (e as Error).message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!base) return; requestId.current++; setLoading(false); setBusy(true); setError(''); setNotice('');
    try { const saved = await apiClient.updateImagePrompt(base.id, { version: base.version, title, tags: splitImageTags(tags), prompt }); select(saved); setRecords(previous => previous.map(item => item.id === saved.id ? saved : item)); setNotice('提示词已保存'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!base || !window.confirm('删除此提示词草稿？已入库图片的提示词不受影响。') || !canLeaveDraft()) return;
    requestId.current++; setLoading(false); setBusy(true); setError('');
    try { await apiClient.deleteImagePrompt(base.id, base.version); setRecords(previous => previous.filter(item => item.id !== base.id)); setBase(null); setFiles([]); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const upload = async () => {
    if (!base || draftDirty || files.length === 0) return;
    requestId.current++; setLoading(false); setBusy(true); setError(''); setNotice('');
    try {
      const result = await apiClient.uploadImageAssets(files.map(item => item.file), files.map(item => ({ description: item.description, tags: splitImageTags(item.tags) })), { id: base.id, version: base.version });
      const failed = new Map(result.failures?.map(item => [item.index, item.message]));
      setFiles(previous => previous.flatMap((item, index) => failed.has(index) ? [{ ...item, error: failed.get(index) }] : []));
      setNotice(`已入库 ${result.assets.length} 张${failed.size ? `；${failed.size} 张未成功，仅保留失败文件供重试` : '，各自保存描述与提示词快照'}。`);
      try { await onAssetsChanged(); } catch { setError('图片上传结果已收到，素材列表刷新失败，请手动刷新核对。'); }
    } catch (e) { setError(`${(e as Error).message}。本次文件与描述已保留；若请求中断，请先刷新素材库核对入库结果，勿直接重传整批。`); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4 rounded-xl border border-line bg-panel p-4 text-ink">
    <div><h3 className="font-semibold">图片提示词</h3><p className="mt-1 text-xs leading-5 text-ink-muted">生成提示词后，在你使用的生图工具中生成图片；再上传生成成功的图片，填写实际画面描述并入库。</p></div>
    <fieldset disabled={busy} className="space-y-3" onChange={() => setFormDirty(true)}>
      <div className="flex flex-wrap gap-2">{(['generate', 'optimize'] as const).map(value => <Button key={value} aria-pressed={mode === value} variant={mode === value ? 'accent' : 'outline'} onClick={() => { setMode(value); }}>{value === 'generate' ? '生成提示词' : '优化已有提示词'}</Button>)}</div>
      {mode === 'generate' ? <label className="block text-sm">主题或文章<textarea className={imageInputClass} rows={4} maxLength={12000} value={reference} onChange={e => setReference(e.target.value)} /></label> : <><label className="block text-sm">原图片提示词<textarea className={imageInputClass} rows={4} maxLength={8000} value={original} onChange={e => setOriginal(e.target.value)} /></label><label className="block text-sm">修改要求<textarea className={imageInputClass} rows={2} maxLength={2000} value={changes} onChange={e => setChanges(e.target.value)} /></label></>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">用途<select className={imageInputClass} value={purpose} onChange={e => setPurpose(e.target.value)}>{mode === 'optimize' && <option value="">保留原提示词</option>}<option value="cover">封面</option><option value="body">正文配图</option></select></label>
        <label className="text-sm">比例<select className={imageInputClass} value={ratio} onChange={e => setRatio(e.target.value)}>{mode === 'optimize' && <option value="">保留原提示词</option>}{['16:9', '2.35:1', '3:4', '9:16'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="text-sm">输出语言<select className={imageInputClass} value={language} onChange={e => setLanguage(e.target.value as 'zh' | 'en')}><option value="zh">中文</option><option value="en">英文（保留指定的图中文字）</option></select></label>
      </div>
      <label className="block text-sm">视觉风格（可选，优化时留空沿用原文）<input className={imageInputClass} maxLength={200} value={style} onChange={e => setStyle(e.target.value)} /></label>
      {mode === 'generate' && <label className="block text-sm">生成数量<select className={imageInputClass} value={count} onChange={e => setCount(Number(e.target.value))}>{[1,2,3,4,5,6].map(value => <option key={value}>{value}</option>)}</select></label>}
      <Button variant="ai" onClick={() => void generate()} disabled={busy || !(mode === 'generate' ? reference.trim() : original.trim())}>{busy ? '处理中…' : mode === 'generate' ? '生成并保存提示词' : '优化并另存提示词'}</Button>
    </fieldset>
    <p role="alert" className="break-words text-sm text-danger">{error}</p><p role="status" className="text-sm text-success">{notice}</p>
    <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-semibold">已保存的提示词</h4><Button size="sm" disabled={busy || loading} onClick={() => void load()}>刷新草稿</Button></div>
    {loading && <p className="text-sm text-ink-muted">正在读取草稿…</p>}
    <div className="flex max-h-48 flex-wrap gap-2 overflow-auto">{records.map(record => <Button key={record.id} size="sm" aria-pressed={base?.id === record.id} disabled={busy} onClick={() => choose(record)}>{record.title} · v{record.version}</Button>)}</div>
    {!loading && records.length === 0 && <p className="text-sm text-ink-muted">还没有草稿，生成结果会自动保存在这里。</p>}
    {base && <div className="space-y-3 border-t border-line pt-4">
      <fieldset disabled={busy} className="space-y-3">
        <label className="block text-sm">提示词标题<input className={imageInputClass} maxLength={100} value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label className="block text-sm">提示词标签（逗号分隔）<input className={imageInputClass} value={tags} onChange={e => setTags(e.target.value)} /></label>
        <label className="block text-sm">最终提示词<textarea className={imageInputClass} rows={6} maxLength={8000} value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
      </fieldset>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || !draftDirty} variant="primary" onClick={() => void save()}>保存提示词修改</Button><Button disabled={busy} onClick={async () => { try { await navigator.clipboard.writeText(prompt); setNotice('已复制提示词'); } catch { setError('复制失败，请选中提示词手动复制。'); } }}>复制提示词</Button><Button disabled={busy} onClick={() => { if (!formDirty || window.confirm('生成表单尚未使用，替换为这条提示词进行优化？')) { setMode('optimize'); setOriginal(prompt); setChanges(''); setSettings(previous => ({ ...previous, optimize: { purpose: '', ratio: '', style: '' } })); setFormEdits(previous => ({ ...previous, optimize: true })); } }}>以此为基础优化</Button><Button variant="subtleDanger" disabled={busy} onClick={() => void remove()}>删除草稿</Button></div>
      {latest && latest.version !== base.version && <div className="space-y-2 text-sm"><p>最新版本 v{latest.version} · {latest.title} · {latest.tags.join('，')}</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap">{latest.prompt}</pre><Button disabled={busy} onClick={() => { setBase(latest); setLatest(null); setError('已采用最新版本号，本次输入保留；请核对后再保存。'); }}>核对后采用此版本号</Button></div>}
      <p className="text-xs text-ink-muted">生成成功的图片：上传前先保存提示词修改。每张图片单独填写实际画面描述与标签。</p>
      <Button disabled={busy || draftDirty} onClick={() => uploadInput.current?.click()}>选择图片绑定此提示词</Button>
      <input ref={uploadInput} aria-label="选择生成成功的图片" type="file" accept=".jpg,.jpeg,.png,.webp" multiple className="hidden" onChange={e => { const picked = Array.from(e.target.files ?? []); e.target.value = ''; if (picked.length > 20) { setError('单次最多选择 20 张图片'); return; } if (files.length && !window.confirm('替换当前待上传图片及其描述？')) return; setFiles(picked.map(file => ({ file, description: '', tags: base.tags.join('，') }))); }} />
      <div className="space-y-3">{files.map((item, index) => <div key={index} className="rounded-lg border border-line p-3"><div className="flex items-start gap-3">{urls[index] && <img src={urls[index]} alt={item.file.name} className="h-20 w-20 rounded object-contain" />}<p className="min-w-0 break-words text-sm">{item.file.name}</p></div><fieldset disabled={busy}><label className="mt-2 block text-sm">第 {index + 1} 张图片描述<textarea className={imageInputClass} rows={2} maxLength={1000} value={item.description} onChange={e => setFiles(previous => previous.map((old, i) => i === index ? { ...old, description: e.target.value } : old))} /></label><label className="mt-2 block text-sm">第 {index + 1} 张图片标签<input className={imageInputClass} value={item.tags} onChange={e => setFiles(previous => previous.map((old, i) => i === index ? { ...old, tags: e.target.value } : old))} /></label><Button size="sm" onClick={() => setFiles(previous => previous.filter((_, i) => i !== index))}>移除此文件</Button></fieldset>{item.error && <p className="mt-2 text-sm text-danger">{item.error}</p>}</div>)}</div>
      {files.length > 0 && <Button disabled={busy || draftDirty} variant="primary" onClick={() => void upload()}>{busy ? '上传中…' : `上传 ${files.length} 张图片并入库`}</Button>}
    </div>}
  </section>;
}
