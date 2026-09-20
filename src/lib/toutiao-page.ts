/**
 * 今日头条发布页的页面步骤与选择器（**唯一真源**）。
 *
 * 选择器**全部来自 2026-09-18 的只读侦察实测**（`scripts/probe-toutiao-publish-page.ts`，
 * 产物在 `storage/toutiao/recon/`），不是照抄参考项目：
 *
 * | 位置 | 实测证据 |
 * | --- | --- |
 * | 标题框 | `textarea[placeholder*="标题"]` → 命中 1，placeholder 原文「请输入文章标题（2～30个字）」 |
 * | 正文编辑器 | `.ProseMirror` → 命中 1（`[contenteditable="true"]` 同一元素）；**富文本粘贴实测有效** |
 * | 封面 | `.article-cover-add`（带加号的 div，点击才现造出文件框）；模式单选 `单图`(默认选中)/`三图`/`无封面`；上传后出现 `.article-cover-img-wrap img` |
 * | 头条首发 | `LABEL.byte-checkbox.checkbot-item`，文案「头条首发」，**默认未勾选** |
 * | 同时发布微头条 | `LABEL.byte-checkbox.item-checkbox`，文案「**发布得更多收益**」，**默认带 `byte-checkbox-checked`（= 平台默认勾选）** |
 * | 作品声明 | `SPAN.byte-checkbox-group` 内 7 个 LABEL，文案与 `TOUTIAO_DECLARATIONS` **逐字一致** |
 * | 发布按钮 | `BUTTON.publish-btn.publish-btn-last`，文案「预览并发布」；页面上**没有**「发布」按钮（确认在预览页里） |
 *
 * 两条纪律（参考项目的反面，见 `docs/research/toutiao-ops-assessment.md` §3）：
 *
 * 1. **每一步都读回校验**：标题填完读回 `value`、正文粘完读回编辑器纯文本、封面传完读回封面上出现了图、
 *    「同时发布微头条」点完读回勾选状态 —— 参考项目把这些全 `try{}catch{}` 吞掉了，
 *    结果是封面失败也报「发布成功」。
 * 2. **页面侧代码一律用字符串下发**：tsx/esbuild 会给内联箭头函数包上 `__name(...)` 助手，
 *    而 Playwright 是把**函数源码**丢进页面执行的 → 页面里没有 `__name`，直接 `ReferenceError`。
 *    `dist/` 由 tsc 编译不注入该助手，所以这个坑**只在 tsx 下**出现（脚本与测试都跑 tsx）。
 */

/** 登录/导航用得到的最小页面面（runner 的登录会话也用它）。 */
export interface ToutiaoPageLike {
  url(): string;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  waitForTimeout?(ms: number): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
}

/** 原生文件选择框（Playwright 的 `FileChooser`）。 */
export interface ToutiaoFileChooserLike {
  setFiles(files: string): Promise<void>;
}

/** 发布流程额外需要的动作（假页面只实现这几件就够）。 */
export interface ToutiaoPublishPageLike extends ToutiaoPageLike {
  click(selector: string, options?: { timeout?: number; force?: boolean }): Promise<void>;
  type(selector: string, text: string, options?: { delay?: number }): Promise<void>;
  setInputFiles(selector: string, files: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: string }): Promise<unknown>;
  /**
   * 等原生文件选择框。**实测必需**：真页点封面加号后 DOM 里始终没有 `input[type=file]`
   * （计数 0、也没有抽屉节点），说明它是「临时造一个 input → 触发原生选择框 → 移除」，
   * 所以只能靠这个事件接手，`setInputFiles(selector)` 在真机上会拿不到元素。
   */
  waitForEvent?(name: "filechooser", options?: { timeout?: number }): Promise<ToutiaoFileChooserLike>;
  keyboard: {
    type(text: string, options?: { delay?: number }): Promise<void>;
    press(key: string): Promise<void>;
    /**
     * **一次性插入**（不逐键、不经过输入法组合）。中文全角标点走逐字 `type` 时会被组合态吞字符
     * （真机实测：`Ponytail：专治 AI …` 28 字读回 27 字，丢的是「：」后面那个空格）。
     * 省略时退回逐字输入（老假页面仍可用）。
     */
    insertText?(text: string): Promise<void>;
  };
}

export type ToutiaoPageErrorCode =
  | "toutiao_page_not_logged_in"
  | "toutiao_page_title_missing"
  | "toutiao_page_title_not_filled"
  | "toutiao_page_editor_missing"
  | "toutiao_page_body_not_filled"
  | "toutiao_page_cover_add_missing"
  | "toutiao_page_cover_upload_failed"
  | "toutiao_page_first_publish_missing"
  | "toutiao_page_first_publish_uncheck_failed"
  | "toutiao_page_declaration_missing"
  | "toutiao_page_weitoutiao_missing"
  | "toutiao_page_weitoutiao_unchecked_failed"
  | "toutiao_page_publish_button_missing";

export class ToutiaoPageError extends Error {
  readonly status = 422;

  constructor(
    readonly code: ToutiaoPageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToutiaoPageError";
  }
}

/** 复选框的「已勾选」类名（实测：`LABEL.byte-checkbox.item-checkbox.byte-checkbox-checked`）。 */
export const TOUTIAO_CHECKED_CLASS = "byte-checkbox-checked";

/**
 * 选择器候选表。**只在这里有一份**（页面步骤全部从这里取），改版时只改这一处。
 *
 * 候选列表里第一项是**实测命中的那个**；后面的只是同一语义的备选（改版时多点机会）。
 */
