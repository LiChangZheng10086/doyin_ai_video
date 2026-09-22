#!/usr/bin/env node
/**
 * 设计令牌迁移 · 第二阶段：过渡期别名与表单控件。
 *
 * 三件事：
 * 1. bg-white（71 处）→ bg-panel：改造前用字面白当卡片底，令牌里本来就有 surface。
 * 2. hover:bg-tech-bg（48 处）→ hover:bg-elevated：深色下 hover 必须**变亮**，
 *    沿用「bg-tech-bg = 画布色」会让 hover 比卡片更暗、读起来像按下去了。
 * 3. 表单控件边框 → border-line-ui：`--color-tech-border` 现在指向装饰线
 *    （1.23:1，与深色 UI 惯例一致），但**输入框边界属于 WCAG 1.4.11 覆盖范围**，
 *    必须 ≥3:1。判定方式：同一 className 里同时出现 outline-none 与边框 ——
 *    全仓只有表单控件这么写。
 *
 * 用法： node scripts/migrate-design-tokens-phase2.mjs [--apply]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(import.meta.dirname, '..', 'renderer', 'src');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const stats = { white: 0, hover: 0, surface: 0, control: 0, controlBg: 0 };
const samples = [];
let touched = 0;

for (const file of await walk(ROOT)) {
  const original = await readFile(file, 'utf8');
  let next = original;

  // 只在该 className 内部做控件升级，避免误伤卡片
  next = next.replace(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g, (whole, dq, tpl) => {
    const body = dq ?? tpl ?? '';
    const isControl = /\boutline-none\b/.test(body) && /\bborder\b/.test(body);
    if (!isControl) return whole;
    let patched = body;
    const before = patched;
    patched = patched.replace(/\bborder-tech-border\b/g, 'border-line-ui');
    // 输入框应该有「凹陷」感：底色比面板更深
    patched = patched.replace(/\bbg-tech-bg\b/g, 'bg-well').replace(/\bbg-tech-surface\b/g, 'bg-well');
    if (patched !== before) {
      stats.control += 1;
      if (/\bborder-tech-border\b/.test(before)) stats.controlBg += 1;
      if (samples.length < 4) samples.push(`${path.relative(ROOT, file)}\n      ${patched.slice(0, 150)}`);
    }
    return dq !== undefined ? `className="${patched}"` : `className={\`${patched}\`}`;
  });

  // 共享样式常量（如 SettingsPage 的 `const inputClassName = '…'`）不走 className 属性，
  // 上面的正则抓不到，会让一整组输入框漏掉。这里按「同时含 outline-none 与边框」认它。
  next = next.replace(/'([^'\n]*)'|"([^"\n]*)"/g, (whole, sq, dq) => {
    const body = sq ?? dq ?? '';
    if (!/\boutline-none\b/.test(body) || !/\bborder\b/.test(body)) return whole;
    const patched = body
      .replace(/\bborder-tech-border\b/g, 'border-line-ui')
      .replace(/\bbg-tech-bg\b/g, 'bg-well')
      .replace(/\bbg-tech-surface\b/g, 'bg-well');
    if (patched === body) return whole;
    stats.control += 1;
    if (/\bborder-tech-border\b/.test(body)) stats.controlBg += 1;
    if (samples.length < 6) samples.push(`${path.relative(ROOT, file)}（共享常量）\n      ${patched.slice(0, 140)}`);
    return sq !== undefined ? `'${patched}'` : `"${patched}"`;
  });

  const cWhite = (next.match(/\bbg-white\b/g) ?? []).length;
  stats.white += cWhite;
  next = next.replace(/\bbg-white\b/g, 'bg-panel');

  const cHover = (next.match(/\bhover:bg-tech-bg\b/g) ?? []).length;
  stats.hover += cHover;
  next = next.replace(/\bhover:bg-tech-bg\b/g, 'hover:bg-elevated');

  const cSurface = (next.match(/\bbg-tech-surface\b/g) ?? []).length;
  stats.surface += cSurface;
  next = next.replace(/\bbg-tech-surface\b/g, 'bg-panel');

  if (next !== original) {
    touched += 1;
    if (APPLY) await writeFile(file, next);
  }
}

console.log(`  ${APPLY ? '已应用' : '预演'}：涉及 ${touched} 个文件`);
console.log(`    bg-white → bg-panel            ${stats.white}`);
console.log(`    hover:bg-tech-bg → elevated    ${stats.hover}`);
console.log(`    bg-tech-surface → bg-panel     ${stats.surface}`);
console.log(`    表单控件 className 升级        ${stats.control}（其中含边框的 ${stats.controlBg}）`);
if (samples.length) {
  console.log('\n  控件改动抽样：');
  for (const s of samples) console.log(`    · ${s}`);
}
if (!APPLY) console.log('\n  （预演模式，未写入。加 --apply 生效）');
