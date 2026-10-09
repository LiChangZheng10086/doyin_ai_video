import React, { useEffect, useRef, useState } from 'react';
import { useBlocker, useSearchParams, useNavigate } from 'react-router-dom';
import { Bookmark, Check, ExternalLink, Flame, RefreshCw, Search, StickyNote } from 'lucide-react';
import { HotspotDetailDialog, type HotspotDetailItem } from '../components/HotspotDetailDialog';
import type { HotspotBoard, HotspotFavorite, HotspotItem } from '../../../src/lib/hotspots';
import { Layout } from '../components/Layout';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { apiClient, parseApiError } from '../services/api';

const sameItem = (a: HotspotItem, b: HotspotItem) => a.sourceId === b.sourceId && a.itemId === b.itemId;
const timestamp = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function SourceLink({ url, children, className = '' }: { url: string; children: React.ReactNode; className?: string }) {
  return <a href={url} target="_blank" rel="noopener noreferrer" className={className} onClick={event => {
    if (window.electron?.openExternal) { event.preventDefault(); void window.electron.openExternal(url); }
  }}>{children}</a>;
}

export function HotspotBoardCard({ board, favorites, busy, onToggle, onSelectSource, compact = false, now = Date.now(), onCreate, onDetail }: {
  board: HotspotBoard; favorites: HotspotFavorite[]; busy: boolean;
  onToggle: (item: HotspotItem) => void; onSelectSource: () => void; compact?: boolean; now?: number; onCreate?: (item: HotspotItem) => void; onDetail?:(item:HotspotDetailItem)=>void;
}) {
  const state = board.status === 'fresh' && board.expiresAt && now >= Date.parse(board.expiresAt) ? 'stale' : board.status;
  const status = state === 'unavailable' ? '暂不可用' : state === 'stale' ? '旧榜单' : board.delivery === 'network' ? '本次获取' : '缓存有效';
  const items = compact ? board.items.slice(0, 12) : board.items;
  return <section className="mb-5 break-inside-avoid min-w-0 overflow-hidden rounded-xl border border-line bg-panel">
    <header className="border-b border-line p-4">
      <div className="flex items-center justify-between gap-3"><h2 className="font-display font-semibold text-ink">{board.source.name}<span className="ml-2 text-xs font-normal text-ink-muted">{board.source.label}</span></h2>
        <span className={`shrink-0 text-xs ${state === 'fresh' ? 'text-success' : 'text-warning'}`}>{status}</span></div>
      <p className="mt-2 text-xs text-ink-muted">{board.fetchedAt ? <>榜单获取于 <time dateTime={board.fetchedAt}>{timestamp(board.fetchedAt)}</time></> : '尚未获取有效榜单'}</p>
      {board.error && <p className="mt-2 break-words text-xs leading-5 text-warning">{board.error}。{board.items.length > 0 && '当前展示上次有效数据。'}</p>}
    </header>
    {items.length ? <ol className="divide-y divide-line">{items.map(item => {
      const saved = favorites.some(favorite => sameItem(item, favorite));
      return <li key={item.itemId} className="flex items-start gap-3 px-4 py-3 hover:bg-elevated/50">
        <span className={`w-6 shrink-0 pt-0.5 text-right font-mono text-sm tabular-nums ${item.rank <= 3 ? 'text-accent' : 'text-ink-subtle'}`}>{item.rank}</span>
        <div className="min-w-0 flex-1">{onDetail?<button type="button" aria-label={`查看详情：${item.title}`} onClick={()=>onDetail({...item,sourceName:board.source.name,fetchedAt:board.fetchedAt})} className="break-words text-left text-sm leading-6 text-ink hover:text-accent">{item.title}</button>:<SourceLink url={item.url} className="break-words text-sm leading-6 text-ink hover:text-accent">{item.title}</SourceLink>}
          {onCreate && <button type="button" onClick={() => onCreate(item)} className="mt-1 block text-xs text-accent hover:underline">以此创作公众号文章</button>}
          {item.heat && <p className="mt-1 text-xs text-ink-muted">原始热度 · {item.heat}</p>}
        </div>
        <Button size="icon" variant="ghost" disabled={busy} aria-label={`${saved ? '取消收藏' : '收藏'}：${item.title}`} aria-pressed={saved} onClick={() => onToggle(item)} className={saved ? 'text-accent' : ''}><Bookmark size={16} fill={saved ? 'currentColor' : 'none'} /></Button>
      </li>;
    })}</ol> : <div className="p-6 text-sm leading-6 text-ink-muted">{board.status === 'unavailable' ? '请稍后刷新，或打开来源网站核实。其它平台榜单仍可使用。' : '没有匹配的标题，请调整搜索词。'}</div>}
    <footer className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-xs">
      <SourceLink url={board.source.home} className="inline-flex items-center gap-1 text-ink-muted hover:text-ink">打开来源<ExternalLink size={12} /></SourceLink>
      {compact && board.items.length > 12 && <Button size="sm" variant="ghost" onClick={onSelectSource}>查看全部 {board.items.length} 条</Button>}
    </footer>
  </section>;
}