export const TOUTIAO_SELECTORS = {
  titleInputs: [
    'textarea[placeholder*="标题"]',
    'input[placeholder*="标题"]',
    'textarea[placeholder*="文章标题"]',
    '[class*="title"] textarea',
  ],
  editors: [".ProseMirror", '[contenteditable="true"]', '[class*="editor"] [contenteditable="true"]'],
  /** 封面「加号」：点击后才现造出文件框（实测页面里初始**没有** `input[type=file]`）。 */
  coverAdd: ["[class*='article-cover-add']", "[class*='article-cover'] [class*='add']"],
  /** 上传成功后出现的封面图（读回判据）。 */
  coverImage: "[class*='article-cover'] [class*='article-cover-img-wrap'] img",
  /** 封面模式单选：文案「单图」（LONG 值 2，默认选中）。 */
  coverSingleLabel: "单图",
  fileInput: 'input[type="file"]',
  /**
   * 上传抽屉（实测类名 `byte-drawer primary-drawer mp-ic-img-drawer`，文案含
   * 「上传图片 / 免费正版图片 / 热点图库 / 我的素材 / 本地上传 / 扫码上传」）。
   */
  drawer: "[class*='byte-drawer'], [class*='mp-ic-img-drawer']",
  /** 抽屉里的「本地上传」页签（点它才会弹原生文件选择框）。 */
  localUploadTexts: ["本地上传", "点击上传", "上传图片"],
  /**
   * 抽屉内的文件框：**全页有两个**（本地上传 + 扫码上传），必须限定在抽屉里并取第一个 ——
   * 裸 `input[type=file]` 会因为严格模式「多个匹配」直接报错（实测踩到过）。
   */
  drawerFileInput: "[class*='byte-drawer'] input[type='file']",
  publishButtons: ["预览并发布"],
  /**
   * 确认页的按钮文案。**刻意不含泛化的「确定」**：同页的封面抽屉等弹窗也有「确定」，
   * 一旦命中就会把「点到了别处的确定」误判成「已确认发布」（2026-09-18 由用例抓到）。
   */
  confirmButtons: ["确认发布", "发布"],
  drawerConfirmTexts: ["确定", "完成", "保存"],
  firstPublishTexts: ["头条首发"],
  /** 顺序有意义：**「发布得更多收益」才是那个勾选框的文案**（「同时发布微头条」是它旁边的说明）。 */
  weitoutiaoTexts: ["发布得更多收益", "同时发布微头条"],
  successTexts: ["发布成功", "已发布", "提交成功", "审核中"],
} as const;

/**
 * 把页面侧代码包成「立即执行」的字符串表达式（见文件头注释里的 `__name` 坑）。
 *
 * ⚠️ 页面代码里**不要声明名为 `input` 的变量**：参数名就是 `input`，同作用域重复声明 → SyntaxError。
 * 另外注释里也不要写反引号（模板字符串会被截断）。
 */
function pageExpression(body: string, arg?: unknown): string {
  return `((${arg === undefined ? "" : "input"}) => {${body}})(${arg === undefined ? "" : JSON.stringify(arg)})`;
}

/** 按精确文案点击（页面侧字符串实现）。 */
async function clickByText(
  page: ToutiaoPublishPageLike,
  texts: readonly string[],
  options: { tags?: string[]; scope?: string } = {},
): Promise<boolean> {
  return page.evaluate<boolean>(pageExpression(
    `
    const root = input.scope ? document.querySelector(input.scope) || document : document;
    const candidates = Array.from(root.querySelectorAll(input.tags.join(",")));
    for (const text of input.texts) {
      for (const element of candidates) {
        if ((element.textContent || "").trim() !== text) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        element.click();
        return true;
      }
    }
    return false;
    `,
    {
      texts: [...texts],
      tags: [...(options.tags ?? ["button", "[role='button']", "label", "span", "div"])],
      ...(options.scope ? { scope: options.scope } : {}),
    },
  ));
}

/**
 * 按精确文案点「带复选框的控件」。
 *
 * **为什么不能直接用 `clickByText`**（2026-09-18 由 fixture 用例抓到）：真页上
 * `div.exclusive-checkbox-wraper` 的文本也是「头条首发」，而它在文档序里排在那只
 * `LABEL.byte-checkbox` **前面** —— 按「第一个文案命中」点会点到不响应点击的外层 div，
 * 勾选状态毫无变化，而调用方以为已经勾上了。所以这里**优先点真正拥有 checkbox 的那个元素**。
 */
async function clickCheckboxByText(
  page: ToutiaoPublishPageLike,
  texts: readonly string[],
): Promise<boolean> {
  return page.evaluate<boolean>(pageExpression(
    `
    const elements = Array.from(document.querySelectorAll("label, span, div, button"));
    const pick = (matches) => {
      // 优先级：**拥有 checkbox 的 LABEL**（Byte 系控件的点击处理器挂在 label 上）→ INPUT 本身
      // → 任何包含 checkbox 的元素 → 第一个命中。
      // 实测教训：div.exclusive-checkbox-wraper 也「包含」checkbox，但点它不会切换状态
      // （fixture 用例抓到过一次；真页是同一个结构），所以不能只判「包含」。
      const byLabel = matches.find(function (element) {
        return element.tagName === "LABEL" && element.querySelector("input[type='checkbox']");
      });
      if (byLabel) return byLabel;
      const byInput = matches.find(function (element) {
        return element.tagName === "INPUT";
      });
      if (byInput) return byInput;
      const byContains = matches.find(function (element) {
        return Boolean(element.querySelector && element.querySelector("input[type='checkbox']"));
      });
      return byContains || matches[0];
    };
    for (const text of input) {
      const matches = elements.filter(function (element) {
        return (element.textContent || "").trim() === text;
      });
      if (matches.length === 0) continue;
      const target = pick(matches);
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      target.click();
      return true;
    }
    return false;
    `,
    [...texts],
  ));
}

