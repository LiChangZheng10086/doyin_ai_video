/**
 * 头条发布页**页面步骤**测试：用**真实 Playwright** 驱动一个**离线 fixture 页**。
 *
 * fixture（`src/lib/fixtures/toutiao-publish-page.html`）是从 2026-09-18 只读侦察的 DOM 快照里
 * **逐段抠出来的**（标题框的 placeholder、`.ProseMirror`、`.article-cover-add`、勾选框 label 的
 * 类名与文案、`publish-btn publish-btn-last` 都同形），所以这里断言的是「选择器命中真实标记 + 读回校验」，
 * 而不是「自己写完自己断言」。
 *
 * 覆盖不到的部分（fixture 复刻不了的**动态**行为，已在计划里记明）：
 * - 封面抽屉本身的 DOM（真页点加号后会弹上传抽屉）→ 只能等一次真实发布验证；
 * - 点「预览并发布」之后的**确认页**与成功提示（点进去就等于发布，只读侦察不做）；
 *   因此 `submitAndConfirm` 的 `signal` 在 fixture 里必然是空串 —— 本文件正好用它守住
 *   「拿不到判据就返回 unconfirmed，绝不谎报」这条纪律。
 *
 * 没有可用浏览器时**跳过**（与既有 `RUN_HYPERFRAMES_INTEGRATION` 同一惯例）。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { resolveToutiaoBrowserTarget, type ToutiaoBrowserTarget } from "./toutiao-browser.js";
import { ToutiaoRunner } from "./toutiao-runner.js";
import {
  ToutiaoPageError,
  ensureWeitoutiaoUnchecked,
  fillBodyHtml,
  fillTitle,
  firstPublishIsChecked,
  setDeclarations,
  setFirstPublish,
  hasLeftPublishPage,
  submitAndConfirm,
  uploadCover,
  weitoutiaoIsChecked,
  type ToutiaoPublishPageLike,
} from "./toutiao-page.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "toutiao-publish-page.html");
const fixtureUrl = pathToFileURL(fixturePath).href;

const target = resolveToutiaoBrowserTarget({ repoRoot: path.resolve(fileURLToPath(import.meta.url), "../../..") });
const skip = target ? false : "本机没有可用的 Playwright 浏览器：先跑 npm run prepare:package:mac 或 npx playwright install chromium";

interface Harness {
  page: ToutiaoPublishPageLike;
  close(): Promise<void>;
}

const harnesses: Harness[] = [];
after(async () => {
  await Promise.all(harnesses.map((item) => item.close().catch(() => undefined)));
});

/** fixture 的 URL（`?lockWeitoutiao=1` 让那个勾选框点了没反应）。 */
function harnessUrl(options: {
  lockWeitoutiao?: boolean;
  coverChooser?: boolean;
  confirm?: boolean;
  silent?: boolean;
  firstPublishChecked?: boolean;
  lockFirstPublish?: boolean;
} = {}): string {
  const params = [
    ...(options.lockWeitoutiao ? ["lockWeitoutiao=1"] : []),
    ...(options.coverChooser ? ["cover=chooser"] : []),
    ...(options.confirm ? ["confirm=1"] : []),
    ...(options.silent ? ["silent=1"] : []),
    ...(options.firstPublishChecked ? ["firstPublishChecked=1"] : []),
    ...(options.lockFirstPublish ? ["lockFirstPublish=1"] : []),
  ];
  return params.length > 0 ? `${fixtureUrl}?${params.join("&")}` : fixtureUrl;
}

/** 起一个真实浏览器打开 fixture 页（只读、离线、无网络请求）。 */
async function openFixture(options: {
  lockWeitoutiao?: boolean;
  coverChooser?: boolean;
  confirm?: boolean;
  /** 确认按钮存在，但点了不给成功提示（复刻真机那次「发出去了但读不到判据」）。 */
  silent?: boolean;
  /** 预置「头条首发」为勾选（模拟残留草稿把状态带回来）。 */
  firstPublishChecked?: boolean;
  /** 「头条首发」点了没反应（验证取消不掉时 fail closed）。 */
  lockFirstPublish?: boolean;
} = {}): Promise<Harness> {
  const { chromium } = await import("playwright");
  const launchOptions: Parameters<typeof chromium.launch>[0] = { headless: true };
  const resolved = target as ToutiaoBrowserTarget;
  if (resolved.kind === "executablePath") launchOptions.executablePath = resolved.path;
  if (resolved.kind === "channel") launchOptions.channel = resolved.channel;

  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  // 负例用 URL 参数表达：runner 流程里还会再 goto 一次，靠 DOM 打标记会被重载清掉。
  await page.goto(harnessUrl(options), { waitUntil: "domcontentloaded" });

  const harness: Harness = {
    page: page as unknown as ToutiaoPublishPageLike,
    close: () => browser.close(),
  };
  harnesses.push(harness);
  return harness;
}

