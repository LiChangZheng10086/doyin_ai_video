import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { GalleryVerticalEnd, Loader2, Plus, Trash2 } from 'lucide-react';
import { Layout } from '../components/Layout';
import { apiClient, parseApiError } from '../services/api';
import type { Gallery } from '../../../src/lib/gallery-types';
import type { JobOverview } from '../types';

const labels = { draft: '待生成', ready: '已生成', running: '生成中', failed: '生成失败' };

export function GalleriesPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [galleries, setGalleries] = useState<Gallery[]>([]);
  const [jobs, setJobs] = useState<JobOverview[]>([]);
  const [source, setSource] = useState(params.get('sourceJobId') ?? '');
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setLoading(true); setError('');
    try {
      const [items, works] = await Promise.all([apiClient.getGalleries(), apiClient.getJobOverviews()]);
      setGalleries(items); setJobs(works.filter(job => !job.deletedAt && job.videoPath));
      const thumbnails = await Promise.all(items.filter(g => g.generated).map(async g => [g.id, await apiClient.getGalleryImageUrl(g.id, 0, g.generated!.id)] as const));
      setUrls(Object.fromEntries(thumbnails));
    } catch (e) { setError(parseApiError(e).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const create = async () => {
    setBusy(true); setError('');
    try { const gallery = await apiClient.createGallery(source); navigate(`/galleries/${gallery.id}`); }
    catch (e) { setError(parseApiError(e).message); }
    finally { setBusy(false); }
  };
  const remove = async (g: Gallery) => {
    if (!window.confirm(`删除「${g.title}」及其图集图片？已创建的发布包会保留。`)) return;
    setBusy(true);
    try { await apiClient.deleteGallery(g.id, g.version); await load(); }
    catch (e) { setError(parseApiError(e).message); }
    finally { setBusy(false); }
  };
  return <Layout>
    <div className="mb-6 flex items-start gap-3"><GalleryVerticalEnd className="mt-1 text-accent" size={28} /><div>
      <h1 className="text-2xl font-semibold text-ink">图集创作</h1>
      <p className="mt-2 text-sm text-ink-muted">把原视频里的真实字幕拼成整套图集，直接准备抖音图文发布。不需要洗稿或生成视频。</p>
    </div></div>
    {error && <div role="alert" className="mb-4 rounded-lg border border-danger-line bg-danger-soft p-4 text-sm text-danger">{error}<button className="ml-3 underline" onClick={() => void load()}>重新加载</button></div>}
    <section className="mb-7 rounded-lg border border-line bg-panel p-5">
      <h2 className="font-semibold text-ink">新建字幕图集</h2>
      <p className="my-2 text-sm text-ink-muted">选择已经下载原视频的作品。没有可选作品？<Link to="/" className="text-accent underline">先创建作品并执行视频转录</Link>。</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <select aria-label="来源作品" value={source} onChange={e => setSource(e.target.value)} disabled={busy || loading} className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm text-ink">
          <option value="">选择原视频作品</option>{jobs.map(job => <option key={job.id} value={job.id}>{job.topic || job.id}</option>)}
        </select>
        <button disabled={!source || busy || loading} onClick={() => void create()} className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-on-accent disabled:opacity-50">{busy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}新建字幕图集</button>
      </div>
    </section>
    {loading ? <p role="status" className="text-ink-muted">正在加载图集…</p> : galleries.length === 0 ?
      <div className="rounded-lg border border-dashed border-line p-10 text-center"><h2 className="font-semibold text-ink">还没有字幕图集</h2><p className="mt-2 text-sm text-ink-muted">从上方选择一个原视频，自动规划整套图集，认可方案后一键生成。</p></div> :
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{galleries.map(g => <article key={g.id} className="overflow-hidden rounded-lg border border-line bg-panel">
        <Link to={`/galleries/${g.id}`} className="block"><div className="flex aspect-[3/4] items-center justify-center bg-canvas">{urls[g.id] ? <img src={urls[g.id]} alt={g.title} className="h-full w-full object-contain" /> : <GalleryVerticalEnd size={48} className="text-ink-muted" />}</div></Link>
        <div className="p-4"><Link to={`/galleries/${g.id}`} className="font-semibold text-ink hover:text-accent">{g.title}</Link>
          <div className="mt-2 flex items-center justify-between text-xs text-ink-muted"><span>{g.images.length} 张 · {labels[g.status]}</span><button aria-label={`删除${g.title}`} disabled={busy || g.status === 'running'} onClick={() => void remove(g)} className="p-1 hover:text-danger disabled:opacity-50"><Trash2 size={16} /></button></div>
          <p className="mt-2 text-xs text-ink-muted">{new Date(g.updatedAt).toLocaleString('zh-CN')}</p>
          <Link to={`/jobs/${g.sourceJobId}`} className="mt-2 inline-block text-xs text-accent">查看来源作品</Link>
        </div>
      </article>)}</div>}
  </Layout>;
}
