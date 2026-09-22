import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 列出 renderer/src 下所有 tsx/ts（用来扫「引用了不存在的令牌」的类名）。 */
async function sourceFiles(dir = ROOT): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    // 跳过测试文件：它们的注释与断言消息里**故意**会写出坏的类名当反例，
    // 而扫描看的是内容（本项目在凭据扫描上踩过同一个坑：注释照样命中）。
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 设计令牌的门禁。
 *
 * 改造前这个文件守的是 `--color-brand-blue` / `--color-brand-violet` —— 而实测这两个
 * 令牌在整个 renderer 里的**使用次数是 0**，真正在用的 `tech-*` 反而没有任何契约保护。
 * 也就是说：测试给「没人用的那套」上了锁。
 *
 * 现在改为守真正生效的令牌，并且**把对比度算出来断言**，而不是只匹配字符串 ——
 * 这样「边框又变得看不见了」「次要文字掉到 4.5 以下」会被测试直接拦下。
 */
const css = await readFile(new URL('../index.css', import.meta.url), 'utf8');

function token(name: string): string {
  const match = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `令牌 --color-${name} 必须是字面 hex（不能是 var 别名）`);
  return match[1];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

test('正文与次要文字在所有底层上都达到 AA（≥4.5:1）', () => {
  const surfaces = ['canvas', 'panel', 'elevated', 'well'];
  for (const surface of surfaces) {
    const bg = token(surface);
    assert.ok(
      contrast(token('ink'), bg) >= 4.5,
      `主文字压 ${surface} 只有 ${contrast(token('ink'), bg).toFixed(2)}:1`,
    );
    assert.ok(
      contrast(token('ink-muted'), bg) >= 4.5,
      `次要文字压 ${surface} 只有 ${contrast(token('ink-muted'), bg).toFixed(2)}:1`,
    );
  }
  // 三级文字只出现在较亮的底上，按最亮的 elevated 守
  assert.ok(contrast(token('ink-subtle'), token('elevated')) >= 4.5, '三级文字压 elevated 不达标');
});

test('语义状态文字压自身 soft 底达标（这是改造前的漂移点）', () => {
  for (const tone of ['success', 'warning', 'danger', 'info', 'running', 'ai']) {
    const ratio = contrast(token(tone), token(`${tone}-soft`));
    assert.ok(ratio >= 4.5, `${tone} 文字压 ${tone}-soft 只有 ${ratio.toFixed(2)}:1`);
  }
});

test('可交互控件边界 ≥3:1（WCAG 1.4.11），装饰线不受此约束', () => {
  for (const surface of ['canvas', 'panel', 'elevated', 'well']) {
    const ratio = contrast(token('line-ui'), token(surface));
    assert.ok(ratio >= 3, `控件边界压 ${surface} 只有 ${ratio.toFixed(2)}:1`);
  }
});

test('强调色：填充按钮用近黑字（白字不达标，故不得使用）', () => {
  assert.ok(contrast(token('on-accent'), token('accent')) >= 4.5, 'on-accent 压 accent 不达标');
  assert.ok(contrast(token('accent'), token('panel')) >= 3, '强调色作为图标/焦点环压 panel 不达标');
});

test('深色基调与全局可访问性规则存在', () => {
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /letter-spacing:\s*0/);
  // 全仓 148 个 button 曾实测全无手型光标；这条规则是那次修复的守门人
  assert.match(css, /button:not\(:disabled\)[\s\S]{0,200}cursor:\s*pointer/);
  // ActiveJobStrip 曾引用一个全仓不存在的 @keyframes，导致进度条静止。用例只断言了
  // 「不出现百分比」，所以一直是绿的；这里改为断言关键帧真的存在。
  assert.match(css, /@keyframes\s+indeterminate/);
  // 按压位移：改造前全仓 0 处 active 变体，点击毫无手感
  assert.match(css, /:active[\s\S]{0,120}transform:\s*translateY/, '按压反馈的位移规则不见了');
  // 时长令牌必须是**非零**毫秒值。它一旦变成无效值，Tailwind 那条
  // `transition-duration: var(--tw-duration, …)` 会整条失效、回落到 0s，
  // 表现是「所有按钮的悬停/按压颜色瞬间跳变」—— 真机实测踩过一次。
  for (const token of ['--duration-press', '--duration-ui']) {
    const found = css.match(new RegExp(`${token}:\\s*([0-9.]+)ms`));
    assert.ok(found, `${token} 必须是 ms 值（不能是 var 或 0）`);
    assert.ok(Number(found![1]) > 0, `${token} 不能为 0`);
  }
});

