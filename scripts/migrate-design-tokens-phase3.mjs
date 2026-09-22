#!/usr/bin/env node
/**
 * 设计令牌迁移 · 第三阶段：退役过渡别名。
 *
 * 第一/二阶段把「原生调色板类」换成了语义令牌，但当时保留了 `tech-*` 这批旧名字
 * 当过渡别名（避免一次性改动过大）。现在把调用点也换到新名字，
 * 让令牌只有一套命名 —— 否则 `--color-tech-text` 与 `--color-ink` 会长期并存，
 * 又变成「两种写法指同一个值」的认知负担（改造前正是三套并存）。
 *
 * 用法： node scripts/migrate-design-tokens-phase3.mjs [--apply]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(import.meta.dirname, '..', 'renderer', 'src');

/** 旧名 → 新名。顺序无所谓：全部按词边界整词替换，不存在前缀互相吃掉的问题。 */
const MAP = {
  'text-tech-text': 'text-ink',
  'text-tech-muted': 'text-ink-muted',
  'text-tech-blue': 'text-accent',
  'text-tech-purple': 'text-ai',
  'text-tech-cyan': 'text-running',
  'bg-tech-bg': 'bg-canvas',
  'bg-tech-surface': 'bg-panel',
  'bg-tech-blue': 'bg-accent',
  'bg-tech-purple': 'bg-ai',
  'bg-tech-text': 'bg-accent',
  'border-tech-border': 'border-line',
  'border-tech-blue': 'border-accent-line',
  'divide-tech-border': 'divide-line',
  'ring-tech-border': 'ring-line',
  'ring-tech-blue': 'ring-accent',
  'placeholder-tech-muted': 'placeholder-ink-muted',
  'hover:bg-tech-border': 'hover:bg-elevated',
};

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
  for (const [from, to] of Object.entries(MAP)) {
    const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const hits = next.match(re);
    if (!hits) continue;
    counts.set(`${from} → ${to}`, (counts.get(`${from} → ${to}`) ?? 0) + hits.length);
    next = next.replace(re, to);
  }
  if (next !== original) {
    touched += 1;
    if (APPLY) await writeFile(file, next);
  }
}

const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
const total = rows.reduce((sum, [, n]) => sum + n, 0);
console.log(`  ${APPLY ? '已应用' : '预演'}：${total} 处替换，涉及 ${touched} 个文件`);
for (const [k, n] of rows) console.log(`    ${String(n).padStart(4)}  ${k}`);
if (!APPLY) console.log('\n  （预演模式，未写入。加 --apply 生效）');
