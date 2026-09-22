#!/usr/bin/env node
/**
 * UI 设计探针（只读）。
 *
 * 做两件事：
 *   ① 打开设计夹具（`/design.html`，真实组件 + mock 数据），对有数据状态做视觉回归截图；
 *   ② 对**全部页面 + 夹具**跑一组可断言的硬指标：
 *        · 可点击按钮的 computed cursor 必须是 pointer
 *        · 文字对比度 ≥4.5:1（大字/图形 ≥3:1）
 *        · 可交互控件的边框对比度 ≥3:1（WCAG 1.4.11）
 *        · 正文折行的每行字数 ≤75（中文一个字≈1em）
 *
 * 为什么需要它：这个应用的数据全在后端，后端没起来时每个页面都是空态，
 * 「有数据时是否好看、是否可读」在真机上根本无从检查。夹具补上了这一块。
 *
 * 用法：
 *   npm run dev:renderer            # 另开一个终端
 *   node scripts/probe-ui-design.mjs [--shots-dir /tmp/ui-shots]
 *
 * 零副作用：只读页面、只往 --shots-dir 写图（默认系统临时目录）。
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.UI_PROBE_BASE ?? 'http://localhost:5173';
const shotsArg = process.argv.indexOf('--shots-dir');
const SHOTS = shotsArg >= 0 ? process.argv[shotsArg + 1] : path.join(tmpdir(), 'dsh-ui-shots');

const PLAYWRIGHT_BROWSERS = path.join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');

/** 找一份可用的 headless 浏览器：优先 Playwright 缓存（版本号不定），再退回系统 Chrome。 */
async function resolveBrowser() {
  const { readdir } = await import('node:fs/promises');
  try {
    const entries = await readdir(PLAYWRIGHT_BROWSERS);
    const shell = entries
      .filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort()
      .pop();
    if (shell) {
      const candidate = path.join(
        PLAYWRIGHT_BROWSERS,
        shell,
        'chrome-headless-shell-mac-arm64',
        'chrome-headless-shell',
      );
      const { access } = await import('node:fs/promises');
      await access(candidate);
      return candidate;
    }
  } catch {
    /* 继续往下找 */
  }
  return undefined; // 交给 Playwright 自己解析
}

const PAGES = [
  ['design', '/design.html'],
  ['jobs', '/'],
  ['collections', '/collections'],
  ['skills', '/skills'],
  ['assets', '/assets'],
  ['publishing', '/publishing'],
  ['trash', '/trash'],
  ['settings', '/settings'],
];

const MEASURE = `(() => {
  const lum = (rgb) => { const [r,g,b] = rgb.map(v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }); return 0.2126*r+0.7152*g+0.0722*b; };
  const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: p.slice(0,3), a: p.length>3 ? p[3] : 1 }; };
  const ratio = (f,b) => { const l1 = lum(f), l2 = lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
  const effBg = (el) => { let n = el; while (n && n !== document.documentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.95) return c.rgb; n = n.parentElement; } return [13,15,18]; };
  const vis = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display!=='none' && cs.visibility!=='hidden' && r.width>0 && r.height>0; };

  const buttons = [...document.querySelectorAll('button')].filter(vis);
  const notPointer = buttons.filter(b => !b.disabled && getComputedStyle(b).cursor !== 'pointer').length;

  const controls = [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select')].filter(vis);
  const weakBorder = [];
  for (const el of controls) {
    const cs = getComputedStyle(el);
    if (!Math.max(parseFloat(cs.borderTopWidth), parseFloat(cs.borderBottomWidth))) continue;
    const bc = parse(cs.borderTopColor); if (!bc) continue;
    const r = ratio(bc.rgb, effBg(el));
    if (r < 3) weakBorder.push({ tag: el.tagName, r: +r.toFixed(2) });
  }

  const lowText = []; const seen = new Set();
  document.querySelectorAll('*').forEach(el => {
    if (!el.textContent || !el.textContent.trim()) return;
    if ([...el.children].some(c => c.textContent && c.textContent.trim())) return;
    const cs = getComputedStyle(el);
    if (!vis(el) || parseFloat(cs.opacity) < 0.9) return;
    const color = parse(cs.color); if (!color) return;
    const size = parseFloat(cs.fontSize);
    const need = (size >= 18.66 || (size >= 14 && parseInt(cs.fontWeight) >= 700)) ? 3 : 4.5;
    const r = ratio(color.rgb, effBg(el));
    if (r >= need) return;
    const key = cs.color + '|' + size;
    if (seen.has(key)) return; seen.add(key);
    lowText.push({ text: el.textContent.trim().slice(0, 20), r: +r.toFixed(2), need, size });
  });

  const overLong = [];
  document.querySelectorAll('p, li, dd').forEach(el => {
    if (!vis(el)) return;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize) || 14;
    const lh = parseFloat(cs.lineHeight) || size * 1.5;
    const chars = [...(el.textContent || '').trim()].length;
    const lines = Math.max(1, Math.round(el.getBoundingClientRect().height / lh));
    if (lines < 2) return;                       // 单行的块谈不上一行多少字
    const perLine = Math.round(chars / lines);
    if (perLine > 75) overLong.push({ perLine, lines, text: (el.textContent||'').trim().slice(0, 18) });
  });

  return {
    buttons: buttons.length,
    buttonsNotPointer: notPointer,
    controls: controls.length,
    weakBorder: weakBorder.length, weakBorderSample: weakBorder.slice(0, 3),
    lowText: lowText.length, lowTextSample: lowText.slice(0, 4),
    overLong: overLong.length, overLongSample: overLong.slice(0, 3),
  };
})()`;