test('令牌只有一个真源：不再存在会被静默忽略的 tailwind.config.js', async () => {
  // Tailwind v4 不会自动加载 JS 配置（需 @config 指令，全仓无）。曾经仓库里那份
  // tailwind.config.js 定义了一套**同名但不同值**的 tech-*，改了完全没有效果。
  await assert.rejects(
    access(new URL('../../../tailwind.config.js', import.meta.url)),
    'tailwind.config.js 又出现了：它在 v4 下不生效，会成为「改了没反应」的第二真源',
  );
  // 断言前先剥掉注释：index.css 的说明里必然会提到这个指令名，而注释同样会被匹配
  // ——这与本项目凭据扫描踩过的坑是同一个（扫描看内容，注释照样命中）。
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(
    withoutComments,
    /@config/,
    '若确实需要 JS 配置，请显式写 @config 并删除本用例',
  );
});

test('源码里引用的颜色工具类都必须指向已定义的令牌', async () => {
  /*
   * 为什么要这条：项目里出现过 `hover:bg-accent-dark` 这种写法 —— 名字看着合理，
   * 但令牌表里只有 `accent-hover`，于是 Tailwind **不产出任何规则**、hover 静默失效，
   * 而且没有任何报错。这类「改了个不存在的名字」是纯靠肉眼审不出来的。
   *
   * 起因是一次批量改名：把 `tech-blue-dark` 换成新命名时，`\b` 词边界在
   * `-dark` 前也成立，于是 `bg-tech-blue-dark` 被替换成了从未定义过的 `bg-accent-dark`。
   */
  const defined = new Set(
    [...css.matchAll(/--color-([a-z-]+):/g)].map((match) => match[1]!),
  );
  /*
   * `tech` / `brand` 是**已退役的旧族**（迁移期别名，别名块已从 index.css 删除）。
   * 把它们也列进来，是因为门禁最初只查我自己的新族，于是漏掉了 4 处
   * `from-tech-blue` / `to-tech-purple` —— 那些渐变在别名删除后**整条失效**
   * （进度条没有填充色、侧栏 logo 没有底色），而且没有任何报错。
   * 现在只要源码里再出现这两个族的类名，用例就会失败。
   */
  const FAMILIES = [
    'accent', 'ai', 'success', 'warning', 'danger', 'info', 'running',
    'ink', 'line', 'panel', 'canvas', 'elevated', 'well',
    'tech', 'brand',
  ];
  const PREFIXES = ['bg', 'text', 'border', 'ring', 'divide', 'from', 'to', 'via', 'placeholder', 'fill', 'stroke'];
  const pattern = new RegExp(
    String.raw`\b(?:${PREFIXES.join('|')})-((?:${FAMILIES.join('|')})(?:-[a-z]+)*)\b`,
    'g',
  );

  const offenders = new Map<string, string[]>();
  for (const file of await sourceFiles()) {
    // 剥掉注释再扫：说明性文字里出现类名不算引用
    const text = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of text.matchAll(pattern)) {
      const token = match[1]!;
      // `accent-line` 这类「族-角色」要整体命中；只有整体不在表里才算错。
      if (defined.has(token)) continue;
      const list = offenders.get(token) ?? [];
      if (list.length < 3) list.push(path.relative(ROOT, file));
      offenders.set(token, list);
    }
  }

  assert.deepEqual(
    [...offenders.entries()],
    [],
    `以下颜色类指向未定义的令牌（Tailwind 不会产出规则，样式静默失效）：\n` +
      [...offenders.entries()].map(([token, files]) => `  · ${token} ← ${files.join(', ')}`).join('\n'),
  );
});