/** 读回输入框的值。 */
async function readInputValue(page: ToutiaoPublishPageLike, selectors: readonly string[]): Promise<string> {
  return page.evaluate<string>(pageExpression(
    `
    for (const selector of input) {
      const element = document.querySelector(selector);
      if (element && typeof element.value === "string") return element.value;
    }
    return "";
    `,
    [...selectors],
  ));
}

/** 读回编辑器纯文本。 */
async function readEditorText(page: ToutiaoPublishPageLike, selectors: readonly string[]): Promise<string> {
  return page.evaluate<string>(pageExpression(
    `
    for (const selector of input) {
      const element = document.querySelector(selector);
      if (element) return (element.textContent || "").trim();
    }
    return "";
    `,
    [...selectors],
  ));
}

/** 找到第一个命中的选择器。 */
async function firstMatchingSelector(
  page: ToutiaoPublishPageLike,
  selectors: readonly string[],
): Promise<string | undefined> {
  const hit = await page.evaluate<string | null>(pageExpression(
    `
    for (const selector of input) {
      try {
        if (document.querySelector(selector)) return selector;
      } catch (error) {
        // 非法选择器直接跳过（不同版本的 DOM 结构可能让某个候选不合法）。
      }
    }
    return null;
    `,
    [...selectors],
  ));
  return hit ?? undefined;
}

/**
 * 读一个「复选框类」控件的勾选状态。
 *
 * 实测结构：`LABEL.byte-checkbox.item-checkbox.byte-checkbox-checked` 内含一个隐藏
 * `input[type=checkbox]`。所以判定顺序是：元素自身/后代里的 checkbox → 类名 → aria-checked。
 */
async function readCheckboxState(
  page: ToutiaoPublishPageLike,
  texts: readonly string[],
): Promise<{ found: boolean; checked: boolean }> {
  return page.evaluate<{ found: boolean; checked: boolean }>(pageExpression(
    `
    // **只认拥有 checkbox 的元素**（自身是 checkbox、或内部/本身就是那个 label）。
    // 这一步是 fail-closed 的关键：像「同时发布微头条」这种文案同时出现在说明用的
    // div.edit-label 上，而那只 div 没有 checkbox —— 如果把它当成命中就会得出
    // 「已经是未勾选」的结论，于是带着**平台默认的勾选**发出去（= 用户不知情多发一条微头条）。
    // 评审实测确认过：改掉 checkbox 的文案后旧实现不会抛错。
    const ownsCheckbox = (element) => {
      if (element.tagName === "INPUT" && element.type === "checkbox") return true;
      return Boolean(element.querySelector && element.querySelector("input[type='checkbox']"));
    };
    const readChecked = (element) => {
      if (element.tagName === "INPUT" && element.type === "checkbox") return element.checked;
      const inner = element.querySelector ? element.querySelector("input[type='checkbox']") : null;
      if (inner) return inner.checked;
      const aria = element.getAttribute ? element.getAttribute("aria-checked") : null;
      if (aria === "true" || aria === "false") return aria === "true";
      const className = (element.className || "").toString();
      return className.split(/\\s+/).includes(input.checkedClass);
    };
    const elements = Array.from(document.querySelectorAll("label, span, div"));
    for (const text of input.texts) {
      for (const element of elements) {
        if ((element.textContent || "").trim() !== text) continue;
        if (!ownsCheckbox(element)) continue;   // 说明性文案不算命中
        return { found: true, checked: readChecked(element) };
      }
    }
    return { found: false, checked: false };
    `,
    { texts: [...texts], checkedClass: TOUTIAO_CHECKED_CLASS },
  ));
}

/** 「头条首发」当前是否已勾选（默认未勾选，实测）。 */
export async function firstPublishIsChecked(page: ToutiaoPublishPageLike): Promise<boolean> {
  const state = await readCheckboxState(page, TOUTIAO_SELECTORS.firstPublishTexts);
  return state.found && state.checked;
}

/** 「同时发布微头条」当前是否已勾选（**平台默认就是勾选的**，实测）。 */
export async function weitoutiaoIsChecked(page: ToutiaoPublishPageLike): Promise<boolean> {
  const state = await readCheckboxState(page, TOUTIAO_SELECTORS.weitoutiaoTexts);
  return state.found && state.checked;
}

/**
 * 未登录判定：头条把首页与发布页**都 302 到** `/auth/page/login?redirect_url=…`（实测），
 * 另外 SSO 会跳到 `sso.toutiao.com`。**只有这一份**：早先页面模块只认前一个子串，
 * 于是 SSO 跳转会被报成「找不到标题输入框（页面结构可能已改版）」，把操作者指错方向。
 */
export function isLoginUrl(url: string): boolean {
  return url.includes("/auth/page/login") || url.includes("sso.toutiao.com");
}

