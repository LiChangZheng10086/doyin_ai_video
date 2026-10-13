import type { BrowserWindow, WebContentsView, IpcMain, Rectangle } from 'electron';
const HOME = 'https://www.youtube.com/';
const VIDEO_HOSTS = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'];
const HOSTS = [...VIDEO_HOSTS, 'accounts.google.com', 'consent.youtube.com', 'consent.google.com'];
export type YoutubeBrowserAction = 'search' | 'home' | 'back' | 'forward' | 'reload';
export interface YoutubeBrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  videoUrl?: string;
  error?: string;
}
export interface YoutubeBrowserAPI {
  setBounds: (bounds: Rectangle | null) => Promise<YoutubeBrowserState>;
  command: (action: YoutubeBrowserAction, value?: string) => Promise<YoutubeBrowserState>;
  getState: () => Promise<YoutubeBrowserState>;
  capture: () => Promise<{
    sourceUrl: string;
    topic: string;
  }>;
  onState: (listener: (state: YoutubeBrowserState) => void) => () => void;
}
export function allowedYoutubeNavigation(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 4096)
    return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && HOSTS.includes(url.hostname);
  }
  catch {
    return false;
  }
}
export function youtubeVideoUrl(raw: string): string | undefined {
  if (!allowedYoutubeNavigation(raw))
    return undefined;
  const url = new URL(raw);
  if (!VIDEO_HOSTS.includes(url.hostname))
    return undefined;
  const id = url.hostname === 'youtu.be' ? /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  return id && /^[\w-]{11}$/.test(id) ? `${HOME}watch?v=${id}` : undefined;
}
export class YoutubeBrowser {
  private view?: WebContentsView;
  private bounds: Rectangle | null = null;
  private error?: string;
  private timeout?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private hideForReload = () => this.setBounds(null);
  constructor(private window: BrowserWindow, private createView: () => WebContentsView) {
    window.webContents.on('did-start-loading', this.hideForReload);
  }
  private publish() {
    if (!this.disposed && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send('youtube-browser-state', this.getState());
    }
  }
  private applyVisibility() {
    if (!this.view) return;
    const visible = !!this.bounds && !this.error;
    this.view.setVisible(visible);
    this.view.webContents.setAudioMuted(!visible);
  }
  private fail(message: string) {
    this.error = message;
    this.applyVisibility();
    this.publish();
  }
  private clearTimeout() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
  }
  private ensureView() {
    if (this.disposed)
      throw new Error('油管浏览窗口已关闭');
    if (this.view)
      return this.view;
    const view = this.createView();
    this.view = view;
    const wc = view.webContents;
    const guard = (event: Electron.Event, url: string) => { if (!allowedYoutubeNavigation(url)) {
      event.preventDefault();
      this.fail('此链接不属于油管浏览范围，请在油管页面中选择视频');
    } };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.setWindowOpenHandler(({ url }) => { if (allowedYoutubeNavigation(url))
      this.load(url);
    else
      this.fail('此链接不属于油管浏览范围'); return { action: 'deny' }; });
    wc.on('did-start-loading', () => {
      if (wc.isLoadingMainFrame()) {
        this.clearTimeout();
        this.timeout = setTimeout(() => { wc.stop(); this.fail('油管页面加载超时，请检查网络后刷新'); }, 25000);
      }
      this.publish();
    });
    wc.on('did-stop-loading', () => { this.clearTimeout(); this.publish(); });
    wc.on('did-finish-load', () => { this.error = undefined; this.applyVisibility(); this.publish(); });
    wc.on('did-navigate', () => this.publish());
    wc.on('did-navigate-in-page', () => this.publish());
    wc.on('page-title-updated', () => this.publish());
    wc.on('did-fail-load', (_event, code, _description, _url, main) => { if (main && code !== -3)
      this.fail(`油管页面加载失败（${code}），请检查网络后刷新`); });
    wc.on('render-process-gone', () => this.fail('油管页面已退出，请刷新重试'));
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    this.load(HOME);
    return view;
  }
  private load(url: string) {
    this.error = undefined;
    this.applyVisibility();
    void this.view!.webContents.loadURL(url).catch(error => { if (!this.disposed && error.code !== 'ERR_ABORTED' && error.errno !== -3)
      this.fail('油管页面加载失败，请检查网络后刷新'); });
  }
  setBounds(raw: Rectangle | null): YoutubeBrowserState {
    if (raw !== null && (!raw || !['x', 'y', 'width', 'height'].every(key => typeof raw[key as keyof Rectangle] === 'number' && Number.isFinite(raw[key as keyof Rectangle])) || raw.width < 0 || raw.height < 0))
      throw new Error('油管浏览区域无效');
    if (raw === null) {
      this.bounds = null;
      this.applyVisibility();
      this.publish();
      return this.getState();
    }
    const window = this.window.getContentBounds();
    const scale = this.window.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(window.width, Math.floor(raw.x * scale))), y = Math.max(0, Math.min(window.height, Math.floor(raw.y * scale)));
    const width = Math.max(0, Math.min(window.width, Math.ceil((raw.x + raw.width) * scale)) - x), height = Math.max(0, Math.min(window.height, Math.ceil((raw.y + raw.height) * scale)) - y);
    this.bounds = width && height ? { x, y, width, height } : null;
    if (this.bounds)
      this.ensureView().setBounds(this.bounds);
    this.applyVisibility();
    this.publish();
    return this.getState();
  }
  command(action: YoutubeBrowserAction, value?: string): YoutubeBrowserState {
    if (!['search', 'home', 'back', 'forward', 'reload'].includes(action))
      throw new Error('油管浏览操作无效');
    let target: string | undefined;
    if (action === 'search') {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 500)
        throw new Error('请输入 1～500 字符的搜索词或油管链接');
      const text = value.trim();
      if (/^[a-z][a-z\d+.-]*:/i.test(text)) {
        if (!allowedYoutubeNavigation(text))
          throw new Error('请使用公开的油管 HTTPS 链接');
        target = text;
      }
      else
        target = `${HOME}results?${new URLSearchParams({ search_query: text })}`;
    }
    const wc = this.ensureView().webContents;
    if (target)
      this.load(target);
    else if (action === 'home')
      this.load(HOME);
    else if (action === 'reload') {
      this.error = undefined;
      this.applyVisibility();
      wc.reload();
    }
    else if (action === 'back' && wc.navigationHistory.canGoBack()) {
      this.error = undefined; this.applyVisibility(); wc.navigationHistory.goBack();
    }
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) {
      this.error = undefined; this.applyVisibility(); wc.navigationHistory.goForward();
    }
    return this.getState();
  }
  getState(): YoutubeBrowserState {
    const wc = this.view?.webContents;
    const raw = wc?.getURL() ?? HOME;
    const loading = wc?.isLoadingMainFrame() ?? false;
    const url = allowedYoutubeNavigation(raw) ? VIDEO_HOSTS.includes(new URL(raw).hostname) ? raw : new URL(raw).origin + new URL(raw).pathname : HOME;
    return { url, title: wc?.getTitle().slice(0, 500) ?? 'YouTube', loading, canGoBack: wc?.navigationHistory.canGoBack() ?? false, canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      ...(!loading && !this.error && this.bounds ? { videoUrl: youtubeVideoUrl(raw) } : {}), ...(this.error ? { error: this.error } : {}) };
  }
  capture() {
    if (!this.bounds)
      throw new Error('请先打开油管浏览页');
    const state = this.getState();
    if (state.loading)
      throw new Error('视频页面仍在加载，请稍后采集');
    if (state.error)
      throw new Error(state.error);
    if (!state.videoUrl)
      throw new Error('请先打开一条油管视频，搜索页和频道页不能采集');
    return { sourceUrl: state.videoUrl, topic: state.title.replace(/\s*[-–]\s*YouTube\s*$/, '').trim().slice(0, 200) };
  }
  dispose() {
    if (this.disposed)
      return;
    this.disposed = true;
    this.clearTimeout();
    this.window.webContents.removeListener('did-start-loading', this.hideForReload);
    if (this.view) {
      if (!this.window.isDestroyed())
        this.window.contentView.removeChildView(this.view);
      if (!this.view.webContents.isDestroyed())
        this.view.webContents.close();
      this.view = undefined;
    }
  }
}
export function registerYoutubeBrowserHandlers(ipc: Pick<IpcMain, 'handle' | 'removeHandler'>, window: BrowserWindow, browser: YoutubeBrowser, rendererUrl: string) {
  const target = new URL(rendererUrl);
  const handlers: Record<string, (...args: any[]) => unknown> = {
    'youtube-browser-state': () => browser.getState(), 'youtube-browser-bounds': bounds => browser.setBounds(bounds),
    'youtube-browser-command': (action, value) => browser.command(action, value), 'youtube-browser-capture': () => browser.capture(),
  };
  for (const [name, handler] of Object.entries(handlers))
    ipc.handle(name, (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        throw new Error('油管操作来源无效');
      const source = new URL(event.senderFrame.url);
      if (target.protocol === 'file:' ? source.protocol !== 'file:' || source.pathname !== target.pathname : source.origin !== target.origin)
        throw new Error('油管操作来源无效');
      return handler(...args);
    });
  return () => {
    for (const name of Object.keys(handlers)) ipc.removeHandler(name);
    browser.dispose();
  };
}
