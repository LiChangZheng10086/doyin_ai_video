import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Layout } from '../components/Layout';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { apiClient, parseApiError } from '../services/api';
import type { XhsNote } from '../../../src/lib/xhs-notes';

export function XhsNotesPage() {
  const navigate = useNavigate();
  const [notes, setNotes] = useState<XhsNote[]>([]);
  const [sourceText, setSourceText] = useState('');
  const sourceLength = Array.from(sourceText).length;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<XhsNote | null>(null);
  const working = useRef(false);
  useEffect(() => {
    let active = true;
    void apiClient.getXhsNotes().then(items => { if (active) setNotes(items); })
      .catch(e => { if (active) setError(parseApiError(e).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const create = async () => {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try { const note = await apiClient.createXhsNote({ sourceText }); navigate(`/xhs-notes/${note.id}`); }
    catch (e) { setError(parseApiError(e).message); }
    finally { working.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (!removing || working.current) return;
    working.current = true; setBusy(true); setError('');
    try {
      await apiClient.deleteXhsNote(removing.id, removing.version);
      setNotes(items => items.filter(note => note.id !== removing.id)); setRemoving(null);
    } catch (e) { setError(parseApiError(e).message); setRemoving(null); }
    finally { working.current = false; setBusy(false); }
  };
  return <Layout>
    <PageHeader title="小红书创作" description="粘贴其他平台的原文，改写为可编辑的笔记，再用素材图片或文字图卡配图。草稿保存在本机。" />
    <form className="mb-6 space-y-4 rounded-lg border border-line bg-panel p-5" onSubmit={e => { e.preventDefault(); void create(); }}>
      <label className="block text-sm text-ink">其他平台原文
        <textarea aria-label="其他平台原文" value={sourceText} onChange={e => setSourceText(e.target.value)} disabled={busy} rows={7}
          className="mt-2 w-full rounded-lg border border-line-ui bg-well p-3 text-sm leading-7 text-ink" placeholder="粘贴完整正文，保留数字、条件和出处。链接可在工作台补充。" />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-ink-muted">{sourceLength}/40000 · 保存后继续编辑原文与改写要求</span>
        <Button type="submit" variant="primary" disabled={busy || !sourceText.trim() || sourceLength > 40000}><Plus size={16} />{busy ? '正在保存…' : '保存原文，开始创作'}</Button>
      </div>
      {sourceLength > 40000 && <p role="alert" className="text-sm text-warning">原文超过 40000 字，完整输入已保留。请自行整理到限额内再创建，不会自动截断。</p>}
    </form>
    {error && <p role="alert" className="mb-4 text-sm text-danger">{error}</p>}
    {loading ? <p role="status" className="text-sm text-ink-muted">正在加载笔记…</p> : !notes.length ?
      <p className="py-8 text-center text-sm text-ink-muted">还没有笔记。从上方粘贴一篇原文开始。</p> :
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{notes.map(note => <article key={note.id} className="min-w-0 rounded-lg border border-line bg-panel p-5">
        <Link to={`/xhs-notes/${note.id}`} className="block break-words font-display text-xl text-ink hover:text-accent">{note.title || '待改写笔记'}</Link>
        <p className="mt-3 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6 text-ink-muted">{note.description || note.sourceText}</p>
        <p className="mt-3 text-xs text-ink-muted">{note.contentSourceHash ? '已改写，可继续编辑' : '等待按当前原文改写'} · {note.imageAssetIds.length} 张图片</p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <time className="text-xs text-ink-subtle" dateTime={note.updatedAt}>{new Date(note.updatedAt).toLocaleString('zh-CN')}</time>
          <Button size="sm" variant="subtleDanger" disabled={busy} aria-label={`删除${note.title || '待改写笔记'}`} onClick={() => setRemoving(note)}>删除</Button>
        </div>
      </article>)}</div>}
    <ConfirmDialog open={!!removing} title="删除创作草稿？" description="删除本机笔记与创作记录，已建立的发布包会保留。" confirmLabel="删除草稿" tone="danger" busy={busy} onClose={() => setRemoving(null)} onConfirm={() => void remove()} />
  </Layout>;
}
