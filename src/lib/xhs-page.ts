/**
 * 小红书发布页**页面步骤**：选择器与每一步的读回校验。
 *
 * 选择器全部来自 2026-09-20 的只读侦察实测（不是照抄参考项目 —— 那 4 个实现的标题选择器
 * 只在「上传图片之后」才有效，而它们的发布按钮选择器**全部失效**，见下）。证据：
 * `storage/xhs/recon/selectors-after-upload.json`、`submit-host.png`。
 *
 * ### 三条必须记住的事实（都是实测，不是推测）
 *
 * ① **页面分阶段渲染**：**先上传图片，标题/正文/声明/提交才存在于 DOM**。
 *    所以在「未上传」阶段找标题框，得到的是 0 命中 —— 那不是「页面改版」，是顺序错了。
 *
 * ② **提交控件不是 `<button>`，而是 `<xhs-publish-btn>` 自定义元素 + closed shadow root**：
 *
 * ```html
 * <xhs-publish-btn is-publish="true" is-save-draft="true"
 *   submit-text="发布" save-text="暂存离开" submit-disabled="false">
 * ```
 *
 *    `customElements.get()` 有定义，但 `element.shadowRoot === null` 且无子节点 ⇒
 *    `page.content()` 序列化不到、`document.querySelectorAll` 看不到、**Playwright 的
 *    CSS / role 定位器也不穿透**（实测 `getByRole("button", { name: "发布" })` = 0）。
 *    ⇒ 只能**按宿主包围盒 + 相对偏移做坐标点击**。**这不是偷懒，是没有别的办法**；
 *    用例里有一条专门断言「选择器定位必然失败」，把这件事锁进测试。
 *    失败模式是良性的：偏移若落到「暂存离开」，结果是**存草稿离开**，不会误发。
 *
 * ③ **清空输入框只按一个全选键**：macOS 上 `Cmd+A` 是全选，而 `Ctrl+A` 是「移到行首」，
 *    会把选区塌缩掉，后续 Backspace 什么都删不掉（头条那轮真机实测踩过）。**别加第二个全选键。**
 *
 * ### 本模块**不做**的事
 * 点完提交之后**不做任何读回**（不抓 URL、不轮询成功文案）—— 见 spec §9：
 * `xiaohongshu-mcp` #715 报「让 AI 确认发布成功了没有 → 第一次警告第二次七天」。
 */

/** 页面侧代码**必须是字符串**（tsx/esbuild 会给内联函数包 `__name(...)` 助手 → 页面里 `ReferenceError`）。 */

export type XhsPageErrorCode =
  | "xhs_page_image_tab_missing"
  | "xhs_page_upload_input_missing"
  | "xhs_page_no_images"
  | "xhs_page_upload_not_confirmed"
  | "xhs_page_too_many_images"
  | "xhs_page_title_missing"
  | "xhs_page_title_mismatch"
  | "xhs_page_body_missing"
  | "xhs_page_body_not_confirmed"
  | "xhs_page_ai_declaration_missing"
  | "xhs_page_ai_declaration_not_selected"
  | "xhs_page_submit_missing"
  | "xhs_page_submit_disabled"
  | "xhs_page_submit_click_failed"
  | "xhs_page_draft_not_confirmed";

export class XhsPageError extends Error {
  readonly status = 422;

  constructor(
    readonly code: XhsPageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "XhsPageError";
  }
}

/** 实测命中的选择器（每条都有证据，别凭感觉改）。 */
export const XHS_SELECTORS = {
  /** 页签容器；实际点击的是里面文案为「上传图文」的**叶子节点**。 */
  tabs: ".creator-tab",
  /**
   * 图片上传框：**必须按 `accept` 挑**。
   * 真页共有 3 个 `input[type=file]`（2 个图片 + 1 个文档 `.pdf/.doc/.docx/.ppt/.pptx`），
   * 取 `.first` 会挑到别的框。
   */
  uploadInput: 'input[type="file"][accept*=".jpg"]',
  /** 标题：真页 placeholder 原文「填写标题会有更多赞哦」。 */
  titleInput: 'input.d-text[placeholder*="标题"]',
  /** 正文：TipTap（`ql-editor` 是 Quill 时代残留，真页已无）。 */
  bodyEditor: "div.tiptap.ProseMirror[contenteditable='true'], div.ProseMirror[contenteditable='true']",
  /** 话题入口：是**工具栏按钮**，不是在编辑器里打 `#`（参考项目在这一点上集体错）。 */
  topicButton: "button#topicBtn",
  /**
   * 内容类型声明：`.d-select-wrapper`。
   * ⚠️ 真页把这个元素的属性写成了 **`lass="declaration-wrapper"`**（笔误），
   * 所以**不能**按 `class="declaration-wrapper"` 去选。
   */
  declarationSelect: "div.d-select-wrapper",
  declarationOption: "div.d-option",
  /** 已上传图片的预览项（用来读回"图片到底进去了没有"）。 */
  imagePreview: ".img-preview-area .pr",
  /** 提交控件宿主（自定义元素，按钮在它的 closed shadow root 里）。 */
  submitHost: "xhs-publish-btn",
} as const;

