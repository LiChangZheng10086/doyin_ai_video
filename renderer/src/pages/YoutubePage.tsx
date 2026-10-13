import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Home, RefreshCw, Search, MonitorPlay } from 'lucide-react';
import type { YoutubeBrowserAction, YoutubeBrowserState } from '../../../electron/youtube-browser';
import { Button } from '../components/ui/Button';
import { Layout } from '../components/Layout';
import { apiClient } from '../services/api';

const INITIAL: YoutubeBrowserState = { url: 'https://www.youtube.com/', title: 'YouTube', loading: false, canGoBack: false, canGoForward: false };
const errorMessage = (error: unknown) => (error as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message ?? (error as Error)?.message ?? '操作失败，请稍后重试';

export function YoutubePage() {
  const browser = typeof window === 'undefined' ? undefined : window.electron?.youtubeBrowser;
  const navigate = useNavigate();
  const viewport = useRef<HTMLDivElement>(null);
  const capturePending = useRef(false);
  const [state, setState] = useState(INITIAL);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!browser || !viewport.current) return;
    let alive = true;
    const update = (value: YoutubeBrowserState) => { if (alive) setState(value); };
    const unsubscribe = browser.onState(update);
    void browser.getState().then(update).catch(reason => { if (alive) setError(errorMessage(reason)); });
    const syncBounds = () => {
      const rect = viewport.current?.getBoundingClientRect();
      const hidden = document.getElementById('root')?.hasAttribute('inert') || document.querySelector('[role="dialog"][aria-modal="true"]') || document.hidden;
      const left = Math.max(0, rect?.left ?? 0), top = Math.max(56, rect?.top ?? 0);
      const right = Math.min(window.innerWidth, rect?.right ?? 0);
      const bottom = Math.min(window.innerHeight - (window.innerWidth < 768 ? 56 : 0), rect?.bottom ?? 0);
      const bounds = !hidden && right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
      void browser.setBounds(bounds).catch(reason => { if (alive) setError(errorMessage(reason)); });
    };
    const resize = new ResizeObserver(syncBounds);
    resize.observe(viewport.current);
    const modal = new MutationObserver(syncBounds);
    modal.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'aria-modal'] });
    window.addEventListener('resize', syncBounds);
    window.addEventListener('scroll', syncBounds, true);
    document.addEventListener('visibilitychange', syncBounds);
    syncBounds();
    return () => {
      alive = false; unsubscribe(); resize.disconnect(); modal.disconnect();
      window.removeEventListener('resize', syncBounds);
      window.removeEventListener('scroll', syncBounds, true);
      document.removeEventListener('visibilitychange', syncBounds);
      void browser.setBounds(null).catch(() => {});
    };
  }, [browser]);

  async function command(action: YoutubeBrowserAction) {
    setError('');
    try { await browser?.command(action, action === 'search' ? query : undefined); }
    catch (reason) { setError(errorMessage(reason)); }
  }
  async function capture() {
    if (!browser || capturePending.current) return;
    capturePending.current = true; setCreating(true); setError('');
    try {
      const input = await browser.capture();
      const job = await apiClient.createJob(input);
      navigate(`/jobs/${job.id}`);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { capturePending.current = false; setCreating(false); }
  }

  return <Layout>
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="flex items-center gap-2 text-xl font-semibold"><MonitorPlay size={22} />油管</h1><p className="mt-1 text-sm text-ink-muted">找视频，采集后到作品页继续处理。</p></div>
        <Button variant="primary" disabled={!browser || !state.videoUrl || creating || state.loading} onClick={() => void capture()}>{creating ? '正在采集…' : '采集当前视频'}</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="flex gap-1">
          <Button size="icon" aria-label="后退" disabled={!browser || !state.canGoBack} onClick={() => void command('back')}><ArrowLeft size={16} /></Button>
          <Button size="icon" aria-label="前进" disabled={!browser || !state.canGoForward} onClick={() => void command('forward')}><ArrowRight size={16} /></Button>
          <Button size="icon" aria-label="油管首页" disabled={!browser} onClick={() => void command('home')}><Home size={16} /></Button>
          <Button size="icon" aria-label="刷新油管页面" disabled={!browser} onClick={() => void command('reload')}><RefreshCw size={16} /></Button>
        </div>
        <form className="flex min-w-0 flex-1 gap-2" onSubmit={event => { event.preventDefault(); void command('search'); }}>
          <input aria-label="搜索视频或粘贴油管链接" placeholder="搜索视频或粘贴油管链接" maxLength={500} value={query} onChange={event => setQuery(event.target.value)} disabled={!browser} className="h-8 min-w-0 flex-1 rounded-lg border border-line-ui bg-panel px-3 text-sm" />
          <Button type="submit" size="sm" disabled={!browser || !query.trim()}><Search size={14} />搜索</Button>
        </form>
      </div>
      <p className="text-xs text-ink-muted">采集只创建作品，不会自动下载或转录。浏览页登录状态不会同步给下载器。</p>
      {(error || state.error) && <p role="alert" className="rounded-lg border border-danger-line bg-danger-soft p-3 text-sm text-danger">{error || state.error}</p>}
      <div className="flex items-center gap-2 text-xs text-ink-muted"><span role="status">{state.loading ? '正在加载…' : state.title}</span><span className="min-w-0 truncate" title={state.url}>{state.url}</span></div>
      <div ref={viewport} data-testid="youtube-viewport" className="flex min-h-[280px] items-center justify-center rounded-lg border border-line bg-panel" style={{ height: 'calc(100dvh - 270px)' }}>
        {!browser ? <p className="px-4 text-center text-sm text-ink-muted">请在桌面版打开油管浏览页</p> : state.error ? <p className="text-sm text-ink-muted">刷新页面后继续浏览</p> : <p className="text-sm text-ink-muted">正在打开油管…</p>}
      </div>
    </div>
  </Layout>;
}
