/**
 * 今日头条发布页**只读侦察**探针（零副作用）。
 *
 * 这是本功能的可行性判据（spec §1.4 / §13）：登录后的真实发布页 DOM 目前看不到，
 * 而参考项目的选择器是「多候选属性包含」的启发式写法、**从未被验证过**。
 * 所以选择器只能来自实测证据，不能照抄。
 *
 * 它**只做**这几件事：
 *   1. 用产品的浏览器解析链启动无头浏览器（会话落 `storage/toutiao/profile`）；
 *   2. 取登录二维码 → 落盘 + 打印路径（用今日头条 App 扫码）；
 *   3. 轮询到登录成功，打印昵称；
 *   4. 进发布页，落盘完整 DOM 快照 + 打印各候选选择器的命中数与元素摘要；
 *   5. 在编辑器里派发一次 `ClipboardEvent` 并**读回**纯文本，判断富文本粘贴是否生效；
 *   6. 关闭浏览器。
 *
 * 它**绝不**：填标题、传封面、点任何按钮、点「发布」、保存草稿。
 *
 * 用法（仓库根目录）：
 *
 * ```bash
 * # ① 先登录（打开一个**真实的浏览器窗口**，用今日头条 App 扫码；会话落在 storage/toutiao/profile）
 * node --import tsx scripts/probe-toutiao-publish-page.ts --login
 *
 * # ② 再侦察（复用同一个 profile，所以不用再扫码；也可以直接在无头模式下跑）
 * node --import tsx scripts/probe-toutiao-publish-page.ts
 *
 * # ③ 只打开「封面」的上传抽屉看一眼它的 DOM（**不选文件、不上传**），然后 Escape 关掉
 * node --import tsx scripts/probe-toutiao-publish-page.ts --cover-drawer
 *
 * # ④ 发布前演练：在真实页面上把每一步都做完，**但绝不点「发布」**（副作用：头条会存一条草稿）
 * node --import tsx scripts/probe-toutiao-publish-page.ts --dry-run
 * # 可选：TOUTIAO_BROWSER_BINARY / TOUTIAO_PROFILE_DIR / STORAGE_PATH / TOUTIAO_PROBE_TIMEOUT_MS
 * ```
 *
 * `--login` 与应用里「设置 → 今日头条 → 打开浏览器扫码登录」是同一条代码路径
 * （`ToutiaoRunner.loginInWindow`），所以这里能过，界面按钮就能过。
 *
 * 退出码：侦察完成 0；未登录成功 / 发布页打不开 1。
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOUTIAO_BROWSER_GUIDANCE,
  describeAttempts,
  resolveToutiaoBrowser,
} from "../src/lib/toutiao-browser.js";
import { runCommand } from "../src/lib/command.js";
import { ToutiaoMediaService } from "../src/lib/toutiao-media.js";
import { renderToutiaoArticleHtml } from "../src/lib/toutiao-article.js";
import {
  TOUTIAO_PUBLISH_URL,
  ToutiaoRunner,
  openToutiaoSession,
} from "../src/lib/toutiao-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const storageRoot = path.resolve(process.env.STORAGE_PATH ?? path.join(rootDir, "storage"));
const reconDir = path.join(storageRoot, "toutiao", "recon");
const waitMs = Number(process.env.TOUTIAO_PROBE_TIMEOUT_MS ?? 600_000);

/** 候选选择器：参考项目的写法 + 字节系编辑器常见写法。命中数就是证据。 */
const TITLE_CANDIDATES = [
  'textarea[placeholder*="标题"]',
  'input[placeholder*="标题"]',
  'textarea[placeholder*="作品标题"]',
  'input[placeholder*="作品标题"]',
  '[class*="title"] textarea',
  '[class*="title"] input',
  "textarea",
  'input[type="text"]',
];

const EDITOR_CANDIDATES = [
  '[contenteditable="true"]',
  ".ProseMirror",
  '[class*="editor"] [contenteditable="true"]',
  '[class*="editor-content"]',
  '[class*="ql-editor"]',
  '[class*="bytemd"]',
];

const BUTTON_TEXT_CANDIDATES = ["预览并发布", "确认发布", "发布", "存草稿", "定时发布"];
const CHECKBOX_TEXT_CANDIDATES = ["头条首发", "发布得更多收益", "同时发布微头条", "作品声明", "声明"];
const SUCCESS_TEXT_CANDIDATES = ["发布成功", "已发布", "审核中", "提交成功", "发布失败"];

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function bytesToKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