/** 进发布页；被重定向回登录页时明确报错（不是「页面没加载出来」）。 */
export async function gotoPublishPage(page: ToutiaoPublishPageLike, publishUrl: string): Promise<void> {
  await page.goto(publishUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout?.(6_000);
  if (isLoginUrl(page.url())) {
    throw new ToutiaoPageError(
      "toutiao_page_not_logged_in",
      "头条号登录态已失效（发布页被重定向回登录页）：请到「设置 → 今日头条」重新扫码登录后再试。",
    );
  }
}

/**
 * 填标题：**两种输入方式各试一次**，每种都读回校验（实测 placeholder 自己就写着「2～30个字」）。
 *
 * 顺序是「整体插入 → 逐字输入」而不是反过来，原因是真机实测（2026-09-18）：
 * 标题 `Ponytail：专治 AI 过度设计的开源 Skill` 逐字 `type`（40ms/字）时，**全角冒号 `：`
 * 会让后面紧跟的空格进入输入法组合态被吞掉** —— 读回 27 字、期望 28 字，提交因此被拦下
 * （拦下是对的：绝不能把与预期不符的标题发出去）。`keyboard.insertText` 一次性插入、不走组合，
 * 实测能原样落进标题框；逐字输入留作兜底（老页面/假页面没有 `insertText` 时仍然可用）。
 */
export async function fillTitle(page: ToutiaoPublishPageLike, title: string): Promise<void> {
  const selector = await firstMatchingSelector(page, TOUTIAO_SELECTORS.titleInputs);
  if (!selector) {
    throw new ToutiaoPageError(
      "toutiao_page_title_missing",
      "在头条发布页上找不到标题输入框（页面结构可能已改版）：请按 AGENTS.md 的故障排查跑一次只读侦察脚本，不要盲目重试。",
    );
  }
  const wanted = title.trim();

  const writeByInsert = async () => {
    await clearInput(page, selector);
    await page.click(selector, { force: true });
    await page.keyboard.insertText!(title);
  };
  const writeByTyping = async () => {
    await clearInput(page, selector);
    await page.type(selector, title, { delay: 40 });
  };

  // **丢字符是概率性的**（真机那次丢了、下一次同样的写法又对了），所以按可靠性排序后
  // **多给几次机会**：整体插入两次（单次事件、不受逐键竞态影响），最后再退回逐字输入。
  const attempts: Array<() => Promise<void>> = [];
  if (typeof page.keyboard.insertText === "function") {
    attempts.push(writeByInsert, writeByInsert);
  }
  attempts.push(writeByTyping);

  let lastValue = "";
  for (const write of attempts) {
    // `clearInput` 自己会点一次输入框并全选删除；这里不必再点。
    await write();
    // **读回前先等一拍**：受控输入的页面可能在这之后才把自己模型里的值写回 `.value`，
    // 立刻读会读到半路状态（真机「读到 27 字」有一部分就是这样来的）。
    await page.waitForTimeout?.(250);
    const value = (await readInputValue(page, [selector])).trim();
    lastValue = value;
    if (value === wanted) return;
  }

  if (lastValue.length === 0) {
    throw new ToutiaoPageError(
      "toutiao_page_title_not_filled",
      "标题没有填进头条发布页的标题框（输入被拒绝或页面结构已变）：已停在点「发布」之前，本次未提交任何内容。",
    );
  }
  // 读到**一模一样**才算填对：只判非空会让「拼接出来的标题」蒙混过关（评审实测复现过）。
  throw new ToutiaoPageError(
    "toutiao_page_title_not_filled",
    `标题框里读回的内容与要发的标题不一致（读到 ${lastValue.length} 字、期望 ${[...wanted].length} 字，`
    + `${describeFirstDifference(lastValue, wanted)}）：已停在「发布」之前，本次未提交任何内容。`,
  );
}

/**
 * 指出**从第几个字符开始不同** —— 只说「读到的字数不对」没法判断是丢了空格、还是被输入法替换了标点。
 * 真机排查时这一句就是全部线索（2026-09-18 那次只报了字数，只能靠猜）。
 */
function describeFirstDifference(actual: string, expected: string): string {
  const actualChars = [...actual];
  const expectedChars = [...expected];
  const limit = Math.min(actualChars.length, expectedChars.length);
  for (let index = 0; index < limit; index += 1) {
    if (actualChars[index] !== expectedChars[index]) {
      return `第 ${index + 1} 个字符起不同：读到“${actualChars.slice(index, index + 8).join("")}”、期望“${expectedChars.slice(index, index + 8).join("")}”`;
    }
  }
  return actualChars.length < expectedChars.length
    ? `第 ${limit + 1} 个字符起少了内容：期望“${expectedChars.slice(limit).join("")}”`
    : `第 ${limit + 1} 个字符起多了内容：读到“${actualChars.slice(limit).join("")}”`;
}

/**
 * 清空输入框：**全选 + 删除 + 读回确认**（`fill("")` 在受控 textarea 上不总生效，键盘更可靠）。
 *
 * ⚠️ **不能同时按 `Meta+A` 和 `Control+A`**（2026-09-18 真机实测）：macOS 上 `Cmd+A` 是全选，
 * 而 `Ctrl+A` 是 Emacs 的「移到行首」——两个都按会把选区**塌缩掉**，紧随其后的 Backspace
 * 什么也删不掉。于是「先清空」形同虚设：头条恢复上次草稿时，标题会变成「旧标题+新标题」的拼接
 * （正是本函数当初要防的那件事），而我给标题加「多次尝试」之后更直接表现为**越写越长**
 * （真机探针实测：一次调用里写 3 回，读回 112 字 = 28×4）。
 */
async function clearInput(page: ToutiaoPublishPageLike, selector: string): Promise<void> {
  await page.click(selector, { force: true });
  const selectAll = process.platform === "darwin" ? "Meta+A" : "Control+A";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press(selectAll).catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);
    await page.waitForTimeout?.(150);
    if ((await readInputValue(page, [selector])).trim().length === 0) return;
  }
  // 键盘清不掉（受控输入可能把旧值写回 DOM）：用**原生 setter + input 事件**兜底，
  // 这样框架也能收到变更（直接改 `.value` 框架是看不见的）。
  await page.evaluate<string>(pageExpression(
    `
    for (const selector of input) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const prototype = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(element, "");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return element.value;
    }
    return "";
    `,
    [selector],
  ));
  await page.waitForTimeout?.(150);
}