test("fixture 的标题框与真页同形（placeholder 就是平台写的 2～30 字）", { skip }, async () => {
  const { page } = await openFixture();
  const placeholder = await page.evaluate<string>(`document.querySelector('textarea').getAttribute('placeholder')`);
  assert.match(placeholder, /请输入文章标题（2～30个字）/u);

  await fillTitle(page, "头条文章标题");
  const value = await page.evaluate<string>(`document.querySelector('textarea').value`);
  assert.equal(value, "头条文章标题");
});

test("找不找得到标题框会明确报错，而不是静默跳过", { skip }, async () => {
  const { page } = await openFixture();
  await page.evaluate(`document.querySelector('textarea').remove()`);

  await assert.rejects(
    () => fillTitle(page, "标题"),
    (error: unknown) => error instanceof ToutiaoPageError && error.code === "toutiao_page_title_missing",
  );
});

test("正文：富文本粘贴生效并读回，返回 rich", { skip }, async () => {
  const { page } = await openFixture();

  const mode = await fillBodyHtml(page, "<h2>小标题</h2><p>第一段。</p>", ["小标题", "第一段。"]);
  assert.equal(mode, "rich");
  const text = await page.evaluate<string>(`document.querySelector('.ProseMirror').textContent`);
  assert.match(text, /小标题/u);
  assert.match(text, /第一段。/u);
});

test("正文：编辑器吃不下粘贴时退回逐段输入并读回（返回 plain，不静默）", { skip }, async () => {
  const { page } = await openFixture();
  // 把 paste 处理拆掉：模拟「编辑器不认 ClipboardEvent」的真实可能性。
  await page.evaluate(`(() => {
    const editor = document.querySelector('.ProseMirror');
    const clone = editor.cloneNode(false);
    editor.parentNode.replaceChild(clone, editor);
  })()`);

  const mode = await fillBodyHtml(page, "<p>甲</p>", ["甲段落", "乙段落"]);
  assert.equal(mode, "plain");
  const text = await page.evaluate<string>(`document.querySelector('.ProseMirror').textContent`);
  assert.match(text, /甲段落/u);
  assert.match(text, /乙段落/u);
});

test("封面：点加号后文件框出现、文件送达、封面上读回到图", { skip }, async () => {
  const { page } = await openFixture();
  // 真页初始没有文件框 —— fixture 复刻了这一点。
  assert.equal(await page.evaluate<number>(`document.querySelectorAll('input[type="file"]').length`), 0);

  await uploadCover(page, fixturePath);

  const files = await page.evaluate<number>(`document.querySelectorAll('.article-cover-img-wrap img').length`);
  assert.equal(files, 1, "封面上应当出现上传后的图片（且只出现一张：点页签不等于选了文件）");
});

test("封面：加号找不到时明确报错（绝不「尽力而为」地继续发布）", { skip }, async () => {
  const { page } = await openFixture();
  await page.evaluate(`document.querySelector('.article-cover-add').remove()`);

  await assert.rejects(
    () => uploadCover(page, fixturePath),
    (error: unknown) => error instanceof ToutiaoPageError && error.code === "toutiao_page_cover_add_missing",
  );
});

test("「同时发布微头条」默认勾选 → 关掉并读回未勾选", { skip }, async () => {
  const { page } = await openFixture();
  assert.equal(await weitoutiaoIsChecked(page), true, "平台默认是勾选的（fixture 与真页一致）");

  await ensureWeitoutiaoUnchecked(page);
  assert.equal(await weitoutiaoIsChecked(page), false);
});

