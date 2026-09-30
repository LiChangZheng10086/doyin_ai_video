import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FilePenLine, Plus, Trash2 } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button } from '../components/ui/Button';
import { apiClient, parseApiError } from '../services/api';
import type { ArticleRecord } from '../../../src/lib/article-types';
export function ArticlesPage() {
  const [params] = useSearchParams(); const navigate = useNavigate();
  const [items,setItems] = useState<ArticleRecord[]>([]); const [keyword,setKeyword] = useState(params.get('keyword') ?? '');
  const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  useEffect(() => { void apiClient.getArticles().then(setItems).catch(e => setError(parseApiError(e).message)); },[]);
  const create = async () => {
    setBusy(true); setError('');
    try { const a = await apiClient.createArticle({keyword, ...(params.get('sourceId') && params.get('itemId') ? {hotspot:{sourceId:params.get('sourceId')!,itemId:params.get('itemId')!}} : {})}); navigate(`/articles/${a.id}`); }
    catch(e) { setError(parseApiError(e).message); } finally { setBusy(false); }
  };
  const remove = async (a: ArticleRecord) => {
    if (!window.confirm('删除这篇文章和创作记录？已建立的发布包会保留。')) return;
    setBusy(true); try { await apiClient.removeArticle(a.id,a.version); setItems(items.filter(i => i.id !== a.id)); } catch(e) { setError(parseApiError(e).message); } finally { setBusy(false); }
  };
  return <Layout><div className="mx-auto max-w-6xl space-y-7 p-5 sm:p-8">
    <header><p className="text-xs tracking-widest text-accent">公众号创作</p><h1 className="mt-2 font-display text-3xl font-semibold text-ink">从一个问题，写到一篇有依据的文章</h1><p className="mt-3 text-sm leading-6 text-ink-muted">接入已有热榜或输入关键词，逐步完成选题、资料、提纲、初稿与审校。</p></header>
    <Link to="/articles/benchmarks" className="inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline">寻找同赛道对标账号、核验阅读依据 →</Link>
    <form onSubmit={e => {e.preventDefault(); void create();}} className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-5 sm:flex-row"><label className="flex-1 text-sm text-ink-muted">{params.get('sourceId') ? '来自热榜的选题线索' : '想写的热点或关键词'}<input aria-label="选题关键词" maxLength={500} value={keyword} onChange={e => setKeyword(e.target.value)} className="mt-2 w-full rounded-lg border border-line bg-canvas px-4 py-3 text-ink" placeholder="例如：一款产品的更新，给普通用户带来什么？" /></label><Button type="submit" disabled={busy || !keyword.trim()} className="self-end"><Plus size={16}/>开始创作</Button></form>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{items.map(a => <article key={a.id} className="rounded-xl border border-line bg-panel p-5"><div className="flex items-start justify-between gap-4"><FilePenLine className="text-accent" size={22}/><button type="button" aria-label={`删除${a.keyword}`} disabled={busy || !!a.running} onClick={() => void remove(a)} className="text-ink-muted hover:text-danger"><Trash2 size={16}/></button></div><Link to={`/articles/${a.id}`} className="mt-5 block font-display text-lg font-semibold text-ink hover:text-accent">{a.revision?.title ?? a.draft?.title ?? a.keyword}</Link><p className="mt-3 text-xs text-ink-muted">{a.running ? '处理中' : a.reviewed ? '已审阅定稿' : '创作中'} · {a.sources.length} 份资料 · {new Date(a.updatedAt).toLocaleDateString('zh-CN')}</p><Link to={`/articles/${a.id}`} className="mt-5 inline-block text-sm text-accent">继续写作 →</Link></article>)}</div>
    {!items.length && <p className="py-12 text-center text-sm text-ink-muted">从上方输入关键词，或到「热点」选择一条线索。</p>}
  </div></Layout>;
}