/**
 * 填正文：先试**富文本粘贴**（`ClipboardEvent`，实测有效），读回失败再退回**逐段纯文本输入**。
 *
 * 返回实际生效的方式 —— 上层要如实记录（`bodyMode`）：「退化成了纯文本」意味着排版没了。
 */
export async function fillBodyHtml(
  page: ToutiaoPublishPageLike,
  articleHtml: string,
  paragraphs: string[],
): Promise<"rich" | "plain"> {
  const selector = await firstMatchingSelector(page, TOUTIAO_SELECTORS.editors);
  if (!selector) {
    throw new ToutiaoPageError(
      "toutiao_page_editor_missing",
      "在头条发布页上找不到正文编辑器（页面结构可能已改版）：请按 AGENTS.md 的故障排查跑一次只读侦察脚本。",
    );
  }

  await page.click(selector, { force: true });
  await page.waitForTimeout?.(500);
  const rich = await page.evaluate<boolean>(pageExpression(
    `
    const editor = document.querySelector(input.selector);
    if (!editor) return false;
    editor.focus();
    const before = (editor.textContent || "").length;
    const data = new DataTransfer();
    data.setData("text/html", input.html);
    data.setData("text/plain", input.text);
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    return (editor.textContent || "").length > before;
    `,
    { html: articleHtml, selector, text: paragraphs.join("\n") },
  ));

  if (rich && (await readEditorText(page, [selector])).length > 0) {
    await assertBodyLanded(page, selector, paragraphs);
    return "rich";
  }

  // 兜底：逐段输入（段落之间回车）。这条路排版会丢，但内容不会丢。
  for (const [index, paragraph] of paragraphs.entries()) {
    if (paragraph.length > 0) await page.keyboard.type(paragraph, { delay: 20 });
    if (index < paragraphs.length - 1) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout?.(120);
    }
  }
  const typed = await readEditorText(page, [selector]);
  if (typed.length === 0) {
    throw new ToutiaoPageError(
      "toutiao_page_body_not_filled",
      "正文没有填进头条编辑器（粘贴与逐段输入都失败了）：已停在点「发布」之前，本次未提交任何内容。",
    );
  }
  await assertBodyLanded(page, selector, paragraphs);
  return "plain";
}

/**
 * 正文落地校验：**首段与末段都要能在编辑器里找到**。
 *
 * 只判「编辑器非空」的话，一个残留的旧草稿也能让校验通过 —— 而发出去的是旧正文。
 * （不做逐字相等：编辑器会归一空白与标记，逐字比对会误报。）
 */
async function assertBodyLanded(
  page: ToutiaoPublishPageLike,
  selector: string,
  paragraphs: string[],
): Promise<void> {
  const meaningful = paragraphs.map((item) => item.trim()).filter((item) => item.length > 0);
  if (meaningful.length === 0) return;
  const head = meaningful[0]!;
  const tail = meaningful[meaningful.length - 1]!;
  const text = await readEditorText(page, [selector]);
  const normalize = (value: string) => value.replace(/\s+/gu, "");
  const flat = normalize(text);
  if (!flat.includes(normalize(head)) || !flat.includes(normalize(tail))) {
    throw new ToutiaoPageError(
      "toutiao_page_body_not_filled",
      "编辑器里的正文与要发的正文对不上（首段或末段没找到，可能是残留草稿）：已停在点「发布」之前，本次未提交任何内容。",
    );
  }
}

/**
 * 上传封面。
 *
 * 实测关键事实：页面初始**没有** `input[type=file]` —— 必须点 `.article-cover-add`（那个加号）
 * 才会现造出文件框，所以顺序是「点加号 → setInputFiles → 读回封面上出现了图」。
 * 封面模式默认就是「单图」（radio value=2 带 `checked`），我们显式确认一次。
 *
 * **失败必须抛错**：头条不允许无封面发布，静默失败等于白跑一趟（参考项目正是在这里静默失败的）。
 */