test("「同时发布微头条」关不掉时抛错并停在发布之前（fail closed）", { skip }, async () => {
  const { page } = await openFixture({ lockWeitoutiao: true });

  await assert.rejects(
    () => ensureWeitoutiaoUnchecked(page),
    (error: unknown) =>
      error instanceof ToutiaoPageError && error.code === "toutiao_page_weitoutiao_unchecked_failed",
  );
  // 关键：一个按钮都没被点过。
  assert.deepEqual(await page.evaluate<string[]>(`window.__clicked`), []);
});

test("头条首发默认未勾选；勾选后读回为已勾选", { skip }, async () => {
  const { page } = await openFixture();
  assert.equal(await firstPublishIsChecked(page), false);

  await setFirstPublish(page, true);
  assert.equal(await firstPublishIsChecked(page), true);

  // 不需要时不点，也不该抛错。
  const { page: other } = await openFixture();
  await setFirstPublish(other, false);
  assert.equal(await firstPublishIsChecked(other), false);
});

test("作品声明：逐条点选；文案对不上就明确报错（合规声明不能被静默跳过）", { skip }, async () => {
  const { page } = await openFixture();
  await setDeclarations(page, ["引用AI", "个人观点，仅供参考"]);

  const checked = await page.evaluate<string[]>(`(() => {
    return Array.from(document.querySelectorAll('label.byte-checkbox.byte-checkbox-checked'))
      .map((item) => (item.textContent || "").trim());
  })()`);
  assert.ok(checked.includes("引用AI"));
  assert.ok(checked.includes("个人观点，仅供参考"));

  await assert.rejects(
    () => setDeclarations(page, ["这条声明页面上没有"]),
    (error: unknown) => error instanceof ToutiaoPageError && error.code === "toutiao_page_declaration_missing",
  );
});

test("提交：点「预览并发布」；拿不到成功判据时 signal 为空串（绝不谎报 confirmed）", { skip }, async () => {
  const { page } = await openFixture();

  const result = await submitAndConfirm(page);
  assert.deepEqual(await page.evaluate<string[]>(`window.__clicked`), ["预览并发布"]);
  assert.equal(result.signal, "", "fixture 里没有成功文案 → 必须返回空判据，由上层记 unconfirmed");
});

// ─── runner.publishArticle 的编排（真浏览器 + fixture；不联网、不发布）────────────
//
// 这一段补的是计划 Task 4 Step 4 那批用例。用**真页面**而不是「字符串匹配的假页面」，
// 因为 `toutiao-page.ts` 的页面侧代码是字符串下发的：假页面只能靠猜字符串来响应，那种测试
// 反而会掩盖真实问题（本项目已经吃过一次「元素存在 ≠ 图上屏」的亏）。
//
// `goto` 被拦到本地 fixture —— **绝不联网、绝不点真实站点**。

/** 把真实页面适配成 `ToutiaoPublishPageLike`，并把 `goto` 拦到 fixture。 */
function adaptPage(page: Awaited<ReturnType<typeof openFixture>>["page"], fixture: string): ToutiaoPublishPageLike {
  const raw = page as unknown as {
    url(): string;
    goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
    waitForTimeout(ms: number): Promise<void>;
    evaluate(expression: string): Promise<unknown>;
    click(selector: string, options?: { timeout?: number; force?: boolean }): Promise<void>;
    type(selector: string, text: string, options?: { delay?: number }): Promise<void>;
    setInputFiles(selector: string, files: string): Promise<void>;
    waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
    waitForEvent(name: "filechooser", options?: { timeout?: number }): Promise<{ setFiles(files: string): Promise<void> }>;
    keyboard: {
      type(text: string, options?: { delay?: number }): Promise<void>;
      press(key: string): Promise<void>;
    };
  };
  return {
    url: () => raw.url(),
    goto: async () => {
      await raw.goto(fixture, { waitUntil: "domcontentloaded" });
    },
    waitForTimeout: (ms) => raw.waitForTimeout(ms),
    evaluate: <T>(expression: string) => raw.evaluate(expression) as Promise<T>,
    click: (selector, options) => raw.click(selector, options),
    type: (selector, text, options) => raw.type(selector, text, options),
    setInputFiles: (selector, files) => raw.setInputFiles(selector, files),
    waitForSelector: (selector, options) => raw.waitForSelector(selector, options),
    waitForEvent: (name, options) => raw.waitForEvent(name, options),
    keyboard: {
      type: (text, options) => raw.keyboard.type(text, options),
      press: (key) => raw.keyboard.press(key),
    },
  };
}

