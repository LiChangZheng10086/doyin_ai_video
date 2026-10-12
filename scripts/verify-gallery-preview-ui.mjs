// Run with npm run dev:renderer active. Isolated browser and API fixtures; no real data or publishing.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveToutiaoBrowser } from '../dist/lib/toutiao-browser.js';

const base = 'http://localhost:5173';
const target = resolveToutiaoBrowser({ repoRoot: process.cwd(), env: {}, allowSystemChrome: false }).target;
assert(target?.kind === 'executablePath', '项目隔离浏览器不可用');
const browser = await chromium.launch({ executablePath: target.path, headless: true });
let gallery, failure, release, requested, previewCalls, saveCalls;
const failures = [], packageRequests = [];
const image = { mainTime: 1, times: [1], bandTop: .8, bandBottom: .9, mainFraction: .5 };
const preview = { previewRevision: 'fixture', imageCount: 1, violations: [], copyLimits: { titleMax: 20, descriptionMax: 1000, hashtagMax: 10 } };
try {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    gallery = { id: 'preview-fixture', sourceJobId: 'fixture-job', version: 1, title: '测试标题', description: '测试正文', hashtags: [], status: 'draft', images: [image], createdAt: '', updatedAt: '', copyReference: { notes: Array(30).fill('隔离测试核对说明'), transcriptHash: 'fixture', sourceFingerprint: 'fixture' } };
    previewCalls = 0; saveCalls = 0; failure = '请先保存并重新生成整套图集';
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => { window.electron = { getServerPort: async () => 5173, getConfig: async () => ({ aiKeys: [], app: { theme: 'light' } }) }; });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base && !['blob:', 'data:'].includes(url.protocol)) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = async data => route.fulfill({ json: data });
      if (url.pathname.endsWith('/publishing/packages')) { packageRequests.push(url.pathname); return json({}); }
      if (url.pathname.endsWith('/publishing/preview')) {
        previewCalls++; requested?.();
        assert.equal(route.request().postDataJSON().version, gallery.version);
        if (release) await new Promise(resolve => { release = resolve; });
        return failure ? route.fulfill({ status: 409, json: { code: 'gallery_invalid', message: failure } }) : json({ preview });
      }
      if (url.pathname === '/api/galleries/preview-fixture') {
        if (route.request().method() === 'PATCH') { saveCalls++; gallery = { ...gallery, ...route.request().postDataJSON(), version: gallery.version + 1 }; }
        return json({ gallery });
      }
      if (url.pathname.endsWith('/source')) return json({ source: { width: 320, height: 480, duration: 5, copyLimits: preview.copyLimits } });
      if (url.pathname.endsWith('/raw-transcript')) return json({ transcript: '原句', segments: [{ start: 0, end: 2, text: '原句' }] });
      if (url.pathname === '/api/local-sessions/auto') return json({ session: { token: 'fixture', user: { id: 'fixture', name: '测试', role: 'admin' } } });
      return json({});
    });
    const page = await context.newPage();
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(base + '/galleries/preview-fixture');
    const button = page.getByRole('button', { name: '检查发布预览', exact: true });
    await button.click();
    const copySection = page.locator('section').filter({ has: page.getByRole('heading', { name: '抖音图文文案', exact: true }) });
    const alert = copySection.getByRole('alert');
    await alert.waitFor({ timeout: 3000 });
    assert.match(await alert.innerText(), /请先保存并重新生成整套图集/);
    await page.waitForFunction(() => { const alert = [...document.querySelectorAll('section')].find(s => s.querySelector('h2')?.textContent === '抖音图文文案')?.querySelector('[role="alert"]'); const r = alert?.getBoundingClientRect(); return r && r.top >= 0 && r.bottom <= innerHeight; });
    assert.equal(previewCalls, 1);

    failure = ''; release = true;
    const requestSeen = new Promise(resolve => { requested = resolve; });
    await button.click(); await requestSeen;
    const busy = page.getByRole('button', { name: '预览检查中…', exact: true });
    await busy.waitFor(); assert(await busy.isDisabled()); assert.equal(await busy.getAttribute('aria-busy'), 'true');
    release(); release = undefined; requested = undefined;
    await copySection.getByRole('status').filter({ hasText: '发布预览检查完成' }).waitFor();
    assert.equal(await alert.count(), 0);
    assert(await page.getByRole('button', { name: '创建抖音图文发布包', exact: true }).isDisabled());

    failure = '转录已变化，请重新规划并生成图集';
    await button.click(); await alert.waitFor();
    assert.match(await alert.innerText(), /转录已变化/);
    assert.equal(await page.getByRole('button', { name: '创建抖音图文发布包', exact: true }).count(), 0);
    await page.getByLabel(/^标题 ·/).fill('修改后的标题');
    assert.equal(await alert.count(), 0);
    failure = ''; await button.click();
    await copySection.getByRole('status').filter({ hasText: '发布预览检查完成' }).waitFor();
    assert.equal(saveCalls, 1); assert.equal(previewCalls, 4);
    await context.close();
  }
  assert.deepEqual(failures, []); assert.deepEqual(packageRequests, []);
  console.log('PASS: desktop/mobile local errors, visible feedback, busy/duplicate prevention, successful preview, stale preview removal, copy autosave/version, no publishing.');
} finally { await browser.close(); }
