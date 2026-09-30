import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, Loader2, Music4, Play, RefreshCw, Search } from 'lucide-react';
import type { AudioBoard, AudioImportBatch, AudioPreview } from '../../../src/lib/online-audio';
import type { AudioSource, AudioBoardId, OnlineTrack } from '../../../src/lib/online-audio-sources';
import type { AssetRecord } from '../types';
import { apiClient, parseApiError, ONLINE_AUDIO_BATCH_KEY } from '../services/api';
import { Button } from './ui/Button';

const busy = (batch: AudioImportBatch | null) => batch?.items.some(item => item.status === 'queued' || item.status === 'downloading') ?? false;
const duration = (ms?: number) => ms ? `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}` : '—';
const statusText = { queued: '等待下载', downloading: '下载中', succeeded: '已入库', failed: '下载失败' };
function savedBatch(): AudioImportBatch | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(ONLINE_AUDIO_BATCH_KEY) ?? 'null');
    return value && typeof value.id === 'string' && Array.isArray(value.items) && value.items.length <= 20
      && value.items.every((item: any) => item.track && typeof item.track.key === 'string' && typeof item.track.title === 'string'
        && ['queued', 'downloading', 'succeeded', 'failed'].includes(item.status)) ? value : null;
  } catch { return null; }
}