/** 一个临时封面文件（内容无所谓：fixture 的 file input 只记录「收到了文件」）。 */
async function tempCover(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "toutiao-cover-"));
  const file = path.join(dir, "cover.jpg");
  await writeFile(file, "fake-cover-bytes");
  return file;
}

function publishRunner(page: ToutiaoPublishPageLike, extra: Record<string, unknown> = {}) {
  const session = { closed: false };
  const runner = new ToutiaoRunner({
    storageRoot: path.dirname(fixturePath),
    browserBinary: fileURLToPath(import.meta.url),
    launch: async () => ({
      page,
      close: async () => {
        session.closed = true;
      },
    }),
    ...extra,
  });
  return { runner, session };
}

const PUBLISH_INPUT = {
  title: "头条文章标题",
  articleHtml: "<h2>小标题</h2><p>第一段正文。</p>",
  articleText: "小标题\n\n第一段正文。",
  firstPublish: false,
  declarations: [] as string[],
  crossPostWeitoutiao: false,
};

test("publishArticle 正常路径：逐步记录、富文本粘贴、确认后拿到成功判据", { skip }, async () => {
  // 带确认按钮的形态：点「预览并发布」→ 出现「确认发布」→ 点它 → 页面出现成功提示。
  const harness = await openFixture({ confirm: true });
  const page = adaptPage(harness.page as never, harnessUrl({ confirm: true }));
  const { runner, session } = publishRunner(page);

  const result = await runner.publishArticle({ ...PUBLISH_INPUT, coverPath: await tempCover() });

  assert.equal(result.ok, true);
  assert.equal(result.bodyMode, "rich");
  assert.equal(result.verification, "confirmed");
  assert.match(result.message, /发布成功/u);
  // 步骤记录要能说清「做到哪一步了」（失败排查与审计都靠它）。
  assert.deepEqual(result.steps, ["进入发布页", "填标题（6 字）", "粘正文（富文本）", "上传封面", "关闭「同时发布微头条」", "点击发布并确认"]);
  // 两个按钮都真的被点过（这正是评审指出的「不能只点预览就声称已点击发布」）。
  assert.deepEqual(await page.evaluate<string[]>("window.__clicked"), ["预览并发布", "确认发布"]);
  assert.equal(session.closed, true, "发布结束必须关浏览器（不留孤儿）");
});

test("publishArticle：没有确认按钮时如实报失败，绝不声称「已点击发布」", { skip }, async () => {
  // 默认 fixture **没有**确认按钮（模拟确认页结构变了 / 没进去）。
  const harness = await openFixture();
  const page = adaptPage(harness.page as never, fixtureUrl);
  const { runner, session } = publishRunner(page);

  const result = await runner.publishArticle({ ...PUBLISH_INPUT, coverPath: await tempCover() });

  assert.equal(result.ok, false, "只点了「预览并发布」事实上什么都没发出去");
  assert.equal(result.verification, "unconfirmed");
  assert.match(result.message, /没有找到确认按钮/u);
  assert.match(result.message, /未提交任何内容/u);
  assert.equal(result.message.includes("已点击发布"), false, "不许谎报点过发布");
  // 失败信息必须带上「当时页面上有哪些按钮」——这是校准确认按钮文案的唯一线索
  //（那一页的真实文案无法用只读侦察拿到，只能靠一次真实运行把它带回来）。
  assert.match(result.message, /可见按钮是：/u);
  assert.match(result.message, /预览并发布/u);
  assert.ok(result.steps.includes("点击「预览并发布」（未找到确认按钮）"));
  assert.equal(session.closed, true);
});

test("publishArticle：登录态失效时停在发布之前（不点任何按钮）", { skip }, async () => {
  const loginFixture = pathToFileURL(
    path.join(path.dirname(fixturePath), "auth", "page", "login.html"),
  ).href;
  const harness = await openFixture();
  const page = adaptPage(harness.page as never, loginFixture);
  const { runner, session } = publishRunner(page);

  const result = await runner.publishArticle({ ...PUBLISH_INPUT, coverPath: await tempCover() });

  assert.equal(result.ok, false);
  assert.match(result.message, /登录态已失效|重新扫码/u);
  assert.deepEqual(result.steps, [], "一步都不该完成（连发布页都没进去）");
  assert.equal(session.closed, true);
});

