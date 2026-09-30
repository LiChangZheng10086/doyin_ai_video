/** Run after npm run build. Isolated storage and local AI fixture; never submits to platforms. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const fixture = spawn(process.execPath, ['--import', 'tsx', 'scripts/verify-image-prompt-assets.ts', '--serve'], { stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
try {
  const ready = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('fixture startup timeout')), 20000);
    fixture.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}`)); });
    fixture.stdout.on('data', chunk => { output += chunk; const line = output.split('\n').find(line => line.startsWith('{"url":')); if (line) { clearTimeout(timer); resolve(JSON.parse(line)); } });
  });
  const base = new URL(ready.url).origin;
  browser = await chromium.launch({ headless: true, ...(process.env.IMAGE_PROMPT_BROWSER_BINARY ? { executablePath: process.env.IMAGE_PROMPT_BROWSER_BINARY } : { channel: 'chrome' }) }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await page.goto(ready.url); await page.getByRole('button', { name: '图片提示词', exact: true }).click();
  const box = name => page.getByRole('textbox', { name, exact: true });
  const button = name => page.getByRole('button', { name, exact: true });
  await box('主题或文章').fill('海边日落测试'); await page.getByRole('combobox', { name: '用途', exact: true }).selectOption('body');
  await page.getByRole('combobox', { name: '比例', exact: true }).selectOption('9:16'); await box('视觉风格（可选，优化时留空沿用原文）').fill('水彩');
  await button('生成提示词').click(); assert.equal(await page.getByRole('combobox', { name: '比例', exact: true }).inputValue(), '9:16');
  await button('优化已有提示词').click(); assert.equal(await page.getByRole('combobox', { name: '比例', exact: true }).inputValue(), '');
  await button('生成提示词').click(); assert.equal(await box('视觉风格（可选，优化时留空沿用原文）').inputValue(), '水彩');
  await page.getByRole('combobox', { name: '生成数量' }).selectOption('2'); await button('生成并保存提示词').click(); await box('提示词标题').waitFor();
  await box('提示词标题').fill('双图验收'); await button('保存提示词修改').click(); await page.getByRole('status').filter({ hasText: '提示词已保存' }).waitFor();
  await button('复制提示词').click(); await page.getByRole('status').filter({ hasText: '已复制提示词' }).waitFor();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=', 'base64');
  await page.getByLabel('选择生成成功的图片', { exact: true }).setInputFiles([{ name: '帆船.png', mimeType: 'image/png', buffer: png }, { name: '雪山.png', mimeType: 'image/png', buffer: png }, { name: '错误.txt', mimeType: 'text/plain', buffer: Buffer.from('bad') }]);
  await box('第 1 张图片描述').fill('蓝色海水与帆船'); await box('第 2 张图片描述').fill('雪山上的小屋');
  await button('上传 3 张图片并入库').click(); await page.getByRole('status').filter({ hasText: '已入库 2 张；1 张未成功' }).waitFor();
  assert.equal(await box('第 2 张图片描述').count(), 0); await button('移除此文件').click();
  const auth = (await (await page.request.post(`${base}/api/local-sessions/auto`)).json()).session.token;
  const drafts = async () => (await (await page.request.get(`${base}/api/image-prompts`)).json()).prompts;
  await box('提示词标题').fill('冲突时保留此输入'); const draft = (await drafts()).find(item => item.title === '双图验收');
  await page.request.patch(`${base}/api/image-prompts/${draft.id}`, { headers: { 'X-Local-Session': auth }, data: { version: draft.version, title: '另一窗口修改' } });
  await button('保存提示词修改').click(); await page.getByRole('alert').filter({ hasText: '提示词已变更' }).waitFor(); assert.equal(await box('提示词标题').inputValue(), '冲突时保留此输入');
  await button('刷新草稿').click(); await button('核对后采用此版本号').click(); await button('保存提示词修改').click(); await page.getByRole('status').filter({ hasText: '提示词已保存' }).waitFor();
  // A GET captured before generation must never remove new records from the UI.
  let release; let captured; const gate = new Promise(resolve => { release = resolve; }); const capturedGate = new Promise(resolve => { captured = resolve; });
  await page.route('**/api/image-prompts', async route => { if (route.request().method() !== 'GET') return route.continue(); const response = await route.fetch(); captured(); await gate; await route.fulfill({ response }); });
  await button('刷新草稿').click(); await capturedGate; await page.getByRole('combobox', { name: '生成数量' }).selectOption('1');
  await button('生成并保存提示词').click(); await page.getByRole('status').filter({ hasText: '已生成并保存 1 条' }).waitFor(); release();
  await page.waitForTimeout(250); assert.equal(await page.getByRole('button', { name: / · v\d+$/ }).count(), (await drafts()).length); await page.unroute('**/api/image-prompts');
  // Simulate a lost response after the real service persisted its result.
  let posts = 0; await page.route('**/api/image-prompts', async route => { if (route.request().method() !== 'POST') return route.continue(); posts++; await route.fetch(); await route.abort(); });
  await button('生成并保存提示词').click(); await page.getByRole('alert').filter({ hasText: '请先刷新草稿核对' }).waitFor(); assert.equal(posts, 1);
  await page.unroute('**/api/image-prompts'); await button('刷新草稿').click();
  await button('图片提示词').click();
  await box('图片关键词').fill('雪山 小屋'); await button('搜索图片').click(); await page.getByText('显示 1 / 共 5 张', { exact: false }).waitFor();
  await button('全部图片').click(); await page.getByText('显示 5 / 共 5 张', { exact: false }).waitFor();
  await page.getByRole('combobox', { name: '界面主题' }).selectOption({ label: '浅色' });
  await mkdir('output/playwright', { recursive: true }); await page.screenshot({ path: 'output/playwright/image-prompt-assets-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await button('图片提示词').click(); await page.screenshot({ path: 'output/playwright/image-prompt-assets-mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile overflow');
  await page.goto(ready.article); await button('创建公众号文章包').click(); const modal = page.getByRole('dialog');
  await modal.getByRole('textbox', { name: /^正文/ }).fill('用户编辑正文：搜索和生成提示词不得覆盖。'); await modal.getByRole('radio', { name: '从素材库选' }).check();
  await modal.getByRole('button', { name: '选择封面 帆船.png', exact: true }).click(); await modal.getByRole('button', { name: '雪山.png', exact: true }).click(); await modal.getByRole('button', { name: '帆船.png', exact: true }).click();
  await modal.getByRole('textbox', { name: '图片关键词' }).fill('不匹配任何素材'); await modal.getByRole('button', { name: '搜索图片' }).click(); await modal.getByText('候选 0 / 共 5 张', { exact: false }).waitFor();
  assert.equal(await modal.getByText('已选封面：帆船.png', { exact: true }).count(), 1);
  const list = await modal.getByRole('list').first().innerText(); assert.ok(list.indexOf('雪山.png') < list.indexOf('帆船.png'));
  await modal.getByRole('button', { name: '图片提示词', exact: true }).click(); assert.equal(await modal.getByRole('combobox', { name: '比例', exact: true }).inputValue(), '2.35:1');
  await modal.getByRole('button', { name: '生成并保存提示词' }).click(); await modal.getByRole('textbox', { name: '最终提示词', exact: true }).waitFor();
  await modal.getByRole('button', { name: '返回文章选图' }).click(); assert.equal(await modal.getByRole('textbox', { name: /^正文/ }).inputValue(), '用户编辑正文：搜索和生成提示词不得覆盖。');
  await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')));
  await page.screenshot({ path: 'output/playwright/image-prompt-article-selection.png', fullPage: true });
  await page.keyboard.press('Escape'); await modal.waitFor({ state: 'hidden' });
  console.log('Image prompt UI acceptance passed: settings, partial upload, conflicts, stale responses, lost responses, search, mobile, article selections, Tab/Esc.');
} finally {
  await browser?.close(); const stopped = once(fixture, 'exit'); fixture.kill('SIGTERM'); await stopped;
}
