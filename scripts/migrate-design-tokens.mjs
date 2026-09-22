#!/usr/bin/env node
/**
 * 设计令牌迁移：把原生调色板类（bg-red-50 / text-emerald-700 …）映射到语义令牌。
 *
 * 背景：改造前全仓有 532 处直接使用 Tailwind 原生调色板，而令牌里**没有**语义状态色，
 * 所以每个页面自己挑色阶 —— 同一个「危险」有 4 套红，缺图的包还会因为兜底分支
 * 显示成绿色。本脚本把它们收敛到 --color-{success,warning,danger,info,running,ai} 家族。
 *
 * 用法： node scripts/migrate-design-tokens.mjs [--apply]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(import.meta.dirname, '..', 'renderer', 'src');

/** 每个色相 → 目标语义令牌；按「色阶角色」分三类。 */
const TONES = {
  red: 'danger',
  emerald: 'success',
  green: 'success',
  amber: 'warning',
  orange: 'warning',
  blue: 'info',
  cyan: 'running',
  purple: 'ai',
  gray: 'neutral',
};

/** 中性色的落点（不是状态色，走分层底） */
const NEUTRAL = {
  '50': 'elevated',
  '100': 'elevated',
  '200': 'line-strong',
  '300': 'line-ui',
  '400': 'ink-subtle',
  '500': 'ink-muted',
  '600': 'ink-muted',
  '700': 'ink-muted',
  '800': 'ink-muted',
  '900': 'ink',
};

/** 色阶 → 角色：50/100 是 soft 底，200~400 是描边/图标，500+ 是实心 */
function roleFor(shade) {
  const n = Number(shade);
  if (n <= 100) return 'soft';
  if (n <= 400) return 'line';
  return 'solid';
}

const PREFIXES = ['bg', 'text', 'border', 'ring', 'from', 'to', 'via', 'divide', 'fill', 'stroke', 'outline', 'decoration', 'accent', 'placeholder', 'caret'];

function target(prefix, hue, shade) {
  const tone = TONES[hue];
  if (tone === 'neutral') {
    const n = NEUTRAL[shade];
    if (!n) return null;
    if (prefix === 'text' || prefix === 'placeholder') return `text-${n}`;
    if (prefix === 'border' || prefix === 'divide') return `border-${n}`;
    if (prefix === 'bg' || prefix === 'fill') return `bg-${n}`;
    return null;
  }
  const role = roleFor(shade);
  if (role === 'soft') {
    // soft 底：bg/from/to 用它；文字压 soft 直接用状态色（已验证 ≥4.5）
    if (prefix === 'bg' || prefix === 'fill' || prefix === 'from' || prefix === 'to' || prefix === 'via') {
      return `${prefix === 'fill' ? 'bg' : prefix}-${tone}-soft`;
    }
    return `text-${tone}`;
  }
  if (role === 'line') {
    // 描边/图标类：文字用状态色本身，边框用 -line
    if (prefix === 'border' || prefix === 'divide') return `border-${tone}-line`;
    return `text-${tone}`;
  }
  // solid：实心底
  if (prefix === 'bg' || prefix === 'fill' || prefix === 'from' || prefix === 'to') return `bg-${tone}`;
  if (prefix === 'border' || prefix === 'divide') return `border-${tone}-line`;
  return `text-${tone}`;
}

/** 额外的手工映射（渐变色、焦点环等，自动规则覆盖不到的） */
const MANUAL = [
  // ring-blue-100 对白底只有 1.22:1，本来就不是可见的焦点环；改为强调色
  [/\bring-blue-100\b/g, 'ring-accent'],
  // 侧栏/选中态的蓝底（无边框，只有底色）
  [/\bbg-blue-50\b/g, 'bg-info-soft'],
];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const counts = new Map();
let touched = 0;

for (const file of await walk(ROOT)) {
  const original = await readFile(file, 'utf8');
  let next = original;

  for (const [pattern, replacement] of MANUAL) {
    const hits = next.match(pattern);
    if (hits) {
      counts.set(`${pattern.source} → ${replacement}`, (counts.get(`${pattern.source} → ${replacement}`) ?? 0) + hits.length);
      next = next.replace(pattern, replacement);
    }
  }

  const re = new RegExp(`\\b(${PREFIXES.join('|')})-(${Object.keys(TONES).join('|')})-(\\d{2,3})\\b`, 'g');
  next = next.replace(re, (whole, prefix, hue, shade) => {
    const to = target(prefix, hue, shade);
    if (!to) return whole;
    const key = `${whole} → ${to}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return to;
  });

  if (next !== original) {
    touched += 1;
    if (APPLY) await writeFile(file, next);
  }
}

const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
const total = rows.reduce((sum, [, n]) => sum + n, 0);
console.log(`  ${APPLY ? '已应用' : '预演'}：${total} 处替换，涉及 ${touched} 个文件\n`);
const byTarget = new Map();
for (const [key, n] of rows) {
  const to = key.split(' → ')[1];
  byTarget.set(to, (byTarget.get(to) ?? 0) + n);
}
console.log('  按目标令牌汇总：');
for (const [to, n] of [...byTarget.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(4)}  →  ${to}`);
}
if (!APPLY) console.log('\n  （预演模式，未写入。加 --apply 生效）');