export async function uploadCover(page: ToutiaoPublishPageLike, coverPath: string): Promise<void> {
  // ① 确认封面模式是「单图」——默认就是，但显式点一次并读回，避免上次残留在别的模式上。
  const singleClicked = await clickByText(page, [TOUTIAO_SELECTORS.coverSingleLabel], {
    tags: ["label", "span", "div"],
  });
  if (singleClicked) {
    await page.waitForTimeout?.(400);
    // 读回：封面模式必须是「单图」，否则我们按单图传上去的封面可能落在三图/无封面模式里。
    const singleChecked = await page.evaluate<boolean>(pageExpression(
      `
      const group = document.querySelector("[class*='article-cover-radio-group']") || document;
      const labels = Array.from(group.querySelectorAll("label"));
      const target = labels.find(function (item) {
        return (item.textContent || "").trim() === input.text;
      });
      if (!target) return false;
      const inner = target.querySelector("[class*='byte-radio-inner']");
      // ⚠️ 这里**不能**再声明名为 input 的变量：pageExpression 的参数就叫 input，
      // 同一函数作用域里重复声明是 SyntaxError（实测踩到过）。
      const radio = target.querySelector("input[type='radio']");
      if (radio) return radio.checked;
      return Boolean(inner && (inner.className || "").toString().split(/\\s+/).includes("checked"));
      `,
      { text: TOUTIAO_SELECTORS.coverSingleLabel },
    ));
    if (!singleChecked) {
      throw new ToutiaoPageError(
        "toutiao_page_cover_upload_failed",
        "封面模式没能切到「单图」：已停在点「发布」之前，本次未提交任何内容。",
      );
    }
  }

  // ② 点封面加号（这一步才让文件框出现）。
  const addSelector = await firstMatchingSelector(page, TOUTIAO_SELECTORS.coverAdd);
  if (!addSelector) {
    throw new ToutiaoPageError(
      "toutiao_page_cover_add_missing",
      "在头条发布页上找不到封面的「添加」按钮：已停在点「发布」之前，本次未提交任何内容。",
    );
  }
  // ③ 把文件交给「原生选择框」或「DOM 里的文件框」——两条路都试。
  //
  // 实测（2026-09-18）：点完加号后 `input[type=file]` 计数**仍然是 0**、也没有任何抽屉节点，
  // 说明真页是「临时造 input → 触发原生选择框 → 移除」。因此**优先接原生选择框事件**
  // （`filechooser`），拿不到再退回 `setInputFiles`（fixture 与某些实现是常驻 input 的形态）。
  let uploaded = false;
  // ⚠️ **不要用 force**：加号常在折叠线以下，force 跳过「滚动进视口 / 确认未被遮挡」，
  // 于是点击落在别的元素上、抽屉压根不开（2026-09-18 演练实测：同一选择器不加 force 就能打开）。
  try {
    await page.click(addSelector, { timeout: 10_000 });
  } catch (error) {
    throw new ToutiaoPageError(
      "toutiao_page_cover_add_missing",
      `封面的「添加」按钮点不动（可能被遮挡或不在可视区）：${error instanceof Error ? error.message : String(error)}；`
      + "已停在点「发布」之前，本次未提交任何内容。",
    );
  }
  await page.waitForSelector(TOUTIAO_SELECTORS.drawer, { timeout: 10_000, state: "attached" })
    .catch(() => undefined);
  await page.waitForTimeout?.(1_500);

  // 点抽屉里的「本地上传」→ 这时才弹原生文件选择框（实测点完加号本身不会弹）。
  const chooserPromise = page.waitForEvent
    ? page.waitForEvent("filechooser", { timeout: 8_000 }).catch(() => undefined)
    : Promise.resolve(undefined);
  await clickByText(page, TOUTIAO_SELECTORS.localUploadTexts, {
    tags: ["button", "[role='button']", "span", "div", "a", "label"],
    scope: TOUTIAO_SELECTORS.drawer,
  });

  const chooser = await chooserPromise;
  if (chooser) {
    try {
      await chooser.setFiles(coverPath);
      uploaded = true;
    } catch {
      uploaded = false;
    }
  }

  if (!uploaded) {
    try {
      await page.waitForSelector(TOUTIAO_SELECTORS.drawerFileInput, { timeout: 8_000, state: "attached" });
      // `>> nth=0`：抽屉里第一个文件框；裸选择器多匹配会因严格模式报错。
      await page.setInputFiles(`${TOUTIAO_SELECTORS.drawerFileInput} >> nth=0`, coverPath);
      uploaded = true;
    } catch {
      uploaded = false;
    }
  }

  if (!uploaded) {
    throw new ToutiaoPageError(
      "toutiao_page_cover_upload_failed",
      "打开了封面上传抽屉，但没能把文件交进去（既没等到原生文件选择框，抽屉里也没有可用文件框）："
      + "已停在点「发布」之前，本次未提交任何内容。",
    );
  }

  // ④ 等图传上去，并在抽屉里点确认（文案可能是「确定/完成/保存」）。
  await page.waitForTimeout?.(5_000);
  await clickByText(page, TOUTIAO_SELECTORS.drawerConfirmTexts, {
    tags: ["button", "[role='button']"],
    scope: TOUTIAO_SELECTORS.drawer,
  });
  await page.waitForTimeout?.(1_500);

  // ④b 关掉抽屉：它不收起来会挡住页面下方的「预览并发布」。
  await clickByText(page, TOUTIAO_SELECTORS.drawerConfirmTexts, {
    tags: ["button", "[role='button']"],
    scope: TOUTIAO_SELECTORS.drawer,
  });
  await page.waitForTimeout?.(1_000);

  // ⑤ 读回：封面上必须真的出现了图（实测上传后是 `.article-cover-img-wrap img`）。
  const hasCover = await page.evaluate<boolean>(pageExpression(
    `
    const image = document.querySelector(input.selector);
    if (!image) return false;
    const source = image.currentSrc || image.src || "";
    return source.length > 0;
    `,
    { selector: TOUTIAO_SELECTORS.coverImage },
  ));
  if (!hasCover) {
    throw new ToutiaoPageError(
      "toutiao_page_cover_upload_failed",
      "封面文件已交给头条发布页，但封面上没有出现图片：已停在点「发布」之前，本次未提交任何内容。",
    );
  }
}