export function OnlineAudioPanel({ assets, onImported }: { assets: AssetRecord[]; onImported: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<{ sources: { id: AudioSource; name: string }[]; boards: { id: AudioBoardId; name: string }[] }>();
  const [source, setSource] = useState<AudioSource>('netease');
  const [mode, setMode] = useState<'board' | 'search'>('board');
  const [boardId, setBoardId] = useState<AudioBoardId>('hot');
  const [board, setBoard] = useState<AudioBoard>();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<OnlineTrack[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [preview, setPreview] = useState<(AudioPreview & { url: string; track: OnlineTrack })>();
  const [previewKey, setPreviewKey] = useState<string>();
  const [batch, setBatch] = useState<AudioImportBatch | null>(savedBatch);
  const [submitting, setSubmitting] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const requestId = useRef(0); const previewId = useRef(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const onImportedRef = useRef(onImported); onImportedRef.current = onImported;
  const notified = useRef(new Set<string>());
  const imported = new Set(assets.filter(asset => asset.audioSource).map(asset => `${asset.audioSource!.platform}:${asset.audioSource!.trackId}`));

  useEffect(() => {
    let active = true;
    void apiClient.getOnlineAudioCatalog().then(value => { if (active) setCatalog(value); }).catch(e => { if (active) setError(parseApiError(e).message); });
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => { active = false; clearInterval(timer); requestId.current++; previewId.current++; };
  }, []);

  const loadBoard = useCallback(async (refresh = false) => {
    const id = ++requestId.current; setLoading(true); setError(''); setSelected([]);
    try {
      const value = await apiClient.getOnlineAudioBoard(source, boardId, refresh);
      if (requestId.current === id) { setBoard(value); setItems(value.items); }
    } catch (e) { if (requestId.current === id) setError(parseApiError(e).message); }
    finally { if (requestId.current === id) setLoading(false); }
  }, [source, boardId]);
  useEffect(() => {
    requestId.current++; setItems([]); setBoard(undefined); setSelected([]); setError(''); setLoading(false);
    if (mode === 'board') void loadBoard();
  }, [mode, loadBoard]);

  const search = async () => {
    const id = ++requestId.current; setLoading(true); setError(''); setItems([]); setSelected([]);
    try {
      const value = await apiClient.searchOnlineAudio(source, query.trim());
      if (requestId.current === id) setItems(value);
    } catch (e) { if (requestId.current === id) setError(parseApiError(e).message); }
    finally { if (requestId.current === id) setLoading(false); }
  };
  useEffect(() => {
    if (!batch) return;
    try { sessionStorage.setItem(ONLINE_AUDIO_BATCH_KEY, JSON.stringify(batch)); } catch { /* Downloads still work without session storage. */ }
    const newlyImported = batch.items.filter(item => item.status === 'succeeded' && !notified.current.has(item.id));
    if (newlyImported.length) {
      newlyImported.forEach(item => notified.current.add(item.id));
      void onImportedRef.current().catch(() => setDownloadError('下载已完成，素材列表刷新失败，请重新加载素材页'));
    }
  }, [batch]);
  const batchId = batch?.id;
  const batchBusy = busy(batch);
  useEffect(() => {
    if (!batchId) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await apiClient.getOnlineAudioImport(batchId);
        if (!active) return;
        setBatch(value); setDownloadError('');
        if (busy(value)) timer = setTimeout(() => void poll(), 1000);
      } catch (e) {
        if (!active) return;
        const failure = parseApiError(e);
        if (failure.status === 404) {
          setBatch(previous => previous?.id === batchId ? { ...previous, items: previous.items.map(item => item.status === 'queued' || item.status === 'downloading'
            ? { ...item, status: 'failed', message: '下载已中断，请重新搜索或加载榜单后重试' } : item) } : previous);
          setDownloadError('后端已重启或批次已过期，已成功的素材仍保留在素材库');
        } else { setDownloadError('下载进度暂时无法获取，正在重试'); timer = setTimeout(() => void poll(), 3000); }
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [batchId, batchBusy]);

  const play = async (track: OnlineTrack) => {
    const id = ++previewId.current; audioRef.current?.pause(); setPreview(undefined); setPreviewKey(track.key); setPreviewError('');
    try {
      const value = await apiClient.previewOnlineAudio(track.key);
      if (previewId.current === id) setPreview({ ...value, track });
    } catch (e) { if (previewId.current === id) setPreviewError(parseApiError(e).message); }
    finally { if (previewId.current === id) setPreviewKey(undefined); }
  };
  const download = async (keys = selected) => {
    setSubmitting(true); setDownloadError('');
    try { const value = await apiClient.importOnlineAudio(keys); setBatch(value); setSelected([]); }
    catch (e) { setDownloadError(parseApiError(e).message); }
    finally { setSubmitting(false); }
  };
  const refreshDisabled = loading || !!board?.refreshAfter && clock < Date.parse(board.refreshAfter);
  const stale = board?.status === 'stale' || !!board?.expiresAt && clock >= Date.parse(board.expiresAt);

  return <div className="mb-6 rounded-xl border border-line bg-panel p-4 sm:p-5">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="flex items-center gap-2 font-semibold text-ink"><Music4 size={18} className="text-accent" />在线音频</h3>
        <p className="mt-1 text-xs text-ink-muted">发现歌曲，先试听，再下载到素材库。</p>
      </div>
      <div className="flex gap-1 rounded-lg bg-elevated p-1" aria-label="音频发现方式">
        {(['board', 'search'] as const).map(value => <Button key={value} size="sm" variant={mode === value ? 'outline' : 'ghost'} aria-pressed={mode === value} onClick={() => setMode(value)}>{value === 'board' ? '热门榜单' : '搜索'}</Button>)}
      </div>
    </div>
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <label className="text-xs text-ink-muted">音乐来源
        <select aria-label="音乐来源" value={source} onChange={e => setSource(e.target.value as AudioSource)} className="mt-1 block rounded-lg border border-line-ui bg-panel px-3 py-2 text-sm text-ink">
          {(catalog?.sources ?? [{ id: 'netease', name: '网易云音乐' }, { id: 'qq', name: 'QQ音乐' }]).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      {mode === 'board' ? <>
        <label className="text-xs text-ink-muted">榜单
          <select aria-label="榜单" value={boardId} onChange={e => setBoardId(e.target.value as AudioBoardId)} className="mt-1 block rounded-lg border border-line-ui bg-panel px-3 py-2 text-sm text-ink">
            {(catalog?.boards ?? [{ id: 'hot', name: '热歌榜' }, { id: 'soar', name: '飙升榜' }, { id: 'new', name: '新歌榜' }]).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <Button disabled={refreshDisabled} onClick={() => void loadBoard(true)} title={refreshDisabled && !loading ? '每分钟可刷新一次' : '刷新当前榜单'}><RefreshCw size={14} />刷新</Button>
      </> : <form onSubmit={e => { e.preventDefault(); void search(); }} className="flex min-w-0 flex-1 gap-2">
        <input aria-label="歌曲或歌手" maxLength={100} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索歌曲或歌手" className="min-w-0 flex-1 rounded-lg border border-line-ui bg-panel px-3 py-2 text-sm text-ink" />
        <Button type="submit" disabled={loading || !query.trim()}><Search size={14} />搜索</Button>
      </form>}
    </div>
    {board?.fetchedAt && mode === 'board' && <p className={`mb-3 text-xs ${stale ? 'text-warning' : 'text-ink-muted'}`}>{stale ? '旧榜单 · ' : ''}获取于 {new Date(board.fetchedAt).toLocaleString('zh-CN')} · 排名来自所选平台</p>}
    {(error || board?.error && mode === 'board') && <p role="alert" className="mb-3 text-sm text-warning">{error || board?.error}</p>}
    {loading ? <p role="status" className="flex items-center gap-2 py-8 text-sm text-ink-muted"><Loader2 size={16} className="animate-spin" />正在获取歌曲…</p>
      : items.length ? <>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <p className="text-xs text-ink-muted">{items.length} 首 · 已选 {selected.length} 首（最多 20 首）</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setSelected(selected.length ? [] : items.filter(item => !imported.has(item.key)).slice(0, 20).map(item => item.key))}>{selected.length ? '清空选择' : '选择前 20 首'}</Button>
            <Button size="sm" variant="primary" disabled={!selected.length || submitting || batchBusy} onClick={() => void download()}><Download size={14} />下载到素材库</Button>
          </div>
        </div>
        <ul className="max-h-[440px] divide-y divide-line overflow-y-auto" aria-label="在线歌曲列表">
          {items.map(item => <li key={item.key} className="flex items-center gap-3 py-3">
            <input type="checkbox" aria-label={`选择 ${item.title}`} checked={selected.includes(item.key)} disabled={imported.has(item.key) || selected.length >= 20 && !selected.includes(item.key)}
              onChange={e => setSelected(previous => e.target.checked ? [...previous, item.key] : previous.filter(key => key !== item.key))} className="h-4 w-4 shrink-0 accent-accent" />
            {item.rank && <span className="w-6 shrink-0 text-center font-mono text-xs text-ink-muted">{item.rank}</span>}
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-ink" title={item.title}>{item.title}</p><p className="truncate text-xs text-ink-muted">{item.artist || '歌手未提供'} · {duration(item.durationMs)}{imported.has(item.key) ? ' · 已入库' : ''}</p></div>
            <Button size="sm" disabled={previewKey === item.key} onClick={() => void play(item)} aria-label={`试听 ${item.title}`}>{previewKey === item.key ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}<span className="hidden sm:inline">试听</span></Button>
            <a href={item.url} target="_blank" rel="noreferrer" aria-label={`在原平台查看 ${item.title}`} className="rounded p-1.5 text-ink-muted hover:text-ink"><ExternalLink size={15} /></a>
          </li>)}
        </ul>
      </> : <p className="py-7 text-center text-sm text-ink-muted">{mode === 'search' ? '输入歌曲或歌手名称，搜索后选择音频。' : '榜单暂不可用，请稍后重试或切换来源。'}</p>}
    {previewError && <p role="alert" className="mt-3 text-sm text-warning">{previewError}</p>}
    {preview && <div className="mt-4 rounded-lg border border-line bg-elevated p-3">
      <p className="text-sm font-medium text-ink">{preview.track.title} <span className={preview.previewOnly ? 'text-warning' : 'text-success'}>· {preview.previewOnly ? '试听片段' : '完整音频'}</span></p>
      <audio key={preview.token} ref={audioRef} src={preview.url} controls autoPlay preload="none" className="mt-2 w-full" onError={() => setPreviewError('试听失败或已过期，请重新点击试听')} aria-label={`正在试听 ${preview.track.title}`} />
    </div>}
    {batch && <div className="mt-4 border-t border-line pt-3" aria-live="polite">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-ink">下载进度 · {batch.items.filter(item => item.status === 'succeeded').length}/{batch.items.length} 已入库</p>
        {!batchBusy && batch.items.some(item => item.status === 'failed') && <Button size="sm" disabled={submitting} onClick={() => void download(batch.items.filter(item => item.status === 'failed').map(item => item.track.key))}>重试失败项</Button>}
      </div>
      <ul className="space-y-1 text-xs">{batch.items.map(item => <li key={item.id} className="flex flex-wrap justify-between gap-2"><span className="text-ink-muted">{item.track.title}</span><span className={item.status === 'failed' ? 'text-warning' : item.status === 'succeeded' ? 'text-success' : 'text-ink-muted'}>{item.message || statusText[item.status]}</span></li>)}</ul>
    </div>}
    {downloadError && <p role="alert" className="mt-3 text-sm text-warning">{downloadError}</p>}
    <p className="mt-4 text-xs text-ink-muted">部分歌曲受会员或登录限制；获取音频不代表取得创作授权。</p>
  </div>;
}