/** AI 合成内容标识的**真实选项文案**（实测；2026-02-12 公告要求，未标识会被限制分发）。 */
export const XHS_AI_DECLARATION_TEXT = "笔记含AI合成内容";

/**
 * 提交控件两个按钮的**相对偏移**（相对宿主包围盒）。
 *
 * 来源：真页宿主机 680×90，按钮 124×42、top 24；「发布」中心 x=413 → **0.607**，
 * 「暂存离开」中心 x=269 → **0.396**，两个的 y 都是 45 → **0.5**（证据 `submit-host.png`）。
 */
export const XHS_SUBMIT_OFFSETS = {
  publish: { x: 0.607, y: 0.5 },
  save: { x: 0.396, y: 0.5 },
} as const;

/** 平台张数上限（实测「1/18」）。 */
export const XHS_MAX_IMAGES = 18;

/** 受控输入可能稍后才把模型值写回 `.value`，所以写完**先等一会儿再读回**。 */
const READ_BACK_DELAY_MS = 250;
const UPLOAD_CONFIRM_ATTEMPTS = 12;
const UPLOAD_CONFIRM_INTERVAL_MS = 1_000;

export interface XhsPublishLocator {
  count(): Promise<number>;
  first(): XhsPublishLocator;
  nth(index: number): XhsPublishLocator;
  click(options?: { timeout?: number }): Promise<void>;
  setInputFiles(paths: string | string[]): Promise<void>;
  inputValue(): Promise<string>;
  textContent(): Promise<string | null>;
  getAttribute(name: string): Promise<string | null>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

export interface XhsPublishPageLike {
  locator(selector: string): XhsPublishLocator;
  keyboard: {
    press(key: string): Promise<void>;
    insertText(text: string): Promise<void>;
  };
  mouse: { click(x: number, y: number): Promise<void> };
  waitForTimeout?(ms: number): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
}

async function pause(page: XhsPublishPageLike, ms: number): Promise<void> {
  await page.waitForTimeout?.(ms);
}

/** 字符级差异（只报字数没法排查 —— 头条那轮的教训）。 */
export function describeDifference(expected: string, actual: string): string {
  const limit = Math.min(expected.length, actual.length);
  for (let index = 0; index < limit; index += 1) {
    if (expected[index] !== actual[index]) {
      return `第 ${index + 1} 个字符起不同：读到 ${JSON.stringify(actual.slice(index, index + 12))}、期望 ${JSON.stringify(expected.slice(index, index + 12))}`;
    }
  }
  if (actual.length < expected.length) {
    return `第 ${actual.length + 1} 个字符起少了内容：少了 ${JSON.stringify(expected.slice(actual.length))}`;
  }
  return `第 ${expected.length + 1} 个字符起多了内容：多了 ${JSON.stringify(actual.slice(expected.length))}`;
}

/**
 * 进「上传图文」页签。
 *
 * 按**文本**匹配叶子节点（真页类名是哈希的，`span.title` 里的文案才是稳定特征）。
 */
export async function ensureImageTab(page: XhsPublishPageLike): Promise<void> {
  const clicked = await page.evaluate<string>(`(() => {
    const nodes = Array.from(document.querySelectorAll("div, span, li, a, [role='tab']"));
    const target = nodes.find(function (element) {
      if (element.children.length !== 0) return false;
      return (element.textContent || "").trim() === "上传图文";
    });
    if (!target) return "";
    target.click();
    return "ok";
  })()`).catch(() => "");

  await pause(page, 500);
  if (!clicked) {
    // 找不到页签时**不当作致命错误**：URL 带 `target=image` 时本来就已经在图文表单上。
    // 但要说清楚"没点到"，而不是假装点过了。
    const hasUpload = await page.locator(XHS_SELECTORS.uploadInput).count().catch(() => 0);
    if (hasUpload === 0) {
      throw new XhsPageError(
        "xhs_page_image_tab_missing",
        "没找到「上传图文」页签，也没看到图片上传框：页面结构可能已改版。请跑一次只读侦察"
          + "（`node --import tsx scripts/probe-xhs-publish-page.ts --tab`）核对选择器，不要盲目重试。",
      );
    }
  }
}

/** 找出**图片**上传框（按 accept 挑，优先带 `multiple` 的那个）。 */
async function resolveUploadInput(page: XhsPublishPageLike): Promise<XhsPublishLocator> {
  const candidates = [
    `${XHS_SELECTORS.uploadInput}[multiple]`,
    XHS_SELECTORS.uploadInput,
  ];
  for (const selector of candidates) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) return page.locator(selector).first();
  }
  throw new XhsPageError(
    "xhs_page_upload_input_missing",
    `没找到图片上传框（${XHS_SELECTORS.uploadInput}）：页面结构可能已改版，或当前不在图文表单上。`,
  );
}