/**
 * 「头条首发」：需要就勾上、不需要就**真的取消**，两次都读回确认。
 *
 * ⚠️ 2026-09-20 用户真机实测：不需要勾时**只检查不取消**是不够的 —— 持久化 profile 会把上次草稿的
 * 勾选状态带回来（真机就是「页面已经是勾的」），于是提交被我们自己的检查拦下。取消勾选是一次
 * 普通的、可逆的点击，应当照 `ensureWeitoutiaoUnchecked` 的范式：**先取消、读回确认、取消不掉才停**。
 * 拦下来的理由仍然成立：绝不能带着一个用户没选的声明发出去。
 */
export async function setFirstPublish(page: ToutiaoPublishPageLike, enabled: boolean): Promise<void> {
  if (!enabled) {
    // 已经是未勾选：目标达成，**不点任何东西**（无谓的点击只会带来状态漂移的风险）。
    if (!(await firstPublishIsChecked(page))) return;

    const clicked = await clickCheckboxByText(page, TOUTIAO_SELECTORS.firstPublishTexts);
    if (!clicked) {
      throw new ToutiaoPageError(
        "toutiao_page_first_publish_missing",
        "「头条首发」在页面上是勾选状态，但本次并不需要勾选，而又找不到这个选项去取消它：已停在点「发布」之前，本次未提交任何内容。",
      );
    }
    await page.waitForTimeout?.(400);

    if (await firstPublishIsChecked(page)) {
      throw new ToutiaoPageError(
        "toutiao_page_first_publish_uncheck_failed",
        "「头条首发」需要保持未勾选，但点了之后仍是勾选状态：已停在点「发布」之前，"
        + "本次未提交任何内容（绝不会带着一个你没选的声明发出去）。",
      );
    }
    return;
  }
  const clicked = await clickCheckboxByText(page, TOUTIAO_SELECTORS.firstPublishTexts);
  if (!clicked) {
    throw new ToutiaoPageError(
      "toutiao_page_first_publish_missing",
      "在头条发布页上找不到「头条首发」选项：已停在点「发布」之前，本次未提交任何内容。",
    );
  }
  await page.waitForTimeout?.(400);

  // **点了还要读回**：字节系控件的文本在好几层元素上都一样，点到不响应点击的外层元素时
  // 状态丝毫不变（实测踩到过），而调用方会以为已经勾上了。
  if (!(await firstPublishIsChecked(page))) {
    throw new ToutiaoPageError(
      "toutiao_page_first_publish_missing",
      "点了「头条首发」但勾选状态没有变化：已停在点「发布」之前，本次未提交任何内容。",
    );
  }
}

/** 作品声明：逐条按精确文案点击；任何一条点不上都报错（合规声明不能被静默跳过）。 */
export async function setDeclarations(page: ToutiaoPublishPageLike, declarations: string[]): Promise<void> {
  for (const declaration of declarations) {
    const clicked = await clickCheckboxByText(page, [declaration]);
    if (!clicked) {
      throw new ToutiaoPageError(
        "toutiao_page_declaration_missing",
        `在头条发布页上找不到作品声明「${declaration}」：已停在点「发布」之前，本次未提交任何内容。`,
      );
    }
    await page.waitForTimeout?.(300);

    // **点了还要读回**：合规声明不能被静默跳过（同一个坑「头条首发」已经踩过一次 ——
    // 点在不响应点击的外层元素上时，click 返回 true 但状态丝毫不变）。
    const state = await readCheckboxState(page, [declaration]);
    if (!state.found || !state.checked) {
      throw new ToutiaoPageError(
        "toutiao_page_declaration_missing",
        `作品声明「${declaration}」点了但没勾上：合规声明不能被静默跳过，已停在点「发布」之前，本次未提交任何内容。`,
      );
    }
  }
}

/**
 * 关掉「同时发布微头条」。
 *
 * 实测：平台**默认就是勾选的**（`LABEL.byte-checkbox.item-checkbox.byte-checkbox-checked`，
 * 文案是「发布得更多收益」，旁边的 `div.edit-label` 才写着「同时发布微头条」）。
 * 所以这里**读回校验**：关不掉就抛错（fail closed），而不是「尽力而为」地继续发布。
 */
export async function ensureWeitoutiaoUnchecked(page: ToutiaoPublishPageLike): Promise<void> {
  const state = await readCheckboxState(page, TOUTIAO_SELECTORS.weitoutiaoTexts);
  if (!state.found) {
    throw new ToutiaoPageError(
      "toutiao_page_weitoutiao_missing",
      "在头条发布页上找不到「同时发布微头条」勾选框（平台默认是勾选的）：无法确认它已关闭，已停在点「发布」之前。",
    );
  }
  if (!state.checked) return;

  await clickCheckboxByText(page, TOUTIAO_SELECTORS.weitoutiaoTexts);
  await page.waitForTimeout?.(500);

  const after = await readCheckboxState(page, TOUTIAO_SELECTORS.weitoutiaoTexts);
  if (after.checked || !after.found) {
    throw new ToutiaoPageError(
      "toutiao_page_weitoutiao_unchecked_failed",
      "点了「同时发布微头条」但勾选状态没有变化：为避免在不知情时多发一条微头条，已停在点「发布」之前，本次未提交任何内容。",
    );
  }
}