async function main(): Promise<number> {
  console.log("今日头条发布页只读侦察（不填表、不传图、不点任何按钮、绝不发布）");
  console.log(`storage: ${storageRoot}`);
  console.log(`profile: ${path.resolve(process.env.TOUTIAO_PROFILE_DIR ?? path.join(storageRoot, "toutiao", "profile"))}`);

  const runner = new ToutiaoRunner({
    storageRoot,
    ...(process.env.TOUTIAO_BROWSER_BINARY ? { browserBinary: process.env.TOUTIAO_BROWSER_BINARY } : {}),
    repoRoot: rootDir,
  });

  // ── ① `--login`：打开**真实浏览器窗口**扫码 ───────────────────────────────
  //
  // 与界面上的「设置 → 今日头条 → 打开浏览器扫码登录」是**同一条代码路径**
  // （`ToutiaoRunner.loginInWindow`），所以这里能过，按钮就能过。
  // 注意这条链用的是**有头**解析（系统 Chrome / 完整 chromium）——打包的 headless shell 开不了窗口，
  // 因此这一段**刻意不打印无头解析链**，免得误导。
  if (process.argv.includes("--login")) {
    const existing = await runner.checkLogin().catch(() => undefined);
    if (existing?.loggedIn) {
      console.log(`✅ 已经登录过（${existing.username ?? "未知昵称"}）：无需再扫码，直接跑不带 --login 的侦察即可。`);
      return 0;
    }
    console.log("\n正在打开浏览器窗口（窗口里就是头条登录页，请用「今日头条」App 扫码）…");
    const result = await runner.loginInWindow({ timeoutMs: waitMs });
    console.log(result.loggedIn ? `✅ ${result.message}` : `❌ ${result.message}`);
    return result.loggedIn ? 0 : 1;
  }

  // ── ①c `--dry-run`：真实页面上的「填完但不发布」演练 ────────────────────────
  //
  // 这是唯一能验证**真实页面**上「填标题 / 粘正文 / 传封面 / 关微头条 / 勾首发与声明」这条链路的办法
  //（fixture 复刻不了动态行为）。**绝不点「预览并发布」**；唯一副作用是头条会把页面自动存成草稿。
  if (process.argv.includes("--dry-run")) {
    const existing = await runner.checkLogin().catch(() => undefined);
    if (!existing?.loggedIn) {
      console.error("❌ 还没有登录态：先跑 `--login` 扫码。");
      return 1;
    }

    // 封面：用 ffmpeg 现生成一张纯色 16:9（**不使用你的任何素材内容**），再走产品的裁剪路径。
    const workDir = path.join(reconDir, `dry-run-${stamp()}`);
    await mkdir(workDir, { recursive: true });
    const rawCover = path.join(workDir, "raw-cover.png");
    await runCommand(process.env.FFMPEG_BINARY ?? "ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=#1f2937:s=1600x1200", "-frames:v", "1", rawCover,
    ], { captureStderr: true, timeoutMs: 60_000 });
    const prepared = await new ToutiaoMediaService().prepareCoverImage(rawCover, workDir);

    // 正文：用产品自己的渲染器生成（含小标题/多段），与真实发布走同一条路。
    const html = renderToutiaoArticleHtml({
      title: "演练用标题",
      sections: [
        { heading: "这是演练的第一节", paragraphs: ["这一段由发布前演练写入，不会提交。", "可以直接在草稿箱里删除这一条。"] },
        { paragraphs: ["第二节：用于验证富文本粘贴与长度守卫。"] },
      ],
    });

    console.log("\n开始发布前演练（**不会点「发布」**；头条可能把页面存成一条草稿）…");
    const result = await runner.publishArticle({
      title: `演练用标题（可删除）${new Date().toISOString().slice(0, 16)}`,
      articleHtml: html,
      articleText: "这是演练的第一节\n\n这一段由发布前演练写入，不会提交。\n\n第二节：用于验证富文本粘贴与长度守卫。",
      coverPath: prepared.path,
      firstPublish: false,
      declarations: ["引用AI"],
      crossPostWeitoutiao: false,
    }, { dryRun: true });

    console.log(`\n${result.ok ? "✅" : "❌"} ${result.message}`);
    console.log("   正文落地方式:", result.bodyMode, "| 校验:", result.verification);
    console.log("   逐步记录:");
    for (const step of result.steps) console.log(`     - ${step}`);
    return result.ok ? 0 : 1;
  }

  // ── ①b `--cover-drawer`：只打开封面上传抽屉、只读它的 DOM ───────────────────
  //
  // 封面的文件框是**点了加号才现造出来的**（实测页面初始 `input[type=file]` 为 0 处），
  // 所以「文件框长什么样、抽屉里的确认按钮写什么」只能靠点开看一眼 —— 这一步**不选任何文件、
  // 不上传任何东西**，看完按 Escape 关掉。
  if (process.argv.includes("--cover-drawer")) {
    const existing = await runner.checkLogin().catch(() => undefined);
    if (!existing?.loggedIn) {
      console.error("❌ 还没有登录态：先跑 `--login` 扫码。");
      return 1;
    }
    const session = await openToutiaoSession({
      storageRoot,
      ...(process.env.TOUTIAO_BROWSER_BINARY ? { browserBinary: process.env.TOUTIAO_BROWSER_BINARY } : {}),
      repoRoot: rootDir,
    });
    try {
      const page = session.page as unknown as {
        goto(url: string, options?: unknown): Promise<unknown>;
        waitForTimeout?(ms: number): Promise<void>;
        evaluate<T>(expression: string): Promise<T>;
        click(selector: string, options?: unknown): Promise<void>;
        keyboard: { press(key: string): Promise<void> };
      };
      await page.goto(TOUTIAO_PUBLISH_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout?.(6_000);
      if (session.page.url().includes("/auth/page/login")) {
        console.error("❌ 被重定向回登录页：登录态没生效。");
        return 1;
      }

      const before = await page.evaluate<number>(`document.querySelectorAll('input[type="file"]').length`);
      console.log(`点加号前的 input[type=file] 数量：${before}`);

      await page.click("[class*='article-cover-add']", { force: true });
      await page.waitForTimeout?.(3_000);

      const report = await page.evaluate<string>(`(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]')).map(function (item) {
          return { accept: item.getAttribute("accept"), multiple: item.multiple, hidden: item.offsetParent === null };
        });
        const drawers = Array.from(
          document.querySelectorAll("[class*='drawer'], [class*='modal'], [class*='dialog'], [class*='upload']"),
        ).slice(0, 12).map(function (item) {
          const rect = item.getBoundingClientRect();
          return {
            tag: item.tagName,
            cls: (item.className || "").toString().slice(0, 90),
            text: (item.textContent || "").trim().slice(0, 120),
            rect: [Math.round(rect.width), Math.round(rect.height)],
          };
        });
        const buttons = Array.from(document.querySelectorAll("button")).map(function (item) {
          const rect = item.getBoundingClientRect();
          return { text: (item.textContent || "").trim(), cls: (item.className || "").toString().slice(0, 60), rect: [Math.round(rect.width), Math.round(rect.height)] };
        }).filter(function (item) { return item.rect[0] > 0 && item.text.length > 0; });
        return JSON.stringify({ inputs: inputs, drawers: drawers, visibleButtons: buttons.slice(0, 25) }, null, 2);
      })()`);

      await mkdir(reconDir, { recursive: true });
      const reportPath = path.join(reconDir, "cover-drawer.json");
      await writeFile(reportPath, report, "utf8");
      console.log(report);
      console.log(`\n完整报告: ${reportPath}`);

      // 不选文件、不上传：直接关掉抽屉离开。
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.waitForTimeout?.(500);
      console.log("\n本次未选择任何文件、未上传任何内容（只是点开了抽屉看一眼）。");
      return 0;
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  // ── ② 侦察：无头链（复用 profile 里的登录态，所以通常不用再扫码）────────────
  const resolution = resolveToutiaoBrowser({
    ...(process.env.TOUTIAO_BROWSER_BINARY ? { browserBinary: process.env.TOUTIAO_BROWSER_BINARY } : {}),
    repoRoot: rootDir,
  });
  console.log("浏览器解析链（无头）：");
  for (const attempt of resolution.attempts) {
    console.log(`  ${attempt.ok ? "✅" : "❌"} ${attempt.layer}: ${attempt.detail}`);
  }
  if (!resolution.target) {
    console.error(`\n${TOUTIAO_BROWSER_GUIDANCE}\n逐层诊断：${describeAttempts(resolution.attempts)}`);
    return 1;
  }
  console.log(`选中的目标: ${JSON.stringify(resolution.target)}`);

  await mkdir(reconDir, { recursive: true });

  const current = await runner.checkLogin();
  console.log(`\n登录态自检：${current.loggedIn ? "已登录" : "未登录"}${current.username ? `（${current.username}）` : ""}`);
  console.log(`  当前 URL: ${current.url}`);

  if (!current.loggedIn) {
    console.error(
      "❌ 还没有登录态：先用 `node --import tsx scripts/probe-toutiao-publish-page.ts --login` 扫码登录一次，"
      + "或在应用里「设置 → 今日头条 → 打开浏览器扫码登录」。登录态会保存在同一个 profile 目录里，之后不用再扫。",
    );
    return 1;
  }

  // ③ 发布页侦察：用与产品同一条启动路径开新会话，但**只读**。
  const session = await openToutiaoSession({
    storageRoot,
    ...(process.env.TOUTIAO_BROWSER_BINARY ? { browserBinary: process.env.TOUTIAO_BROWSER_BINARY } : {}),
    repoRoot: rootDir,
  });
  try {
    await session.page.goto(TOUTIAO_PUBLISH_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await session.page.waitForTimeout?.(6_000);
    const finalUrl = session.page.url();
    console.log(`\n发布页: ${finalUrl}`);
    if (finalUrl.includes("/auth/page/login")) {
      console.error("❌ 被重定向回登录页：登录态没生效（可能是无头模式被风控）。");
      console.error("   下一步：用 TOUTIAO_BROWSER_BINARY 指向系统 Chrome 或改有头模式复测（spec §11 风险表）。");
      return 1;
    }

    const html = await session.page.content();
    const htmlPath = path.join(reconDir, "publish-page.html");
    await writeFile(htmlPath, html, "utf8");
    console.log(`✅ DOM 快照: ${htmlPath}（${bytesToKb(Buffer.byteLength(html))}）`);

    const report = await collect(session.page as never);
    const reportPath = path.join(reconDir, "selectors.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    printReport(report, reportPath);
  } finally {
    await session.close().catch(() => undefined);
  }

  console.log("\n本次未发布任何内容（未填表、未传图、未点任何按钮）。");
  return 0;
}

interface CandidateHit {
  selector: string;
  count: number;
  samples: Array<Record<string, unknown>>;
}

interface ReconReport {
  url: string;
  titleCandidates: CandidateHit[];
  editorCandidates: CandidateHit[];
  buttons: Array<Record<string, unknown>>;
  checkboxes: Array<Record<string, unknown>>;
  inputs: Array<Record<string, unknown>>;
  textCandidates: Array<{ text: string; matches: Array<Record<string, unknown>> }>;
  pasteProbe: { supported: boolean; readBack: string; note: string };
}

/**
 * 页面侧代码**必须以字符串**下发。
 *
 * 原因（2026-09-18 实测）：tsx/esbuild 会把内联箭头函数包上 `__name(...)` 助手，
 * 而 Playwright 是把**函数源码**序列化后丢进页面执行的 —— 页面里没有 `__name`，
 * 于是 `page.evaluate(() => {...})` 直接报 `ReferenceError: __name is not defined`。
 * `dist/` 由 tsc 编译、不注入该助手，所以这个坑**只在 tsx 下**出现（脚本与测试都跑在 tsx 下）。
 */
async function collect(page: { evaluate<T>(expression: string): Promise<T> }): Promise<ReconReport> {
  const input = {
    titleCandidates: TITLE_CANDIDATES,
    editorCandidates: EDITOR_CANDIDATES,
    buttonTexts: BUTTON_TEXT_CANDIDATES,
    checkboxTexts: CHECKBOX_TEXT_CANDIDATES,
    successTexts: SUCCESS_TEXT_CANDIDATES,
  };

  return page.evaluate<ReconReport>(`((input) => {
    const summarize = (element) => {
      const html = element;
      const rect = html.getBoundingClientRect();
      return {
        tag: html.tagName,
        class: (html.className || "").toString().slice(0, 120),
        placeholder: html.getAttribute("placeholder"),
        type: html.getAttribute("type"),
        text: (html.textContent || "").trim().slice(0, 60),
        visible: rect.width > 0 && rect.height > 0,
        rect: [Math.round(rect.width), Math.round(rect.height)],
      };
    };
    const hit = (selector) => {
      let elements = [];
      try {
        elements = Array.from(document.querySelectorAll(selector));
      } catch (error) {
        elements = [];
      }
      return { selector, count: elements.length, samples: elements.slice(0, 3).map(summarize) };
    };
    const textMatches = (text) =>
      Array.from(document.querySelectorAll("button, [role='button'], label, span, div"))
        .filter((element) => (element.textContent || "").trim() === text)
        .slice(0, 4)
        .map(summarize);

    const editorSelector = input.editorCandidates
      .map((selector) => {
        let count = 0;
        try {
          count = document.querySelectorAll(selector).length;
        } catch (error) {
          count = 0;
        }
        return { selector, count };
      })
      .find((item) => item.count > 0);
    const editor = editorSelector ? document.querySelector(editorSelector.selector) : null;

    let pasteReadBack = "";
    let pasteSupported = false;
    if (editor) {
      editor.focus();
      const data = new DataTransfer();
      data.setData("text/html", "<p>侦察探针：粘贴能力测试</p><p>第二段</p>");
      data.setData("text/plain", "侦察探针：粘贴能力测试 第二段");
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      const before = (editor.textContent || "").length;
      editor.dispatchEvent(event);
      pasteReadBack = (editor.textContent || "").trim().slice(0, 120);
      pasteSupported = (editor.textContent || "").length > before;
    }

    return {
      url: location.href,
      titleCandidates: input.titleCandidates.map(hit),
      editorCandidates: input.editorCandidates.map(hit),
      buttons: Array.from(document.querySelectorAll("button")).slice(0, 40).map(summarize),
      checkboxes: Array.from(
        document.querySelectorAll("input[type='checkbox'], [role='checkbox'], [class*='checkbox']"),
      ).slice(0, 20).map(summarize),
      inputs: Array.from(document.querySelectorAll("textarea, input")).slice(0, 30).map(summarize),
      textCandidates: [...input.buttonTexts, ...input.checkboxTexts, ...input.successTexts].map((text) => ({
        text,
        matches: textMatches(text),
      })),
      pasteProbe: {
        supported: pasteSupported,
        readBack: pasteReadBack,
        note: pasteSupported
          ? "编辑器接受了 ClipboardEvent(text/html) 并写入了内容 → 可走富文本粘贴"
          : "派发粘贴后编辑器内容未变化 → 改为「按段落逐段输入纯文本」",
      },
    };
  })(${JSON.stringify(input)})`);
}

function printReport(report: ReconReport, reportPath: string): void {
  console.log("\n── 标题框候选 ──");
  for (const candidate of report.titleCandidates) {
    console.log(`  ${candidate.count > 0 ? "✅" : "  "} ${candidate.selector} → ${candidate.count}`);
    for (const sample of candidate.samples) {
      console.log(`       ${JSON.stringify(sample)}`);
    }
  }

  console.log("\n── 编辑器候选 ──");
  for (const candidate of report.editorCandidates) {
    console.log(`  ${candidate.count > 0 ? "✅" : "  "} ${candidate.selector} → ${candidate.count}`);
    for (const sample of candidate.samples) {
      console.log(`       ${JSON.stringify(sample)}`);
    }
  }

  console.log("\n── 按钮（前 40 个）──");
  for (const button of report.buttons) {
    console.log(`  ${JSON.stringify(button)}`);
  }

  console.log("\n── 勾选框/开关 ──");
  for (const checkbox of report.checkboxes) {
    console.log(`  ${JSON.stringify(checkbox)}`);
  }

  console.log("\n── 文本类候选（按钮/标签/开关的精确文案）──");
  for (const candidate of report.textCandidates) {
    const mark = candidate.matches.length > 0 ? "✅" : "  ";
    console.log(`  ${mark} 「${candidate.text}」→ ${candidate.matches.length}`);
    for (const match of candidate.matches) {
      console.log(`       ${JSON.stringify(match)}`);
    }
  }

  console.log("\n── 富文本粘贴探针 ──");
  console.log(`  ${report.pasteProbe.supported ? "✅ 支持" : "❌ 不支持"}：${report.pasteProbe.note}`);
  console.log(`  读回内容: ${JSON.stringify(report.pasteProbe.readBack)}`);

  console.log(`\n完整报告: ${reportPath}`);
}

process.exitCode = await main();