/**
 * 上传图片并**读回计数**。
 *
 * 读回是必须的：真页的图片是**上传到服务器**的，`setInputFiles` 返回不代表平台接住了。
 * 计数上不去就明确报错，**绝不当作成功继续往下填表**。
 */
export async function uploadImages(page: XhsPublishPageLike, paths: string[]): Promise<{ uploaded: number }> {
  if (paths.length === 0) {
    throw new XhsPageError("xhs_page_no_images", "没有要上传的图片（paths 为空）：小红书图文至少要有一张图。");
  }
  if (paths.length > XHS_MAX_IMAGES) {
    throw new XhsPageError(
      "xhs_page_too_many_images",
      `本次要上传 ${paths.length} 张，超过小红书图文 ${XHS_MAX_IMAGES} 张的上限。`,
    );
  }

  const input = await resolveUploadInput(page);
  await input.setInputFiles(paths);

  for (let attempt = 0; attempt < UPLOAD_CONFIRM_ATTEMPTS; attempt += 1) {
    await pause(page, UPLOAD_CONFIRM_INTERVAL_MS);
    const uploaded = await page.locator(XHS_SELECTORS.imagePreview).count().catch(() => 0);
    if (uploaded >= paths.length) return { uploaded };
  }

  const uploaded = await page.locator(XHS_SELECTORS.imagePreview).count().catch(() => 0);
  throw new XhsPageError(
    "xhs_page_upload_not_confirmed",
    `图片送进去了但页面只显示 ${uploaded} 张（期望 ${paths.length} 张）：平台可能没接住。`
      + "**停在点发布之前**，请检查网络或图片格式后重试。",
  );
}

/**
 * 填标题：**先清空再写入**，然后读回，必须**逐字相等**。
 *
 * 为什么必须先清空：登录态是持久化 profile，平台可能恢复上次草稿把标题框预填
 *（真页实测会带回来），直接输入会拼成「旧标题+新标题」。
 * 为什么读回：写入是概率性丢字符的（头条那轮真机：同一条标题有时 28/28、有时丢一个空格）。
 */
export async function fillTitle(page: XhsPublishPageLike, title: string): Promise<void> {
  const input = page.locator(XHS_SELECTORS.titleInput).first();
  const count = await page.locator(XHS_SELECTORS.titleInput).count().catch(() => 0);
  if (count === 0) {
    throw new XhsPageError(
      "xhs_page_title_missing",
      "没找到标题框。⚠️ 页面是**分阶段渲染**的：**先上传图片**，标题框才会出现 —— 若图片还没上传，"
        + "请先调 `uploadImages()`；若图片已在页面上仍找不到，说明页面结构已改版，请跑只读侦察核对选择器。",
    );
  }

  await input.click({ timeout: 5_000 }).catch(() => undefined);
  // ⚠️ **只按一个全选键**（macOS 上 Ctrl+A 是「移到行首」，会把选区塌缩掉）。
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
    }
    await page.keyboard.insertText(title);
    await pause(page, READ_BACK_DELAY_MS);
    const readBack = await input.inputValue().catch(() => "");
    if (readBack === title) return;
    if (attempt === 2) {
      throw new XhsPageError(
        "xhs_page_title_mismatch",
        `标题框里读回的内容与要发的标题不一致（${describeDifference(title, readBack)}）。`
          + "本次**没有提交任何内容**。",
      );
    }
  }
}