const executablePath = await resolveBrowser();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let reachable = true;
try {
  const probe = await browser.newPage();
  const res = await probe.goto(BASE + '/design.html', { waitUntil: 'load', timeout: 5000 });
  reachable = Boolean(res);
  await probe.close();
} catch {
  reachable = false;
}

if (!reachable) {
  console.error(`  ✗ 连不上 ${BASE}。请先在另一个终端运行： npm run dev:renderer`);
  await browser.close();
  process.exit(2);
}

await mkdir(SHOTS, { recursive: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
const rows = [];

for (const [name, route] of PAGES) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
  try {
    await page.goto(BASE + route, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(route === '/design.html' ? 1200 : 900);
    const shot = path.join(SHOTS, `${name}.png`);
    await page.screenshot({ path: shot, fullPage: route === '/design.html' });
    const m = await page.evaluate(MEASURE);
    rows.push({ name, ...m, pageErrors: errors.length });
  } catch (error) {
    rows.push({ name, error: error.message.slice(0, 80) });
  }
  await page.close();
}

await browser.close();

console.log('\n  UI 设计探针（只读）\n');
console.log(`  ${'页面'.padEnd(12)}${'按钮'.padStart(5)}${'非手型'.padStart(7)}${'控件'.padStart(5)}${'弱边框'.padStart(7)}${'低对比'.padStart(7)}${'超长行'.padStart(7)}${'JS错'.padStart(6)}`);
let totals = { notPointer: 0, weakBorder: 0, lowText: 0, overLong: 0, pageErrors: 0 };
for (const row of rows) {
  if (row.error) { console.log(`  ${row.name.padEnd(12)}  ERROR ${row.error}`); continue; }
  totals.notPointer += row.buttonsNotPointer;
  totals.weakBorder += row.weakBorder;
  totals.lowText += row.lowText;
  totals.overLong += row.overLong;
  totals.pageErrors += row.pageErrors;
  console.log(
    `  ${row.name.padEnd(12)}${String(row.buttons).padStart(5)}${String(row.buttonsNotPointer).padStart(7)}` +
    `${String(row.controls).padStart(5)}${String(row.weakBorder).padStart(7)}${String(row.lowText).padStart(7)}` +
    `${String(row.overLong).padStart(7)}${String(row.pageErrors).padStart(6)}`,
  );
}

console.log(`\n  合计：非手型光标 ${totals.notPointer} ｜ 控件弱边框 ${totals.weakBorder} ｜ 低对比文本 ${totals.lowText} ｜ 超长行 ${totals.overLong} ｜ 页面 JS 错误 ${totals.pageErrors}`);
for (const row of rows) {
  for (const item of row.lowTextSample ?? []) console.log(`    [${row.name}] 低对比 「${item.text}」 ${item.r}:1 需 ${item.need}（${item.size}px）`);
  for (const item of row.weakBorderSample ?? []) console.log(`    [${row.name}] 弱边框 <${item.tag}> ${item.r}:1`);
  for (const item of row.overLongSample ?? []) console.log(`    [${row.name}] 超长行 ${item.perLine} 字/行 × ${item.lines} 行 「${item.text}」`);
}

const failed = totals.notPointer + totals.weakBorder + totals.lowText + totals.overLong + totals.pageErrors;
console.log(`\n  ${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项不达标`}`);
console.log(`  截图：${SHOTS}\n`);
await writeFile(
  path.join(SHOTS, 'report.json'),
  JSON.stringify({ base: BASE, rows, totals }, null, 2),
);
process.exit(failed === 0 ? 0 : 1);
