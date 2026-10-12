// Requires dev:renderer. All API/media responses are isolated; no real downloads or user data.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveToutiaoBrowser } from '../dist/lib/toutiao-browser.js';

const base = 'http://localhost:5173';
const target = resolveToutiaoBrowser({ repoRoot: process.cwd(), env: {}, allowSystemChrome: false }).target;
assert(target?.kind === 'executablePath', '项目隔离浏览器不可用');
const browser = await chromium.launch({ executablePath: target.path, headless: true });
const track = { key: 'netease:1', source: 'netease', trackId: '1', title: '隔离试听歌曲', artist: '测试歌手', url: 'https://music.163.com/song?id=1' };
const asset = { id: 'test-audio', kind: 'audio', filename: 'test.wav', originalName: track.title, bytes: 32044, createdAt: '2026-10-12T00:00:00Z', audioSource: { platform: 'netease', trackId: '1', title: track.title, url: track.url, previewOnly: false } };
const wav = Buffer.alloc(32044);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
try {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    let imported = false, audioReads = 0, releasePoll;
    const imports = [], errors = [], downloads = [];
    const pollGate = new Promise(resolve => { releasePoll = resolve; });
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => { window.electron = { getServerPort: async () => 5173, getConfig: async () => ({ aiKeys: [], app: { theme: 'light' } }) }; });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base && !['blob:', 'data:'].includes(url.protocol)) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = data => route.fulfill({ json: data });
      if (url.pathname === '/api/assets') {
        const audio = url.searchParams.get('kind') === 'audio';
        if (audio) audioReads++;
        return json({ assets: audio && imported ? [asset] : [] });
      }
      if (url.pathname === '/api/local-sessions/auto') return json({ session: { token: 'fixture', user: { id: 'fixture', name: '测试', role: 'admin' } } });
      if (url.pathname === '/api/online-audio/catalog') return json({ sources: [{ id: 'netease', name: '网易云音乐' }], boards: [{ id: 'hot', name: '热歌榜' }] });
      if (url.pathname === '/api/online-audio/boards') return json({ board: { items: [track], status: 'fresh' } });
      if (url.pathname === '/api/online-audio/preview') {
        assert.deepEqual(route.request().postDataJSON(), { trackKey: track.key });
        return json({ preview: { token: 'fixture', durationMs: 1000, previewOnly: false } });
      }
      if (url.pathname === '/api/online-audio/imports') {
        imports.push(route.request().postDataJSON());
        assert.deepEqual(imports.at(-1), { trackKeys: [track.key] });
        if (imports.length === 1) return route.fulfill({ status: 422, json: { code: 'online_audio_error', message: '隔离下载失败，请重试' } });
        return json({ batch: { id: 'test-batch', items: [{ id: 'test-item', track, status: 'queued' }] } });
      }
      if (url.pathname === '/api/online-audio/imports/test-batch') {
        await pollGate; imported = true;
        return json({ batch: { id: 'test-batch', items: [{ id: 'test-item', track, status: 'succeeded', assetId: asset.id }] } });
      }
      if (url.pathname.includes('/media/') || url.pathname.endsWith('/raw')) return route.fulfill({ contentType: 'audio/wav', body: wav });
      return json({});
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('download', download => downloads.push(download.suggestedFilename()));
    try {
      await page.goto(base + '/assets');
      await page.getByRole('button', { name: '在线音频', exact: true }).click();
      await page.getByRole('button', { name: `试听 ${track.title}`, exact: true }).click();
      const player = page.getByLabel(`正在试听 ${track.title}`, { exact: true });
      await player.waitFor();
      assert.equal(await player.getAttribute('controlslist'), 'nodownload');
      const preview = page.locator('div').filter({ has: player }).last();
      const download = preview.getByRole('button', { name: '下载到素材库', exact: true });
      await download.waitFor();
      // Clearing the search results must not lose the current preview's direct import action.
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      assert.equal(await page.getByRole('list', { name: '在线歌曲列表' }).count(), 0);
      await download.click();
      await page.getByRole('alert').filter({ hasText: '隔离下载失败，请重试' }).waitFor();
      assert.equal(await player.getAttribute('src'), base + '/api/online-audio/media/fixture');
      assert.equal(await download.isDisabled(), false);
      await download.click();
      const progress = preview.getByRole('button', { name: '下载中…', exact: true });
      await progress.waitFor();
      assert(await progress.isDisabled());
      assert.equal(await progress.getAttribute('aria-busy'), 'true');
      releasePoll();
      const done = preview.getByRole('button', { name: '已入库', exact: true });
      await done.waitFor(); assert(await done.isDisabled());
      await page.getByRole('heading', { name: /^音频 \(1\)$/ }).waitFor();
      assert.equal(await page.locator('audio').count(), 2);
      for (const audio of await page.locator('audio').all()) assert.equal(await audio.getAttribute('controlslist'), 'nodownload');
      assert(audioReads >= 2, '入库后应刷新素材列表');
      assert.equal(imports.length, 2); assert.deepEqual(downloads, []); assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}: direct preview import, retry, progress, asset refresh and no native download`);
    } finally { releasePoll(); await context.close(); }
  }
} finally { await browser.close(); }