export function HotspotsPage() {
  const [detail,setDetail]=useState<HotspotDetailItem|null>(null);
  const navigate = useNavigate();
  const create = (item: HotspotItem) => navigate(`/articles?${new URLSearchParams({sourceId:item.sourceId,itemId:item.itemId,keyword:item.title})}`);
  const [params, setParams] = useSearchParams();
  const [boards, setBoards] = useState<HotspotBoard[]>([]);
  const [favorites, setFavorites] = useState<HotspotFavorite[]>([]);
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<HotspotFavorite | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  const requestId = useRef(0);
  const tab = params.get('tab') === 'favorites' ? 'favorites' : 'boards';
  const sourceId = boards.some(board => board.source.id === params.get('source')) ? params.get('source')! : 'all';
  const dirty = !!editing && note !== editing.note;
  const blocker = useBlocker(dirty || noteSaving);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (!noteSaving && window.confirm('备注尚未保存，放弃编辑并离开？')) blocker.proceed(); else blocker.reset();
    }
  }, [blocker, noteSaving]);
  useEffect(() => {
    if (!dirty && !noteSaving) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, noteSaving]);

  const load = async (refresh = false) => {
    const id = ++requestId.current; setLoading(true); setError(''); setNotice('');
    const [boardResult, favoriteResult] = await Promise.allSettled([apiClient.getHotspots(refresh), apiClient.getHotspotFavorites()]);
    if (id !== requestId.current) return;
    const errors: string[] = [];
    if (boardResult.status === 'fulfilled') { setBoards(boardResult.value); if (refresh) setNotice('已检查可刷新来源；距上次尝试不足 60 秒的来源沿用缓存。'); }
    else errors.push(parseApiError(boardResult.reason).message);
    if (favoriteResult.status === 'fulfilled') { setFavorites(favoriteResult.value); setFavoritesReady(true); }
    else { setFavoritesReady(false); errors.push(`选题收藏读取失败：${parseApiError(favoriteResult.reason).message}`); }
    setError(errors.join('；')); setLoading(false);
  };
  useEffect(() => { void load(); return () => { requestId.current++; }; }, []);
  const setView = (key: string, value: string) => { const next = new URLSearchParams(params); if (value === 'all' || value === 'boards') next.delete(key); else next.set(key, value); setParams(next, { replace: true }); };
  const toggle = async (item: HotspotItem) => {
    if (busy || !favoritesReady) return;
    const saved = favorites.find(favorite => sameItem(item, favorite));
    if (saved && !window.confirm(`取消收藏「${saved.title}」？${saved.note ? '它的个人备注也会移除。' : ''}`)) return;
    setBusy(true); setError('');
    try {
      if (saved) { await apiClient.removeHotspot(saved.id, saved.version); setFavorites(items => items.filter(item => item.id !== saved.id)); }
      else { const favorite = await apiClient.saveHotspot(item.sourceId, item.itemId); setFavorites(items => [favorite, ...items.filter(item => item.id !== favorite.id)]); }
    } catch (e) { setError(parseApiError(e).message); }
    finally { setBusy(false); }
  };
  const closeNote = () => { if (!noteSaving && (!dirty || window.confirm('备注尚未保存，放弃本次编辑？'))) setEditing(null); };
  const saveNote = async () => {
    if (!editing || noteSaving || conflict) return;
    setNoteSaving(true); setNoteError('');
    try { const saved = await apiClient.updateHotspotNote(editing.id, note, editing.version); setFavorites(items => items.map(item => item.id === saved.id ? saved : item)); setEditing(null); }
    catch (e) { const parsed = parseApiError(e); setNoteError(parsed.message); setConflict(parsed.status === 409); }
    finally { setNoteSaving(false); }
  };
  const reloadNote = async () => {
    if (!editing) return;
    setNoteSaving(true);
    try {
      const items = await apiClient.getHotspotFavorites(); const latest = items.find(item => item.id === editing.id);
      setFavorites(items);
      if (!latest) { setNoteError('收藏已移除。请复制保留你的备注，再关闭窗口。'); return; }
      setEditing(latest); setConflict(false); setNoteError('已读取最新版本，下方显示当前已保存备注；你的输入保留，请核对后再保存。');
    } catch (e) { setNoteError(parseApiError(e).message); }
    finally { setNoteSaving(false); }
  };
  const matches = (item: HotspotItem) => (sourceId === 'all' || item.sourceId === sourceId) && `${item.title} ${'note' in item ? item.note : ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const visibleBoards = boards.filter(board => sourceId === 'all' || board.source.id === sourceId).map(board => ({ ...board, items: board.items.filter(matches) }));
  const visibleFavorites = favorites.filter(matches);

  return <Layout>
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="flex items-center gap-2 font-display text-2xl font-semibold text-ink"><Flame size={25} className="text-accent" />热点</h1>
        <p className="mt-2 text-sm leading-6 text-ink-muted">先看大家在讨论什么，再决定创作什么。收藏只保存选题，不会生成或发布内容。</p></div>
      <Button disabled={loading || busy} onClick={() => void load(true)}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} />{loading ? '正在获取…' : '刷新榜单'}</Button>
    </header>
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <div className="flex gap-1 rounded-lg border border-line bg-panel p-1" aria-label="热点视图">{[['boards', '平台热榜'], ['favorites', `选题收藏 (${favorites.length})`]].map(([key, label]) => <Button key={key} variant={tab === key ? 'accent' : 'ghost'} aria-pressed={tab === key} onClick={() => setView('tab', key)}>{label}</Button>)}</div>
      <select aria-label="筛选来源" value={sourceId} onChange={event => setView('source', event.target.value)} className="h-9 rounded-lg border border-line-ui bg-panel px-3 text-sm text-ink"><option value="all">全部来源</option>{boards.map(board => <option key={board.source.id} value={board.source.id}>{board.source.name}</option>)}</select>
      <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line-ui bg-well px-3 sm:max-w-sm"><Search size={15} className="shrink-0 text-ink-muted" /><input aria-label="搜索热点或备注" placeholder="搜索已加载的标题或备注" value={search} onChange={event => setSearch(event.target.value)} className="min-w-0 w-full bg-transparent text-sm text-ink outline-none" /></label>
    </div>
    {error && <div role="alert" className="mb-4 rounded-lg border border-danger-line bg-danger-soft p-3 text-sm text-danger">{error}<Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>重新加载</Button></div>}
    {notice && <p role="status" className="mb-4 text-sm text-ink-muted">{notice}</p>}
    <p className="mb-4 text-xs leading-5 text-ink-muted">按来源展示，不混算热度。默认缓存 10 分钟，刷新至少间隔 60 秒；获取时间不是事件发生时间，创作前请打开原文核实。</p>
    {loading && boards.length === 0 ? <p role="status" className="py-16 text-center text-ink-muted">正在读取平台榜单…</p> : tab === 'boards' ?
      <div className={`gap-5 ${sourceId === 'all' ? 'columns-1 lg:columns-2 2xl:columns-3' : 'mx-auto max-w-3xl columns-1'}`}>{visibleBoards.map(board => <HotspotBoardCard key={board.source.id} board={board} favorites={favorites} busy={busy || loading || !favoritesReady} onCreate={create} onDetail={setDetail} onToggle={item => void toggle(item)} onSelectSource={() => setView('source', board.source.id)} compact={sourceId === 'all' && !search.trim()} now={now} />)}</div> :
      visibleFavorites.length ? <div className="grid gap-4 lg:grid-cols-2">{visibleFavorites.map(item => <article key={item.id} className="min-w-0 rounded-xl border border-line bg-panel p-5">
        <p className="mb-2 text-xs text-ink-muted">{boards.find(board => board.source.id === item.sourceId)?.source.name ?? item.sourceId} · 收藏时排名 {item.rank} · 榜单获取于 {timestamp(item.fetchedAt)}</p>
        <button type="button" onClick={() => create(item)} className="mb-2 block text-xs text-accent hover:underline">以此创作公众号文章</button><button type="button" aria-label={`查看详情：${item.title}`} onClick={()=>setDetail({...item,sourceName:boards.find(b=>b.source.id===item.sourceId)?.source.name})} className="break-words text-left font-medium leading-6 text-ink hover:text-accent">{item.title}</button>
        <p className="my-3 whitespace-pre-wrap break-words text-sm leading-6 text-ink-muted">{item.note || '还没有备注。记下创作角度或需要核实的信息。'}</p>
        <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => { setEditing(item); setNote(item.note); setNoteError(''); setConflict(false); }}><StickyNote size={14} />编辑备注</Button><Button size="sm" variant="ghost" disabled={busy || !favoritesReady} onClick={() => void toggle(item)}>取消收藏</Button></div>
      </article>)}</div> : <div className="rounded-xl border border-dashed border-line p-10 text-center"><Bookmark className="mx-auto mb-3 text-ink-muted" size={28} /><h2 className="font-semibold text-ink">{favorites.length ? '没有匹配的收藏' : '还没有选题收藏'}</h2><p className="mt-2 text-sm text-ink-muted">{favorites.length ? '调整来源或搜索词，查看其它收藏。' : '在平台热榜点击书签，保存感兴趣的话题；下榜后仍会保留。'}</p></div>}
    <HotspotDetailDialog item={detail} onClose={()=>setDetail(null)}/>
    <Modal open={!!editing} onClose={closeNote} title="选题备注" subtitle={<p className="break-words text-sm text-ink-muted">{editing?.title}</p>} busy={noteSaving} footer={<><Button onClick={closeNote} disabled={noteSaving}>取消</Button><Button variant="primary" onClick={() => void saveNote()} disabled={noteSaving || !dirty || note.length > 2000 || conflict}><Check size={15} />{noteSaving ? '正在保存…' : '保存备注'}</Button></>}>
      {noteError && <div role="alert" className="mb-3 text-sm leading-6 text-warning">{noteError}{conflict && <Button size="sm" disabled={noteSaving} onClick={() => void reloadNote()}>重新加载并核对</Button>}</div>}
      {editing && noteError && !conflict && <p className="mb-3 whitespace-pre-wrap break-words text-xs text-ink-muted">当前已保存备注：{editing.note || '（空）'}</p>}
      <label htmlFor="hotspot-note" className="mb-2 block text-sm text-ink">创作角度 / 待核实信息</label>
      <textarea id="hotspot-note" value={note} disabled={noteSaving} onChange={event => setNote(event.target.value)} rows={7} className="w-full rounded-lg border border-line-ui bg-well p-3 text-sm leading-6 text-ink" />
      <p className={`mt-2 text-right text-xs ${note.length > 2000 ? 'text-danger' : 'text-ink-muted'}`}>{note.length} / 2000 字符 · 手动保存</p>
    </Modal>
  </Layout>;
}