/** 填正文（TipTap 富文本编辑器），并读回**首段与末段都在**。 */
export async function fillBody(page: XhsPublishPageLike, body: string): Promise<void> {
  const editor = page.locator(XHS_SELECTORS.bodyEditor).first();
  const count = await page.locator(XHS_SELECTORS.bodyEditor).count().catch(() => 0);
  if (count === 0) {
    throw new XhsPageError(
      "xhs_page_body_missing",
      "没找到正文编辑器（TipTap）。同样注意页面是**分阶段渲染**的：请先上传图片。",
    );
  }

  await editor.click({ timeout: 5_000 }).catch(() => undefined);
  await page.keyboard.insertText(body);
  await pause(page, READ_BACK_DELAY_MS);

  const paragraphs = body.split(/\n+/u).map((item) => item.trim()).filter(Boolean);
  const readBack = ((await editor.textContent()) ?? "").trim();
  const first = paragraphs[0] ?? "";
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const ok = (first.length === 0 || readBack.includes(first)) && (last.length === 0 || readBack.includes(last));
  if (!ok) {
    throw new XhsPageError(
      "xhs_page_body_not_confirmed",
      `正文读回不完整（读到 ${readBack.length} 字，期望含首段与末段）：读到 ${JSON.stringify(readBack.slice(0, 60))}…。`
        + "本次**没有提交任何内容**。",
    );
  }
}

/**
 * 勾选「笔记含AI合成内容」声明，并读回。
 *
 * **fail closed**：控件不存在、选项找不到、或选完读回不是它 —— 一律抛错，绝不继续提交。
 * 理由：我们的内容整条由 AI 生成，平台口径是「未主动标识 → 限制分发」，
 * 所以「发一条没标识的 AI 笔记」不是降级成功，而是**违规发布**。
 */
export async function selectAiDeclaration(page: XhsPublishPageLike): Promise<void> {
  const select = page.locator(XHS_SELECTORS.declarationSelect).first();
  const selectCount = await page.locator(XHS_SELECTORS.declarationSelect).count().catch(() => 0);
  if (selectCount === 0) {
    throw new XhsPageError(
      "xhs_page_ai_declaration_missing",
      `页面上找不到内容类型声明控件（${XHS_SELECTORS.declarationSelect}），无法声明「${XHS_AI_DECLARATION_TEXT}」。`
        + "按设计**拒绝自动提交**：我们的内容是 AI 生成的，未标识会被平台限制分发。",
    );
  }

  await select.click({ timeout: 5_000 }).catch(() => undefined);
  await pause(page, 500);

  const options = page.locator(XHS_SELECTORS.declarationOption);
  const optionCount = await options.count().catch(() => 0);
  let target: XhsPublishLocator | undefined;
  for (let index = 0; index < optionCount; index += 1) {
    // ⚠️ 必须用 `nth(index)` 逐项看：第一版写成「每轮都取 `.first()`」，
    // 那等于**从来没在找**，只要首项不是 AI 就永远选不中。
    const candidate = options.nth(index);
    const text = ((await candidate.textContent()) ?? "").trim();
    if (text.includes(XHS_AI_DECLARATION_TEXT)) {
      target = candidate;
      break;
    }
  }
  if (!target) {
    throw new XhsPageError(
      "xhs_page_ai_declaration_missing",
      `声明下拉里没有「${XHS_AI_DECLARATION_TEXT}」这一项（共 ${optionCount} 个选项）：`
        + "平台可能改了选项文案。按设计**拒绝自动提交**，请先跑只读侦察核对。",
    );
  }

  await target.click({ timeout: 5_000 }).catch(() => undefined);
  await pause(page, 500);
  const readBack = ((await select.textContent()) ?? "").trim();
  if (!readBack.includes("AI")) {
    throw new XhsPageError(
      "xhs_page_ai_declaration_not_selected",
      `点了「${XHS_AI_DECLARATION_TEXT}」但读回仍是 ${JSON.stringify(readBack)}：声明没选上。`
        + "按设计**拒绝自动提交**。",
    );
  }
}

/**
 * 点提交控件下的某一个按钮（`publish` 或 `save`）。
 *
 * ⚠️ **没有选择器可用**：`<xhs-publish-btn>` 是 closed shadow root（见文件头 ②）。
 * 所以按**宿主包围盒 + 相对偏移**用鼠标点，并在点之前校验
 * ① 宿主存在 ② `submit-disabled` 不是 `"true"`。
 *
 * **点完不做任何读回**（spec §9）—— 这是刻意偏离头条范式的一处。
 */
