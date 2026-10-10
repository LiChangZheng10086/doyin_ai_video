import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FilePenLine, Plus, Trash2 } from 'lucide-react';
import { Layout } from '../components/Layout';
import { Button } from '../components/ui/Button';
import { apiClient, parseApiError } from '../services/api';
import type { ArticleRecord } from '../../../src/lib/article-types';
import { MODERN_WECHAT_LAYOUTS } from '../../../src/lib/wechat-templates';
const INPUT_KEY='douyin-ai-video.article-create-input';
const REQUEST_KEY=INPUT_KEY+'.request';
export function ArticlesPage() {
  const [params] = useSearchParams(); const navigate = useNavigate();
  const [items,setItems] = useState<ArticleRecord[]>([]);
  const [input,setInput]=useState(()=>params.get('keyword')??localStorage.getItem(INPUT_KEY)??'');
  const [manual,setManual]=useState(false),[audience,setAudience]=useState(''),[purpose,setPurpose]=useState(''),[template,setTemplate]=useState('');
  const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  const submitting=useRef(false),request=useRef<{key:string;id:string}|undefined>((()=>{try{return JSON.parse(localStorage.getItem(REQUEST_KEY)??'null')??undefined;}catch{return undefined;}})());
  useEffect(() => { void apiClient.getArticles().then(setItems).catch(e => setError(parseApiError(e).message)); },[]);
  useEffect(()=>{try{localStorage.setItem(INPUT_KEY,input);}catch{/* The visible input remains available. */}},[input]);
  const create = async () => {
    if(submitting.current)return;submitting.current=true;setBusy(true);setError('');
    try {
      let a:ArticleRecord;
      if(manual){if(input.length>500)throw new Error('手动选题最多500字符；完整资料请使用自动创作');a=await apiClient.createArticle({keyword:input,...(params.get('sourceId')&&params.get('itemId')?{hotspot:{sourceId:params.get('sourceId')!,itemId:params.get('itemId')!}}:{})});}
      else {const data={input,...(params.get('sourceId')&&params.get('itemId')?{hotspot:{sourceId:params.get('sourceId')!,itemId:params.get('itemId')!}}:{}),requirements:{...(audience?{audience}:{}),...(purpose?{purpose}:{})},...(template?{layoutTemplate:template}:{})};const key=JSON.stringify(data);if(request.current?.key!==key)request.current={key,id:crypto.randomUUID()};try{localStorage.setItem(REQUEST_KEY,JSON.stringify(request.current));}catch{/* In-memory retry remains available. */}a=await apiClient.createArticleAuto({...data,requestId:request.current!.id});}
      localStorage.removeItem(INPUT_KEY);localStorage.removeItem(REQUEST_KEY);navigate(`/articles/${a.id}`);
    } catch(e) { setError(e instanceof Error&&e.name!=='PublishingApiError'?e.message:parseApiError(e).message); }
    finally{submitting.current=false;setBusy(false);}
  };
  const remove = async (a: ArticleRecord) => {
    if (!window.confirm('删除这篇文章和创作记录？已建立的发布包会保留。')) return;
    setBusy(true); try { await apiClient.removeArticle(a.id,a.version); setItems(items.filter(i => i.id !== a.id)); } catch(e) { setError(parseApiError(e).message); } finally { setBusy(false); }
  };
  return <Layout><div className="mx-auto max-w-6xl space-y-7 p-5 sm:p-8">
    <header><p className="text-xs tracking-widest text-accent">公众号创作</p><h1 className="mt-2 font-display text-3xl font-semibold text-ink">把灵感变成一篇可修改的文章</h1><p className="mt-3 text-sm leading-6 text-ink-muted">丢进文字或公开链接，自动整理资料、写作、审校和配图。完成后停在预览，由你决定是否保存公众号草稿。</p></header>
    <form onSubmit={e=>{e.preventDefault();void create();}} className="space-y-4 rounded-xl border border-line bg-panel p-5 sm:p-7">
      <label className="block text-sm text-ink">{manual?'选题关键词':'灵感、资料或公开链接'}<textarea aria-label="灵感、资料或公开链接" rows={7} maxLength={30000} value={input} disabled={busy} onChange={e=>setInput(e.target.value)} className="mt-3 w-full rounded-lg border border-line-ui bg-canvas px-4 py-3 leading-7 text-ink" placeholder="粘贴已有正文，或 https://… 的公开报道链接；也可以先写下你的灵感。"/></label>
      <p className="text-xs leading-6 text-ink-muted">使用当前 AI 配置处理你提供的内容。仅输入你有权使用的公开资料；链接读不到正文时会停下请你补充，不编造来源。</p>
      <details><summary className="cursor-pointer text-sm text-ink-muted">高级设置</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-xs text-ink-muted">目标读者<input aria-label="目标读者" value={audience} onChange={e=>setAudience(e.target.value)} maxLength={2000} className="mt-2 w-full rounded border border-line-ui bg-canvas p-3"/></label><label className="text-xs text-ink-muted">文章目标<input aria-label="文章目标" value={purpose} onChange={e=>setPurpose(e.target.value)} maxLength={2000} className="mt-2 w-full rounded border border-line-ui bg-canvas p-3"/></label><label className="text-xs text-ink-muted">排版模板<select aria-label="创作模板" value={template} onChange={e=>setTemplate(e.target.value)} className="mt-2 w-full rounded border border-line-ui bg-canvas p-3"><option value="">自动推荐或沿用我的默认</option>{MODERN_WECHAT_LAYOUTS.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label className="flex items-center gap-2 text-sm text-ink-muted"><input type="checkbox" checked={manual} onChange={e=>setManual(e.target.checked)}/>逐步创作，手动确认各阶段</label></div></details>
      <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-ink-subtle">已有配置会复用；首次缺少 AI 配置时保留输入并引导设置。</span><Button type="submit" disabled={busy||!input.trim()}><Plus size={16}/>{busy?'正在创建…':manual?'开始逐步创作':'自动创作'}</Button></div>
    </form>
    {error&&<p role="alert" className="text-sm text-danger">{error}</p>}
    <Link to="/articles/benchmarks" className="inline-block text-sm text-accent">同赛道对标与写作参考 →</Link>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{items.map(a=>{const running=!!a.running||!!a.automation&&['queued','running','cancelling'].includes(a.automation.status);return <article key={a.id} className="rounded-xl border border-line bg-panel p-5"><div className="flex items-start justify-between gap-4"><FilePenLine className="text-accent" size={22}/><button type="button" aria-label={`删除${a.keyword}`} disabled={busy||running} onClick={()=>void remove(a)} className="text-ink-muted hover:text-danger"><Trash2 size={16}/></button></div><Link to={`/articles/${a.id}`} className="mt-5 block font-display text-lg font-semibold text-ink hover:text-accent">{a.revision?.title??a.draft?.title??a.keyword}</Link><p className="mt-3 text-xs text-ink-muted">{running?'自动创作中':a.automation?.status==='ready'?'文章可预览':a.automation?.status==='needs_input'?'等待补充':a.automation?.status==='failed'?'失败可继续':a.reviewed?'已审阅定稿':'创作中'} · {a.sources.length}份资料</p><Link to={`/articles/${a.id}`} className="mt-5 inline-block text-sm text-accent">查看文章 →</Link></article>;})}</div>
    {!items.length&&<p className="py-8 text-center text-sm text-ink-muted">你的资料和每一步成果会保存在本机，可随时回来继续。</p>}
  </div></Layout>;
}