/**
 * 点「预览并发布」，随后在**预览/确认**界面上点确认，并独立校验结果。
 *
 * 实测：发布页上只有「预览并发布」这一个按钮（没有「发布」），点完会进入预览页 ——
 * 那里的确认按钮文案我们看不到（点进去就等于发布），所以这里给候选文案 + **结果读回**：
 * 拿不到成功判据时返回空 `signal`，上层据此写 `verification: "unconfirmed"`，**绝不谎报成功**。
 *
 * **2026-09-20 真机第一次成功**：确认按钮被候选文案命中了，文章也真的发出去了，但页面上没有
 * 任何我们认识的 `successTexts` → 如实记 `unconfirmed`。问题是「当时页面长什么样」没被留下，
 * 于是成功提示的真实文案只能靠人回忆。所以现在**无论有没有判据**都带回 `postConfirm` 证据。
 */
export interface ToutiaoPostConfirmEvidence {
  url: string;
  /** 确认后是否已离开发布页（**结构性线索**，不是成功判据本身，别拿它冒充 confirmed）。 */
  leftPublishPage: boolean;
  /** 页面可见文案摘要（折叠空白、截断），用于人工核对与下次校准成功提示。 */
  excerpt: string;
}
export async function submitAndConfirm(
  page: ToutiaoPublishPageLike,
): Promise<{
  url: string;
  signal: string;
  confirmClicked: boolean;
  diagnostics: string;
  /** 确认**之后**页面是什么样（用于「点到了但读不到判据」时的校准）。 */
  postConfirm: ToutiaoPostConfirmEvidence;
}> {
  const clicked = await clickByText(page, TOUTIAO_SELECTORS.publishButtons, {
    tags: ["button", "[role='button']"],
  });
  if (!clicked) {
    throw new ToutiaoPageError(
      "toutiao_page_publish_button_missing",
      "在头条发布页上找不到「预览并发布」按钮：已停在提交之前，本次未提交任何内容。",
    );
  }

  await page.waitForTimeout?.(4_000);
  // 确认按钮**必须读回是否真的点到**：只点「预览并发布」而不确认，等于没发布；
  // 如果照样写「已点击发布」，操作者会以为发出去了（评审指出这正是旧实现的漏洞）。
  const confirmClicked = await clickByText(page, TOUTIAO_SELECTORS.confirmButtons, {
    tags: ["button", "[role='button']"],
  });
  await page.waitForTimeout?.(5_000);

  const signal = await page.evaluate<string>(pageExpression(
    `
    const body = document.body ? document.body.innerText || "" : "";
    for (const text of input) {
      if (body.indexOf(text) >= 0) return text;
    }
    return "";
    `,
    [...TOUTIAO_SELECTORS.successTexts],
  ));

  // 找不到确认按钮时，把**当时页面上所有可见按钮的文案**带回去：
  // 这一条的文案我们无法用只读侦察拿到（点进去就等于发布），所以让「失败信息本身」充当侦察 ——
  // 操作者跑一次真实发布，要么成功，要么就把真实文案带回来了，不必再猜。
  const diagnostics = confirmClicked ? "" : await readVisibleButtonTexts(page);

  const url = page.url();
  const postConfirm: ToutiaoPostConfirmEvidence = {
    url,
    // 只按 URL 判断「离开发布页」：这是结构线索。**不拿它当成功判据** ——
    // 会话失效也会跳走，把它当 confirmed 就是谎报。
    leftPublishPage: hasLeftPublishPage(url),
    // **始终**留摘要：成功了也留（下次要校准的是「成功提示长什么样」）。
    excerpt: await readVisibleText(page),
  };

  return { url, signal, confirmClicked, diagnostics, postConfirm };
}

/** 发布页的 URL 片段（判「是否已离开发布页」用；与 `TOUTIAO_PUBLISH_URL` 同源）。 */
const TOUTIAO_PUBLISH_PATH = "/profile_v4/graphic/publish";

/**
 * 确认后是否已**离开**发布页 —— 结构线索，**不是成功判据**。
 *
 * 真机第一次成功那次没法用它（页面停在哪我们当时没记），但它是有用的旁证：
 * 发布被受理后头条会跳走（回内容管理/首页），而校验失败会停在发布页。
 * **绝不能**把它当 confirmed：会话失效时也会跳到登录页。
 */
export function hasLeftPublishPage(url: string): boolean {
  return !url.includes(TOUTIAO_PUBLISH_PATH);
}

/**
 * 页面可见文案摘要：**头 + 尾**都留，中间省略。
 *
 * 只留开头是不够的（fixture 用例当场验证过）：成功提示、toast 这类东西通常挂在 body **末尾**
 * 或弹窗里，只取前 N 个字符会正好把它截掉 —— 那样「带回证据」就白带了。
 */
async function readVisibleText(page: ToutiaoPublishPageLike, head = 120, tail = 140): Promise<string> {
  const text = await page.evaluate<string>(pageExpression(
    `
    const body = document.body ? document.body.innerText || "" : "";
    return body.replace(/\s+/g, " ").trim().slice(0, input);
    `,
    head + tail + 260,
  ));
  const plain = (text ?? "").trim();
  if (plain.length <= head + tail) return plain;
  return `${plain.slice(0, head)}…（中间省略）…${plain.slice(-tail)}`;
}

/** 当前页面上的可见按钮文案（最多 12 个，用于失败诊断）。 */
async function readVisibleButtonTexts(page: ToutiaoPublishPageLike): Promise<string> {
  return page.evaluate<string>(pageExpression(
    `
    const texts = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(function (item) {
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map(function (item) { return (item.textContent || "").trim().slice(0, 24); })
      .filter(function (text) { return text.length > 0; });
    return texts.slice(0, 12).join(" / ");
    `,
  )).catch(() => "");
}
