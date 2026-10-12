// Run with npm run dev:renderer active. Isolated browser and API fixtures; no real data or publishing.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveToutiaoBrowser } from '../dist/lib/toutiao-browser.js';

const base = 'http://localhost:5173';
const target = resolveToutiaoBrowser({ repoRoot: process.cwd(), env: {}, allowSystemChrome: false }).target;
assert(target?.kind === 'executablePath', '项目隔离浏览器不可用');
const browser = await chromium.launch({ executablePath: target.path, headless: true });
let gallery, failure, release, requested, previewCalls, saveCalls, saveFailure, packageFailure, packageRelease, packageRequested;
const failures = [], packageRequests = [], renderRequests = [];
const image = { mainTime: 1, times: [1], bandTop: .8, bandBottom: .9, mainFraction: .5 };
const preview = { previewRevision: 'fixture', imageCount: 42, violations: [], copyLimits: { titleMax: 20, descriptionMax: 1000, hashtagMax: 10 } };
try {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    gallery = { id: 'preview-fixture', sourceJobId: 'fixture-job', version: 1, title: '测试标题', description: '测试正文', hashtags: [], status: 'draft', images: [image], createdAt: '', updatedAt: '', copyReference: { notes: Array(30).fill('隔离测试核对说明'), transcriptHash: 'fixture', sourceFingerprint: 'fixture' } };
    gallery.plan = { id: 'plan-fixture', sourceFingerprint: 'fixture', transcriptHash: 'fixture', scope: 'full', coverage: { start: 0, end: 5, duration: 5, totalSegments: 1, selectedSegments: 1 }, warnings: [], excluded: [], images: Array.from({ length: 42 }, (_, i) => ({ title: `测试图片${i + 1}`, image, quotes: [{ segmentIndex: 0, text: `候选字幕${i + 1}`, start: 0, end: 2 }] })) };
    previewCalls = 0; saveCalls = 0; saveFailure = ''; failure = '请先保存并重新生成整套图集';
    packageFailure = '图集图片已变化，请重新生成并预览';
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => { window.electron = { getServerPort: async () => 5173, getConfig: async () => ({ aiKeys: [], app: { theme: 'light' } }) }; });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base && !['blob:', 'data:'].includes(url.protocol)) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = async data => route.fulfill({ json: data });
      if (/\/render$/.test(url.pathname)) { renderRequests.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/publishing/packages') return json({ packages: [] });
      if (url.pathname.endsWith('/publishing/packages')) {
        packageRequests.push(url.pathname);
        assert.deepEqual(route.request().postDataJSON(), { previewRevision: 'fixture', rightsConfirmed: true });
        packageRequested?.();
        if (packageRelease) await new Promise(resolve => { packageRelease = resolve; });
        return packageFailure ? route.fulfill({ status: 409, json: { code: 'gallery_invalid', message: packageFailure } }) : json({ detail: { package: { id: 'isolated-package' }, tasks: [] } });
      }
      if (url.pathname.endsWith('/publishing/preview')) {
        previewCalls++; requested?.();
        assert.equal(route.request().postDataJSON().version, gallery.version);
        if (release) await new Promise(resolve => { release = resolve; });
        return failure ? route.fulfill({ status: 409, json: { code: 'gallery_invalid', message: failure } }) : json({ preview: { ...preview, bgm: gallery.bgm } });
      }
      if (url.pathname === '/api/galleries/preview-fixture') {
        if (route.request().method() === 'PATCH') {
          saveCalls++;
          if (saveFailure) return route.fulfill({ status: 409, json: { code: 'gallery_invalid', message: saveFailure } });
          gallery = { ...gallery, ...route.request().postDataJSON(), version: gallery.version + 1 };
        }
        return json({ gallery });
      }
      if (url.pathname.includes('/plan/images/')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH2UAAAAASUVORK5CYII=', 'base64') });
      if (url.pathname.endsWith('/source')) return json({ source: { width: 320, height: 480, duration: 5, copyLimits: preview.copyLimits } });
      if (url.pathname.endsWith('/raw-transcript')) return json({ transcript: '原句', segments: [{ start: 0, end: 2, text: '原句' }] });
      if (url.pathname === '/api/local-sessions/auto') return json({ session: { token: 'fixture', user: { id: 'fixture', name: '测试', role: 'admin' } } });
      return json({});
    });
    const page = await context.newPage();
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(base + '/galleries/preview-fixture');
    const candidates = page.locator('details[aria-label="候选图片与字幕"]');
    await candidates.waitFor({ timeout: 3000 });
    assert(await candidates.evaluate(el => el.open));
    const confirmed = page.getByRole('checkbox', { name: '我已核对整套候选字幕，认可图片数量与内容安排。', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('label')].find(el => el.textContent?.includes('我已核对整套候选字幕'))?.querySelector('input')?.disabled === false);
    await confirmed.check();
    await candidates.locator('summary').click();
    assert.equal(await candidates.evaluate(el => el.open), false);
    assert.equal(await candidates.locator('img').count(), 42);
    assert.equal(await candidates.locator('img').first().isVisible(), false);
    assert(await confirmed.isChecked());
    assert.equal(await page.getByRole('button', { name: '按此方案生成整套图集', exact: true }).isDisabled(), false);
    await candidates.locator('summary').click();
    assert(await candidates.locator('img').first().isVisible());
    await candidates.locator('summary').click();
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

    const saveButtons = page.getByRole('button', { name: /^保存草稿/ });
    assert.equal(await saveButtons.count(), 2);
    await page.getByLabel(/^标题 ·/).fill('底部保存的标题');
    await saveButtons.last().click();
    await copySection.getByRole('status').filter({ hasText: '创作草稿已保存' }).waitFor();
    assert.equal(gallery.title, '底部保存的标题'); assert.equal(saveCalls, 2);
    await page.getByLabel(/^标题 ·/).fill('失败后保留的标题');
    saveFailure = '草稿版本已变化，请刷新后重试';
    await saveButtons.last().click(); await alert.waitFor();
    assert.match(await alert.innerText(), /草稿版本已变化/);
    assert.equal(await page.getByLabel(/^标题 ·/).inputValue(), '失败后保留的标题');
    assert.equal(gallery.title, '底部保存的标题');
    saveFailure = ''; await saveButtons.last().click();
    await copySection.getByRole('status').filter({ hasText: '创作草稿已保存' }).waitFor();
    assert.equal(gallery.title, '失败后保留的标题'); assert.equal(saveCalls, 4);
    await saveButtons.first().scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() => scrollY);
    await saveButtons.first().click();
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].filter(el => el.textContent === '创作草稿已保存').length === 2);
    assert(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) < 100, '顶部保存不应滚到页面底部');
    await button.click();
    const rights = page.getByRole('checkbox', { name: /我已逐张核对原生字幕/ });
    await rights.check();
    const music = page.getByLabel('背景音乐（抖音音乐名称）', { exact: true });
    assert.equal(await music.getAttribute('maxlength'), '120');
    assert.equal(await music.inputValue(), '');
    await copySection.getByText('背景音乐：未指定配乐', { exact: true }).waitFor();
    const unchangedImages = JSON.stringify(gallery.images), unchangedPlan = JSON.stringify(gallery.plan);
    await music.fill('Whatever Happens');
    assert.equal(await rights.count(), 0);
    assert.equal(await copySection.getByText('背景音乐：未指定配乐', { exact: true }).count(), 0);
    await button.click();
    await copySection.getByText('背景音乐：Whatever Happens', { exact: true }).waitFor();
    assert.equal(gallery.bgm, 'Whatever Happens');
    assert.equal(JSON.stringify(gallery.images), unchangedImages);
    assert.equal(JSON.stringify(gallery.plan), unchangedPlan);
    assert.deepEqual(renderRequests, []);
    await rights.check();
    await music.fill('');
    assert.equal(await rights.count(), 0);
    await button.click();
    await copySection.getByText('背景音乐：未指定配乐', { exact: true }).waitFor();
    assert.equal(gallery.bgm, '');
    assert.deepEqual(renderRequests, []);
    await rights.check();
    const packageButton = page.getByRole('button', { name: '创建抖音图文发布包', exact: true });
    await packageButton.click();
    await alert.waitFor();
    assert.match(await alert.innerText(), /图集图片已变化/);
    assert(await rights.isChecked());
    assert.equal(await packageButton.isEnabled(), true);
    await page.getByLabel(/^标题 ·/).fill('建包失败后修改标题');
    assert.equal(await alert.count(), 0);
    assert.equal(await packageButton.count(), 0);
    await button.click(); await rights.check();
    packageFailure = ''; packageRelease = true;
    const packageSeen = new Promise(resolve => { packageRequested = resolve; });
    await packageButton.click(); await packageSeen;
    const packageBusy = page.getByRole('button', { name: '创建发布包中…', exact: true });
    await packageBusy.waitFor(); assert(await packageBusy.isDisabled()); assert.equal(await packageBusy.getAttribute('aria-busy'), 'true');
    packageRelease(); packageRelease = undefined; packageRequested = undefined;
    await page.waitForURL(base + '/publishing?channel=douyin&contentType=note&status=all');
    await context.close();
  }
  assert.deepEqual(failures, []); assert.equal(packageRequests.length, 4); assert.deepEqual(renderRequests, []);
  console.log('PASS: desktop/mobile candidate collapse, bottom/top save, conflicts, preview; music save/clear invalidates preview without rendering; local package errors/progress/retry/navigation. All API calls mocked; no real data or platform publishing.');
} finally { await browser.close(); }