export async function clickSubmit(
  page: XhsPublishPageLike,
  mode: "publish" | "save" = "publish",
): Promise<{ clicked: boolean }> {
  const host = page.locator(XHS_SELECTORS.submitHost).first();
  const count = await page.locator(XHS_SELECTORS.submitHost).count().catch(() => 0);
  if (count === 0) {
    throw new XhsPageError(
      "xhs_page_submit_missing",
      `页面上找不到提交控件（${XHS_SELECTORS.submitHost}）。⚠️ 它**只在上传图片之后**才出现。`
        + "本次**没有提交任何内容**。",
    );
  }

  const disabledAttribute = mode === "publish" ? "submit-disabled" : "save-disabled";
  const disabled = (await host.getAttribute(disabledAttribute).catch(() => null)) === "true";
  if (disabled) {
    throw new XhsPageError(
      "xhs_page_submit_disabled",
      `${mode === "publish" ? "发布" : "暂存"}按钮处于禁用状态（${disabledAttribute}="true"）：`
        + "内容可能还不满足平台要求（例如缺图/超长）。本次**没有提交任何内容**。",
    );
  }

  const box = await host.boundingBox().catch(() => null);
  if (!box) {
    throw new XhsPageError("xhs_page_submit_click_failed", "提交控件没有可见的包围盒，无法定位它的内部按钮。");
  }
  const offset = XHS_SUBMIT_OFFSETS[mode];
  const x = box.x + box.width * offset.x;
  const y = box.y + box.height * offset.y;
  try {
    await page.mouse.click(x, y);
  } catch (error) {
    throw new XhsPageError(
      "xhs_page_submit_click_failed",
      `坐标点击失败（${Math.round(x)},${Math.round(y)}）：${error instanceof Error ? error.message : String(error)}。`
        + "本次**没有提交任何内容**。",
    );
  }
  return { clicked: true };
}

/** 草稿仅在当前 profile 的 IndexedDB 中；等事务提交并核对内容后才能关浏览器。 */
export async function saveDraftAndConfirm(
  page: XhsPublishPageLike,
  expected: { title: string; body: string; imageCount: number },
): Promise<string> {
  const savedAfter = Date.now();
  await clickSubmit(page, "save");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await pause(page, 500);
    const draftId = await page.evaluate<string>(`(async () => {
      const expected = ${JSON.stringify(expected)};
      const uid = localStorage.getItem("snsWebPublishCurrentUser");
      if (!uid || !(await indexedDB.databases()).some(db => db.name === "draft-database-v1")) return "";
      return new Promise((resolve, reject) => {
        const request = indexedDB.open("draft-database-v1");
        let db;
        const timer = setTimeout(() => { if (db) db.close(); reject(new Error("草稿读取超时")); }, 2000);
        const finish = (value) => { clearTimeout(timer); if (db) db.close(); resolve(value); };
        request.onerror = () => finish("");
        request.onsuccess = () => {
          db = request.result;
          if (!db.objectStoreNames.contains("image-draft")) return finish("");
          const tx = db.transaction("image-draft", "readonly");
          const read = tx.objectStore("image-draft").getAll();
          let found = "";
          const normalize = text => text.replace(/\\u200b/gu, "").replace(/\\s+/gu, " ").trim();
          read.onsuccess = () => {
            const match = read.result.find(record => {
              const draft = record.content && record.content.draftStore;
              const setting = record.content && record.content.settingStore;
              if (!draft || record.uid !== uid || typeof record.timeStamp !== "number" || record.timeStamp < ${savedAfter}) return false;
              const html = new DOMParser().parseFromString(draft.descInnerHTML || "", "text/html");
              html.querySelectorAll("p, div, br, li").forEach(element => { element.prepend(" "); element.append(" "); });
              const text = html.body.textContent || "";
              return typeof record.draftId === "string" && record.draftId.length > 0
                && draft.title === expected.title && normalize(text) === normalize(expected.body)
                && Array.isArray(draft.imgList) && draft.imgList.length === expected.imageCount
                && draft.imgList.every(image => image && typeof image.fileId === "string" && image.fileId.length > 0)
                && setting && setting.userDeclaration && setting.userDeclaration.origin === 2;
            });
            if (match) found = match.draftId;
          };
          tx.oncomplete = () => finish(found);
          tx.onabort = tx.onerror = () => finish("");
        };
      });
    })()`).catch(() => "");
    if (draftId) return draftId;
  }
  throw new XhsPageError("xhs_page_draft_not_confirmed",
    "未能确认完整草稿已保存：浏览器本地草稿的标题、正文、图片或 AI 声明与本次内容不一致。"
    + "本次没有点发布；请点「打开小红书草稿浏览器」检查图文草稿，勿把填表成功当作保存成功。");
}
