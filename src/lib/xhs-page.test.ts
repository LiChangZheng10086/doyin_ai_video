/**
 * 小红书发布页**页面步骤**测试：用**真实 Playwright** 驱动离线 fixture 页。
 *
 * fixture（`src/lib/fixtures/xhs-publish-page.html`）是**按真实快照的结构复刻**的
 *（页签 `.creator-tab`、`.d-text` 标题框与那句 placeholder、TipTap 编辑器、`div.d-select-wrapper`
 * 声明下拉与「笔记含AI合成内容」选项、**3 个 file 框**、以及 `<xhs-publish-btn>` 的 **closed shadow root**），
 * 所以这里断言的是「选择器是否命中真实标记 + 读回纪律是否成立」，而不是"自己写完自己断言"。
 *
 * 覆盖不到的部分（fixture 复刻不了的**动态**行为）：真实上传的服务器往返、话题联想弹层的 DOM、
 * 点「发布」之后的确认页 —— 前两者由真机演练覆盖，后者**按设计根本不做**（spec §9）。
 *
 * 没有可用浏览器时**跳过**（与 `toutiao-page.test.ts` 同一惯例）。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { resolveXhsBrowserTarget, type XhsBrowserTarget } from "./xhs-browser.js";
import {
  XHS_AI_DECLARATION_TEXT,
  XHS_SELECTORS,
  XhsPageError,
  clickSubmit,
  describeDifference,
  ensureImageTab,
  fillBody,
  fillTitle,
  selectAiDeclaration,
  uploadImages,
  type XhsPublishPageLike,
} from "./xhs-page.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "xhs-publish-page.html");
const fixtureUrl = pathToFileURL(fixturePath).href;
const target = resolveXhsBrowserTarget({ repoRoot: path.resolve(fileURLToPath(import.meta.url), "../../..") });
const skip = target ? false : "本机没有可用的 Playwright 浏览器：先跑 npm run prepare:package:mac 或 npx playwright install chromium";

const tempDirs: string[] = [];
const harnesses: Array<{ close(): Promise<void> }> = [];
after(async () => {
  await Promise.all(harnesses.map((item) => item.close().catch(() => undefined)));
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeImage(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "xhs-page-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  // 内容不重要：fixture 的 change 处理只看 files.length。
  await writeFile(file, Buffer.alloc(32, 1));
  return file;
}

async function openFixture(params: Record<string, string> = {}): Promise<{ page: XhsPublishPageLike; raw: unknown }> {
  const { chromium } = await import("playwright");
  const launchOptions: Parameters<typeof chromium.launch>[0] = { headless: true };
  const resolved = target as XhsBrowserTarget;
  if (resolved.kind === "executablePath") launchOptions.executablePath = resolved.path;
  if (resolved.kind === "channel") launchOptions.channel = resolved.channel;

  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  const query = new URLSearchParams(params).toString();
  await page.goto(query ? `${fixtureUrl}?${query}` : fixtureUrl, { waitUntil: "domcontentloaded" });

  const harness = { close: () => browser.close() };
  harnesses.push(harness);
  return { page: page as unknown as XhsPublishPageLike, raw: page };
}

test("fixture 的标题框与真页同形（placeholder 就是「填写标题会有更多赞哦」）", { skip }, async () => {
  const { page } = await openFixture();
  await uploadImages(page, [await makeImage("a.png")]);

  const placeholder = await page.evaluate<string>(
    `document.querySelector(${JSON.stringify(XHS_SELECTORS.titleInput)}).getAttribute("placeholder")`,
  );
  assert.equal(placeholder, "填写标题会有更多赞哦");
});

test("⚠️ 两阶段渲染：**没上传图片时标题框根本不存在**，报错必须点明「先上传图片」", { skip }, async () => {
  const { page } = await openFixture();
  await ensureImageTab(page);

  // 未上传：fixture 与真页一样，表单整块还没渲染出来。
  assert.equal(await page.locator(XHS_SELECTORS.titleInput).count(), 0);

  await assert.rejects(
    () => fillTitle(page, "标题"),
    (error: unknown) =>
      error instanceof XhsPageError &&
      error.code === "xhs_page_title_missing" &&
      error.message.includes("先上传图片"),
  );
});

test("上传：**必须按 accept 挑图片框**（页面上有 3 个 file 框，第一个是文档框）", { skip }, async () => {
  const { page } = await openFixture();
  // fixture 里第一个 file 框是 `.pdf/.doc`：取 `.first()` 会挑到它，计数就不会增加。
  assert.equal(await page.locator('input[type="file"]').count(), 3);

  const result = await uploadImages(page, [await makeImage("01.png"), await makeImage("02.png")]);
  assert.equal(result.uploaded, 2);
  assert.equal(await page.locator(XHS_SELECTORS.imagePreview).count(), 2);
});

test("上传：文件送进去了但平台没接住（计数不增加）→ 明确报错，绝不当作成功", { skip }, async () => {
  const { page } = await openFixture({ uploadFails: "1" });
  const image = await makeImage("a.png");
  await assert.rejects(
    () => uploadImages(page, [image]),
    (error: unknown) =>
      error instanceof XhsPageError &&
      error.code === "xhs_page_upload_not_confirmed" &&
      error.message.includes("停在点发布之前"),
  );
});

test("上传：超过 18 张直接拒绝（平台上限），且**一个文件都不送**", { skip }, async () => {
  const { page } = await openFixture();
  const many = await Promise.all(Array.from({ length: 19 }, (_unused, index) => makeImage(`${index}.png`)));
  await assert.rejects(
    () => uploadImages(page, many),
    (error: unknown) => error instanceof XhsPageError && error.code === "xhs_page_too_many_images",
  );
  assert.equal(await page.locator(XHS_SELECTORS.imagePreview).count(), 0);
});

test("标题：正常填入并读回逐字相等", { skip }, async () => {
  const { page } = await openFixture();
  await uploadImages(page, [await makeImage("a.png")]);

  await fillTitle(page, "三分钟讲清楚一件事");
  const value = await page.evaluate<string>(`document.querySelector(${JSON.stringify(XHS_SELECTORS.titleInput)}).value`);
  assert.equal(value, "三分钟讲清楚一件事");
});

test("标题：预置了旧草稿标题时**必须先清空**（否则会拼成「旧标题+新标题」）", { skip }, async () => {
  const { page } = await openFixture({ oldTitle: "1" });
  await uploadImages(page, [await makeImage("a.png")]);

  await fillTitle(page, "新标题");
  const value = await page.evaluate<string>(`document.querySelector(${JSON.stringify(XHS_SELECTORS.titleInput)}).value`);
  assert.equal(value, "新标题", "清空没生效 —— macOS 上多按一个 Ctrl+A 就会这样（把选区塌缩掉）");
});

test("标题：写入丢字符时**换写法重试**，最终读回仍然相等", { skip }, async () => {
  const { page } = await openFixture({ titleDrops: "1" });
  await uploadImages(page, [await makeImage("a.png")]);

  await fillTitle(page, "标题里有空格 也有标点");
  const value = await page.evaluate<string>(`document.querySelector(${JSON.stringify(XHS_SELECTORS.titleInput)}).value`);
  assert.equal(value, "标题里有空格 也有标点");
});

test("标题：怎么都写不进去 → 报**字符级差异**且不提交", { skip }, async () => {
  const { page } = await openFixture({ titleDrops: "always" });
  await uploadImages(page, [await makeImage("a.png")]);

  await assert.rejects(
    () => fillTitle(page, "一二三四五六七八"),
    (error: unknown) =>
      error instanceof XhsPageError &&
      error.code === "xhs_page_title_mismatch" &&
      error.message.includes("第 4 个字符起") &&
      error.message.includes("没有提交任何内容"),
  );
});

test("describeDifference 给出字符级差异（只报字数没法排查）", () => {
  assert.match(describeDifference("abcdef", "abcXef"), /第 4 个字符起不同/);
  assert.match(describeDifference("abcdef", "abc"), /少了内容/);
  assert.match(describeDifference("abc", "abcdef"), /多了内容/);
  assert.equal(describeDifference("abc", "abc"), "第 4 个字符起多了内容：多了 \"\"");
});

test("正文：写入后读回**首段与末段都在**", { skip }, async () => {
  const { page } = await openFixture();
  await uploadImages(page, [await makeImage("a.png")]);

  await fillBody(page, "第一段：开头。\n\n中间还有一段。\n\n最后一段：结尾。");
  const text = await page.evaluate<string>(`document.querySelector(${JSON.stringify(XHS_SELECTORS.bodyEditor)}).textContent`);
  assert.match(text, /第一段：开头。/u);
  assert.match(text, /最后一段：结尾。/u);
});

test("AI 声明：选中「笔记含AI合成内容」并读回", { skip }, async () => {
  const { page } = await openFixture();
  await uploadImages(page, [await makeImage("a.png")]);

  await selectAiDeclaration(page);
  const text = await page.evaluate<string>(
    `document.querySelector(${JSON.stringify(XHS_SELECTORS.declarationSelect)}).textContent.trim()`,
  );
  assert.equal(text, XHS_AI_DECLARATION_TEXT);
});

test("AI 声明不存在 → **fail closed**（拒绝自动提交，而不是发一条没标识的 AI 笔记）", { skip }, async () => {
  const { page } = await openFixture({ noAiOption: "1" });
  await uploadImages(page, [await makeImage("a.png")]);

  await assert.rejects(
    () => selectAiDeclaration(page),
    (error: unknown) =>
      error instanceof XhsPageError &&
      error.code === "xhs_page_ai_declaration_missing" &&
      error.message.includes("拒绝自动提交"),
  );
});

test("AI 声明选不中 → fail closed 且**一个提交类按钮都没被点过**", { skip }, async () => {
  const { page } = await openFixture({ lockAi: "1" });
  await uploadImages(page, [await makeImage("a.png")]);

  await assert.rejects(
    () => selectAiDeclaration(page),
    (error: unknown) => error instanceof XhsPageError && error.code === "xhs_page_ai_declaration_not_selected",
  );
  const clicked = await page.evaluate<string>(`document.documentElement.dataset.lastClick || ""`);
  assert.equal(clicked, "");
});

test("⚠️ 提交控件：**选择器定位必然失败**（closed shadow root），只能靠坐标", { skip }, async () => {
  const { raw, page: api } = await openFixture();
  // 宿主和表单一样是**上传之后才出现**的（真页实测），所以这里先上传。
  await uploadImages(api, [await makeImage("a.png")]);
  const page = raw as import("playwright").Page;
  // 宿主在 light DOM 里，找得到。
  assert.equal(await page.locator(XHS_SELECTORS.submitHost).count(), 1);
  // 但里面的按钮在 closed shadow root 里：CSS / role / 文本三种定位**全部为 0**。
  assert.equal(await page.getByRole("button", { name: "发布", exact: true }).count(), 0);
  assert.equal(await page.locator("xhs-publish-btn >> text=发布").count(), 0);
  assert.equal(await page.locator("xhs-publish-btn button").count(), 0);
});

test("提交：按宿主偏移点中「发布」（而不是旁边的「暂存离开」）", { skip }, async () => {
  const { page } = await openFixture();
  await uploadImages(page, [await makeImage("a.png")]);

  const result = await clickSubmit(page, "publish");
  assert.equal(result.clicked, true);
  assert.equal(await page.evaluate<string>(`document.documentElement.dataset.lastClick || ""`), "publish");
});

test("提交：`save` 模式点的是「暂存离开」（姿态乙的显式存草稿按钮）", { skip }, async () => {
  const { page } = await openFixture();
  await uploadImages(page, [await makeImage("a.png")]);

  await clickSubmit(page, "save");
  assert.equal(await page.evaluate<string>(`document.documentElement.dataset.lastClick || ""`), "save");
});

test("提交：按钮禁用时**不点**，并明确报错", { skip }, async () => {
  const { page } = await openFixture({ submitDisabled: "1" });
  await uploadImages(page, [await makeImage("a.png")]);

  await assert.rejects(
    () => clickSubmit(page, "publish"),
    (error: unknown) => error instanceof XhsPageError && error.code === "xhs_page_submit_disabled",
  );
  assert.equal(await page.evaluate<string>(`document.documentElement.dataset.lastClick || ""`), "");
});

test("提交：控件不存在 → 明确报错并说明它只在上传后出现", { skip }, async () => {
  const { page } = await openFixture({ noSubmit: "1" });
  // 先上传，确保这条测的是「表单已渲染但没有提交控件」，而不是「表单还没渲染」。
  await uploadImages(page, [await makeImage("a.png")]);
  await assert.rejects(
    () => clickSubmit(page, "publish"),
    (error: unknown) =>
      error instanceof XhsPageError &&
      error.code === "xhs_page_submit_missing" &&
      error.message.includes("上传图片之后"),
  );
});