test("publishArticle：关不掉「同时发布微头条」就不发布（fail closed）", { skip }, async () => {
  const harness = await openFixture({ lockWeitoutiao: true });
  const page = adaptPage(harness.page as never, harnessUrl({ lockWeitoutiao: true }));
  const { runner, session } = publishRunner(page);

  const result = await runner.publishArticle({ ...PUBLISH_INPUT, coverPath: await tempCover() });

  assert.equal(result.ok, false);
  assert.match(result.message, /同时发布微头条/u);
  // 关键：**一个按钮都没点**（发布按钮从未被触碰）。
  assert.deepEqual(await page.evaluate<string[]>("window.__clicked"), []);
  assert.equal(result.verification, "unconfirmed");
  assert.equal(session.closed, true);
  // 失败也要写清已完成到哪一步。
  assert.deepEqual(result.steps, ["进入发布页", "填标题（6 字）", "粘正文（富文本）", "上传封面"]);
});

test("publishArticle：封面文件不存在时停在发布之前", { skip }, async () => {
  const harness = await openFixture();
  const page = adaptPage(harness.page as never, fixtureUrl);
  const { runner, session } = publishRunner(page);

  const result = await runner.publishArticle({
    ...PUBLISH_INPUT,
    coverPath: path.join(path.dirname(fixturePath), "definitely-missing-cover.jpg"),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /封面/u);
  assert.deepEqual(await page.evaluate<string[]>("window.__clicked"), []);
  assert.equal(session.closed, true);
});

test("publishArticle：勾选头条首发与作品声明后仍然关掉微头条（选项都要落地）", { skip }, async () => {
  const harness = await openFixture({ confirm: true });
  const page = adaptPage(harness.page as never, harnessUrl({ confirm: true }));
  const { runner } = publishRunner(page);

  const result = await runner.publishArticle({
    ...PUBLISH_INPUT,
    coverPath: await tempCover(),
    firstPublish: true,
    declarations: ["引用AI"],
  });

  assert.equal(result.ok, true);
  assert.equal(await firstPublishIsChecked(page), true);
  assert.equal(await weitoutiaoIsChecked(page), false);
  const checked = await page.evaluate<string[]>(`(() => Array.from(
    document.querySelectorAll("label.byte-checkbox.byte-checkbox-checked"),
  ).map((item) => (item.textContent || "").trim()))()`);
  assert.ok(checked.includes("引用AI"), "作品声明必须真的勾上");
  assert.ok(result.steps.includes("勾选头条首发"));
  assert.ok(result.steps.some((step) => step.startsWith("设置作品声明")));
});

test("封面：真页那种「临时 input + 原生选择框」形态也能传上去（不依赖 DOM 里有文件框）", { skip }, async () => {
  const harness = await openFixture({ coverChooser: true });
  const page = adaptPage(harness.page as never, harnessUrl({ coverChooser: true }));

  // 先确认这就是真页实测的形态：DOM 里查不到文件框。
  assert.equal(await page.evaluate<number>(`document.querySelectorAll('input[type="file"]').length`), 0);

  await uploadCover(page, fixturePath);

  const files = await page.evaluate<number>(`document.querySelectorAll('.article-cover-img-wrap img').length`);
  assert.equal(files, 1, "走原生选择框这条路也必须能传上封面");
});

// ─── 标题里的中文全角标点 + 空格：真机实测被输入法吞掉一个字符 ────────────────────
//
// 2026-09-18 用户真机提交失败的原文：
//   「标题框里读回的内容与要发的标题不一致（读到 27 字、期望 28 字）：已停在点「发布」之前」
// 标题是 `Ponytail：专治 AI 过度设计的开源 Skill` —— 逐字 `type`（40ms/字）时，全角冒号 `：`
// 会进入输入法组合态，把紧跟其后的**空格**吃掉。fixture 复刻不了输入法行为，
// 所以这一组用**假页面**精确模拟「逐字输入少一个字符、整体插入正确」：
// 修复前它必红，修复后 `fillTitle` 应当改用一次性插入并通过读回。

function imeSwallowingPage(options: { insertTextAlsoSwallows?: boolean; swallowWrites?: number } = {}): {
  page: ToutiaoPublishPageLike;
  calls: string[];
} {
  const calls: string[] = [];
  let value = "";
  /**
   * 模拟真机症状：**逐字输入会丢掉一个空格**（读回 27 字、期望 28 字）。
   *
   * 这里刻意**只按症状建模，不假装知道机制** —— 机制可能是输入法组合态吞字符，
   * 也可能是受控输入（Vue/React 把 `.value` 从模型写回）与逐键输入之间的竞态；
   * 两者在真机上的表现完全一样。修复要稳的是「换个写法 + 读回复核」，
   * 而不是猜中某一条具体规则。
   */
  const withIme = (text: string) => {
    const index = text.split("").findIndex((char, position) => char === " " && position > 0);
    return index < 0 ? text : text.slice(0, index) + text.slice(index + 1);
  };
  // 真机现象是**概率性**的（同一次运行里丢一个字符，下一次同样写法又对了），
  // 所以这里按「前 N 次写入会丢字符」建模：默认无限次丢（用于验证报错），
  // 传 1 就是真机那次的样子。
  const remaining = { count: options.swallowWrites ?? Number.POSITIVE_INFINITY };
  const maybeSwallow = (text: string, always: boolean) => {
    if (!always && remaining.count <= 0) return text;
    if (!always) remaining.count -= 1;
    return withIme(text);
  };
  const swallow = (text: string) => maybeSwallow(text, options.insertTextAlsoSwallows === true);

  const page = {
    url: () => PUBLISH_PAGE_URL,
    async goto() { return undefined; },
    async click() { return undefined; },
    async type(_selector: string, text: string) { calls.push("type"); value += maybeSwallow(text, options.insertTextAlsoSwallows === true); },
    async evaluate<T>(expression: string): Promise<T> {
      // `firstMatchingSelector` 用「遍历候选选择器返回第一个命中的」来探测；
      // `readInputValue` 则要找带 `.value` 的元素。这里按这两个真实用法回话。
      if (expression.includes("return selector")) return "textarea[placeholder*=\"标题\"]" as unknown as T;
      if (expression.includes(".value")) return value as unknown as T;
      return null as unknown as T;
    },
    async waitForSelector() { return undefined; },
    keyboard: {
      async type(text: string) { value += maybeSwallow(text, options.insertTextAlsoSwallows === true); },
      async press(key: string) {
        calls.push(`press:${key}`);
        if (key.endsWith("+A")) return;
        if (key === "Backspace") value = "";
      },
      async insertText(text: string) { calls.push("insertText"); value += swallow(text); },
    },
  } as unknown as ToutiaoPublishPageLike;

  return { page, calls };
}

const PUBLISH_PAGE_URL = "https://mp.toutiao.com/profile_v4/graphic/publish";
const REAL_WORLD_TITLE = "Ponytail：专治 AI 过度设计的开源 Skill";

test("标题写入丢一个字符（真机那次）时，fillTitle 会重试并最终读回一致", async () => {
  // 真机现象：同一条标题、同一种写法，这次丢一个空格被拦下，下次又好了 —— 所以修复的要点是
  // 「换个更稳的写法 + 读回复核 + 给第二次机会」，而不是假设某一种写法永远对。
  const { page, calls } = imeSwallowingPage({ swallowWrites: 1 });

  await fillTitle(page, REAL_WORLD_TITLE);

  const value = await page.evaluate<string>(`document.querySelector('textarea').value`);
  assert.equal(value, REAL_WORLD_TITLE);
  // 第一次尝试就用了**整体插入**（比逐字输入少一层竞态）。
  assert.ok(calls.includes("insertText"), `实际调用：${calls.join(",")}`);
});

test("两种输入方式都填不对时报错要给出字符级差异（便于照着实机校准）", async () => {
  const { page } = imeSwallowingPage({ insertTextAlsoSwallows: true });

  await assert.rejects(
    () => fillTitle(page, REAL_WORLD_TITLE),
    (error: unknown) => {
      assert.ok(error instanceof ToutiaoPageError);
      assert.equal(error.code, "toutiao_page_title_not_filled");
      // 报错必须自证：读到多少字、期望多少字，以及**从第几个字符开始不同**。
      assert.match(error.message, /读到 27 字/u);
      assert.match(error.message, /期望 28 字/u);
      assert.match(error.message, /第 \d+ 个字符/u);
      assert.match(error.message, /本次未提交任何内容/u);
      return true;
    },
  );
});

/**
 * 回归：**清空必须真的清空**（2026-09-18 真机探针抓到的既有 bug）。
 *
 * `clearInput` 原先同时按 `Meta+A` 与 `Control+A`。在 macOS 上 `Cmd+A` 是全选、`Ctrl+A` 是
 * Emacs 的「移到行首」——两个都按会把选区塌缩掉，Backspace 于是什么也删不掉：
 * 头条恢复上次草稿时标题会变成「旧标题+新标题」的拼接；给标题加「多次尝试」之后更直接表现为
 * **越写越长**（真机实测：一次调用写了 3 回，读回 112 字 = 28×4）。
 * 这个假页面按平台语义建模按键（选中后插入＝替换），所以它既能在 macOS 挂，也能在 Linux 挂。
 */
function prefilledPage(initial: string): { page: ToutiaoPublishPageLike; calls: string[] } {
  const calls: string[] = [];
  let value = initial;
  let selected = false;
  const selectAllKey = process.platform === "darwin" ? "Meta+A" : "Control+A";

  const write = (text: string) => {
    value = selected ? text : value + text;
    selected = false;
  };
  const page = {
    url: () => PUBLISH_PAGE_URL,
    async goto() { return undefined; },
    async click() { return undefined; },
    async type(_selector: string, text: string) { calls.push("type"); write(text); },
    async evaluate<T>(expression: string): Promise<T> {
      if (expression.includes("return selector")) return "textarea" as unknown as T;
      if (expression.includes(".value")) return value as unknown as T;
      return "" as unknown as T;
    },
    async waitForSelector() { return undefined; },
    keyboard: {
      async type(text: string) { write(text); },
      async press(key: string) {
        calls.push(`press:${key}`);
        if (key === selectAllKey) { selected = true; return; }
        if (key.endsWith("+A")) { selected = false; return; }
        if (key === "Backspace") { value = selected ? "" : value.slice(0, -1); selected = false; }
      },
      async insertText(text: string) { calls.push("insertText"); write(text); },
    },
  } as unknown as ToutiaoPublishPageLike;
  return { page, calls };
}

test("标题框里已有上次草稿时会被真正清空，不会拼成「旧标题+新标题」", async () => {
  const { page } = prefilledPage("上一条草稿的标题");

  await fillTitle(page, REAL_WORLD_TITLE);

  const value = await page.evaluate<string>(`document.querySelector('textarea').value`);
  assert.equal(value, REAL_WORLD_TITLE);
});

test("写入全部无效时失败，且框里不会堆叠出多份标题", async () => {
  // 两种写法都写不进去（模拟极端页面）：fillTitle 必须走完整条尝试阶梯后报错，
  // 而**每一次尝试前都要先清空** —— 否则真机上就会出现「读回 112 字 = 28×4」那种堆积
  //（2026-09-18 真机探针实测，根因是 clearInput 的按键序列在 macOS 上清不掉）。
  const { page } = prefilledPage("旧草稿标题");
  const broken = {
    ...page,
    async type() { return undefined; },
    keyboard: { ...page.keyboard, async insertText() { return undefined; } },
  } as unknown as ToutiaoPublishPageLike;

  await assert.rejects(
    () => fillTitle(broken, REAL_WORLD_TITLE),
    (error: unknown) => error instanceof ToutiaoPageError && error.code === "toutiao_page_title_not_filled",
  );
  const value = await broken.evaluate<string>(`document.querySelector('textarea').value`);
  assert.equal(value, "", `框里应当是空的，实际：${JSON.stringify(value)}`);
});

// ─── 「头条首发」：不需要勾时也要**真的去取消**（2026-09-20 用户真机实测）────────────────
//
// 用户真机提交被拦下的原文：
//   「「头条首发」在页面上是勾选状态，但本次并不需要勾选（可能是残留草稿）：已停在点「发布」之前」
// 拦住是对的（绝不能带着一个用户没选的声明发出去），但**只检查不尝试取消就不够**：
// 持久化 profile 会把上次草稿的勾选状态带回来（真机就是这样），而取消勾选是一次普通的、
// 可逆的点击 —— 应当照 `ensureWeitoutiaoUnchecked` 的范式：**先取消、读回确认、取消不掉才停**。

test("残留草稿把「头条首发」带成勾选时，会取消勾选并读回未勾选", { skip }, async () => {
  const { page } = await openFixture({ firstPublishChecked: true });
  assert.equal(await firstPublishIsChecked(page), true, "预置成勾选（模拟残留草稿）");

  await setFirstPublish(page, false);

  assert.equal(await firstPublishIsChecked(page), false);
});

test("「头条首发」取消不掉时报错并停在发布之前（绝不带着没选的声明发出去）", { skip }, async () => {
  const { page } = await openFixture({ firstPublishChecked: true, lockFirstPublish: true });

  await assert.rejects(
    () => setFirstPublish(page, false),
    (error: unknown) => error instanceof ToutiaoPageError && error.code === "toutiao_page_first_publish_uncheck_failed",
  );
  // 关键：一个发布按钮都没被点过（fixture 里点过什么全都记在 window.__clicked）。
  assert.deepEqual(await page.evaluate<string[]>(`window.__clicked`), []);
});

test("「头条首发」本来就是未勾选时不点任何东西（无谓点击会带来状态漂移的风险）", { skip }, async () => {
  const { page } = await openFixture();

  await setFirstPublish(page, false);

  assert.equal(await firstPublishIsChecked(page), false);
  assert.deepEqual(await page.evaluate<string[]>(`window.__clicked`), []);
});

// ─── 「点了确认但读不到判据」必须自带侦察证据（2026-09-20 真机成功那一次的教训）──────────
//
// 用户真机第一次**真的发出去**了，但应用记的是 `verification: "unconfirmed"` —— 因为确认按钮
// 被候选文案命中了、页面上却没有任何我们认识的成功文案。如实记 unconfirmed 是对的（绝不谎报），
// 可是**当时页面长什么样没被记下来**，于是「成功提示到底是什么文案」只能靠人回忆。
// 现在把「确认后的 URL + 页面可见文案摘要」一起带回去，下一次真机跑一把就能校准。

test("确认后读不到成功判据时，返回「确认后页面」的证据（URL + 可见文案摘要）", { skip }, async () => {
  const { page } = await openFixture({ confirm: true, silent: true });

  const result = await submitAndConfirm(page);

  assert.equal(result.confirmClicked, true, "确认按钮必须被点到（候选文案命中）");
  assert.equal(result.signal, "", "页面没有成功文案 → 判据必须为空，绝不谎报");
  assert.match(result.postConfirm.url, /toutiao-publish-page\.html/u);
  // fixture 跑在 `file://` 上，URL 里没有发布页路径 —— 这里只要求它是布尔值且如实反映 URL；
  // 「何时算离开发布页」由下面那条纯函数用例钉住。
  assert.equal(typeof result.postConfirm.leftPublishPage, "boolean");
  assert.ok(result.postConfirm.excerpt.length > 0, "必须留下页面可见文案摘要供校准");
});

test("确认后有成功文案时，判定为 confirmed 且同样带上页面证据", { skip }, async () => {
  const { page } = await openFixture({ confirm: true });

  const result = await submitAndConfirm(page);

  assert.equal(result.confirmClicked, true);
  assert.equal(result.signal, "发布成功");
  assert.match(result.postConfirm.excerpt, /发布成功/u);
});

test("「是否离开发布页」只看 URL：停在本页为 false、跳到内容管理为 true（但绝不拿它冒充成功）", () => {
  assert.equal(hasLeftPublishPage("https://mp.toutiao.com/profile_v4/graphic/publish"), false);
  assert.equal(hasLeftPublishPage("https://mp.toutiao.com/profile_v4/graphic/publish?x=1"), false);
  // 发布被受理后会跳走 —— 这是旁证，不是判据：会话失效同样会跳到登录页，所以由上层决定怎么用。
  assert.equal(hasLeftPublishPage("https://mp.toutiao.com/profile_v4/graphic/articles"), true);
  assert.equal(hasLeftPublishPage("https://mp.toutiao.com/auth/page/login"), true);
});
