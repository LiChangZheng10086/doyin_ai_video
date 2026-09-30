import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/api';
import type { AssetRecord } from '../types';
import { Button } from './ui/Button';

export const imageInputClass = 'mt-1 w-full rounded-lg border border-line-ui bg-canvas p-2 text-sm text-ink';
export const splitImageTags = (value: string) => value.split(/[,，\n]/u).map(tag => tag.trim()).filter(Boolean);

export function ImageAssetEditor({ asset, onSaved, onCancel, onDirtyChange }: {
  asset: AssetRecord; onSaved: (asset: AssetRecord) => void; onCancel: () => void;
  onDirtyChange?: (dirty: boolean, busy: boolean) => void;
}) {
  const [base, setBase] = useState(asset);
  const [description, setDescription] = useState(asset.description ?? '');
  const [tags, setTags] = useState((asset.tags ?? []).join('，'));
  const [prompt, setPrompt] = useState(asset.generationPrompt ?? '');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [latest, setLatest] = useState<AssetRecord | null>(null);
  const dirty = description !== (base.description ?? '') || tags !== (base.tags ?? []).join('，') || prompt !== (base.generationPrompt ?? '');
  useEffect(() => { onDirtyChange?.(dirty, busy); }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false, false); }, [onDirtyChange]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const fields = { description, tags: splitImageTags(tags), ...(prompt !== (base.generationPrompt ?? '') ? { generationPrompt: prompt } : {}), version: base.metadataVersion ?? 1 };
      const saved = await apiClient.updateImageMetadata(base.id, fields); setBase(saved); setLatest(null); onSaved(saved);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const checkLatest = async () => {
    setBusy(true);
    try { const record = (await apiClient.searchImageAssets()).assets.find(item => item.id === base.id); if (!record) throw new Error('图片已删除，本次输入仍保留'); setLatest(record); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="space-y-3 rounded-lg border border-line bg-panel p-4">
    <h3 className="font-semibold text-ink">编辑图片信息 · {asset.originalName}</h3>
    <p className="text-xs text-ink-muted">描述实际画面，便于以后配图；标签用逗号分隔。修改最终提示词会解除原草稿关联。</p>
    <fieldset disabled={busy} className="space-y-3">
      <label className="block text-sm">图片描述<textarea className={imageInputClass} rows={3} maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label className="block text-sm">图片标签<input className={imageInputClass} value={tags} onChange={e => setTags(e.target.value)} /></label>
      <label className="block text-sm">最终图片提示词<textarea className={imageInputClass} rows={5} maxLength={8000} value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
    </fieldset>
    <p role="alert" className="text-sm text-danger">{error}</p>
    {latest && <div className="space-y-2 text-sm"><p>最新版本 {latest.metadataVersion ?? 1}：{latest.description || '（无描述）'}；标签：{latest.tags?.join('，') || '（无）'}</p><pre className="max-h-40 overflow-auto whitespace-pre-wrap">{latest.generationPrompt || '（无提示词）'}</pre><Button disabled={busy} onClick={() => { setBase(latest); setLatest(null); setError('已采用最新版本号，输入保留；请核对后再保存。'); }}>核对后采用此版本号</Button></div>}
    <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '保存中…' : '保存图片信息'}</Button><Button disabled={busy} onClick={() => void checkLatest()}>刷新核对</Button><Button disabled={busy} onClick={() => { if (!dirty || window.confirm('图片信息尚未保存，放弃编辑？')) onCancel(); }}>取消编辑</Button></div>
  </div>;
}
