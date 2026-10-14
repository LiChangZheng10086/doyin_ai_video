import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
const modulePromise = import('./youtube-browser.js').catch(() => null);
const id = 'M7lc1UVf-VE';
async function fixture() {
  const lib = await modulePromise;
  assert.ok(lib, '内置油管控制器尚未实现');
  const wc = Object.assign(new EventEmitter(), { url: '', loading: false, title: 'Example - YouTube', muted: false, closed: false,
    getURL() { return this.url; }, getTitle() { return this.title; }, isLoadingMainFrame() { return this.loading; }, isDestroyed() { return this.closed; },
    setAudioMuted(value: boolean) { this.muted = value; }, close() { this.closed = true; }, stop() { this.loading = false; }, reload() { this.loading = true; },
    navigationHistory: { back: 0, forward: 0, canGoBack: () => true, canGoForward: () => true, goBack() { this.back++; }, goForward() { this.forward++; } },
    loadURL: async function (url: string) { this.url = url; }, setWindowOpenHandler(handler: any) { (this as any).popup = handler; } });
  const view = { webContents: wc, visible: false, bounds: {} as any, setVisible(value: boolean) { this.visible = value; }, setBounds(rect: any) { this.bounds = rect; } };
  const frame = { url: 'http://localhost:5173/youtube' };
  const owner = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false, getZoomFactor: (): number => 1, send: () => { } });
  const attached: any[] = [];
  const win = { webContents: owner, isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }), contentView: { addChildView: (v: any) => attached.push(v), removeChildView: (v: any) => attached.splice(attached.indexOf(v), 1) } };
  const browser = new lib.YoutubeBrowser(win as any, () => view as any);
  return { lib, browser, wc, view, win, owner, frame, attached };
}
test('only fixed HTTPS YouTube and Google login origins are allowed; captures normalize single video links', async () => {
  const f = await fixture();
  for (const url of ['https://www.youtube.com/', 'https://accounts.google.com/ServiceLogin', 'https://consent.youtube.com/'])
    assert.equal(f.lib.allowedYoutubeNavigation(url), true);
  for (const url of ['http://www.youtube.com/', 'https://www.youtube.com.evil.test/', 'https://user:password@www.youtube.com/', 'https://www.youtube.com:444/', 'file:///tmp/index.html', 'https://evil.example/', 'javascript:alert(1)'])
    assert.equal(f.lib.allowedYoutubeNavigation(url), false);
  for (const url of [`https://www.youtube.com/watch?v=${id}&list=secret&si=tracking`, `https://youtu.be/${id}?t=30`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/live/${id}`, `https://www.youtube.com/embed/${id}`])
    assert.equal(f.lib.youtubeVideoUrl(url), `https://www.youtube.com/watch?v=${id}`);
  for (const url of ['https://www.youtube.com/results?search_query=test', 'https://www.youtube.com/@channel', 'https://evil.example/watch?v=' + id, 'https://www.youtube.com/watch?v=abc'])
    assert.equal(f.lib.youtubeVideoUrl(url), undefined);
  f.browser.dispose();
});
test('bounds lazily attach one view, clip to window, hide and mute; disposal closes only its remote contents', async () => {
  const f = await fixture();
  assert.equal(f.attached.length, 0);
  f.browser.setBounds({ x: 60, y: 140, width: 2000, height: 2000 });
  assert.deepEqual(f.view.bounds, { x: 60, y: 140, width: 940, height: 660 });
  assert.equal(f.attached.length, 1);
  assert.equal(f.view.visible, true);
  f.browser.setBounds(null);
  assert.equal(f.view.visible, false);
  assert.equal(f.wc.muted, true);
  assert.throws(() => f.browser.setBounds({ x: NaN, y: 0, width: 10, height: 10 }));
  f.browser.setBounds({ x: 60, y: 140, width: 800, height: 500 });
  assert.equal(f.attached.length, 1);
  assert.equal(f.wc.muted, false);
  f.owner.emit('did-start-loading');
  assert.equal(f.view.visible, false);
  f.browser.dispose();
  assert.equal(f.wc.closed, true);
  assert.equal(f.attached.length, 0);
});
test('search and history use native navigation; loading/errors and non-video pages refuse capture; SPA updates are captured', async () => {
  const f = await fixture();
  f.browser.setBounds({ x: 60, y: 140, width: 800, height: 500 });
  f.browser.command('search', 'AI 工具');
  assert.equal(f.wc.url, 'https://www.youtube.com/results?search_query=AI+%E5%B7%A5%E5%85%B7');
  assert.throws(() => f.browser.capture(), /视频/);
  f.browser.command('back');
  f.browser.command('forward');
  assert.equal(f.wc.navigationHistory.back, 1);
  assert.equal(f.wc.navigationHistory.forward, 1);
  f.wc.url = `https://www.youtube.com/watch?v=${id}&list=ignored`;
  f.wc.emit('did-navigate-in-page', {}, f.wc.url, true);
  assert.deepEqual(f.browser.capture(), { sourceUrl: `https://www.youtube.com/watch?v=${id}`, topic: 'Example' });
  f.wc.loading = true;
  assert.throws(() => f.browser.capture(), /加载/);
  f.wc.loading = false;
  f.wc.emit('did-fail-load', {}, -105, 'DNS failure', f.wc.url, true);
  assert.throws(() => f.browser.capture(), /失败|网络/);
  assert.equal(f.view.visible, false);
  f.browser.command('reload');
  f.wc.loading = false;
  f.wc.emit('did-finish-load');
  assert.equal(f.view.visible, true);
  f.browser.setBounds(null);
  assert.throws(() => f.browser.capture(), /打开/);
  f.browser.dispose();
});
test('remote top-level navigation and popups cannot escape allowed sites', async () => {
  const f = await fixture();
  f.browser.setBounds({ x: 60, y: 140, width: 800, height: 500 });
  let prevented = false;
  f.wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://evil.example/');
  assert.equal(prevented, true);
  assert.deepEqual((f.wc as any).popup({ url: 'file:///tmp/secret' }), { action: 'deny' });
  assert.deepEqual((f.wc as any).popup({ url: `https://www.youtube.com/watch?v=${id}` }), { action: 'deny' });
  assert.equal(f.wc.url, `https://www.youtube.com/watch?v=${id}`);
  assert.throws(() => f.browser.command('search', 'https://evil.example/'));
  assert.throws(() => f.browser.command('invented' as any));
  f.browser.dispose();
});
test('YouTube account redirects remain visible while lookalike domains are blocked', async () => {
  const f = await fixture();
  f.browser.setBounds({ x: 60, y: 140, width: 800, height: 500 });
  let prevented = false;
  const event = { preventDefault: () => { prevented = true; } };
  const loginUrl = 'https://accounts.youtube.com/accounts/SetSID?continue=https%3A%2F%2Fwww.youtube.com%2F';
  f.wc.emit('will-redirect', event, loginUrl, false, true);
  assert.equal(prevented, false);
  assert.equal(f.browser.getState().error, undefined);
  assert.equal(f.view.visible, true);
  f.wc.url = loginUrl;
  assert.equal(f.browser.getState().url, 'https://accounts.youtube.com/accounts/SetSID');
  assert.equal(f.browser.getState().videoUrl, undefined);
  f.wc.emit('will-redirect', event, 'https://accounts.youtube.com.evil.example/accounts/SetSID', false, true);
  assert.equal(prevented, true);
  assert.equal(f.view.visible, false);
  f.browser.dispose();
});
test('IPC only accepts the application window main frame and exact renderer origin; handlers are removed at disposal', async () => {
  const f = await fixture();
  const handlers = new Map<string, Function>();
  const dispose = f.lib.registerYoutubeBrowserHandlers({ handle: (name: string, fn: Function) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) } as any, f.win as any, f.browser, 'http://localhost:5173/');
  const event = { sender: f.owner, senderFrame: f.frame };
  const state = handlers.get('youtube-browser-state')!;
  assert.ok(state(event));
  assert.throws(() => state({ ...event, sender: {} }));
  assert.throws(() => state({ ...event, senderFrame: { url: f.frame.url } }));
  f.frame.url = 'https://www.youtube.com/';
  assert.throws(() => state(event));
  f.frame.url = 'http://localhost:5173/youtube';
  dispose();
  assert.equal(handlers.size, 0);
  f.browser.dispose();
});

test('file renderer IPC requires the exact application file; zoom bounds stay contained', async () => {
  const f = await fixture();
  const handlers = new Map<string, Function>();
  const dispose = f.lib.registerYoutubeBrowserHandlers({handle: (name: string, fn: Function) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name)} as any, f.win as any, f.browser, 'file:///app/dist-renderer/index.html');
  const state = handlers.get('youtube-browser-state')!;
  const event = {sender: f.owner, senderFrame: f.frame};
  f.frame.url = 'file:///app/dist-renderer/index.html#/youtube';
  assert.ok(state(event));
  for (const url of ['file:///tmp/index.html', 'https://www.youtube.com/', 'file:///app/dist-renderer/other.html']) {
    f.frame.url = url; assert.throws(() => state(event), /来源/);
  }
  f.owner.getZoomFactor = () => 1.25;
  f.browser.setBounds({x:60,y:140,width:800,height:500});
  assert.deepEqual(f.view.bounds, {x:75,y:175,width:925,height:625});
  f.wc.emit('did-fail-load', {}, -105, '', '', true);
  f.browser.command('back');
  assert.equal(f.view.visible, true);
  assert.equal(f.browser.getState().error, undefined);
  dispose();
});
