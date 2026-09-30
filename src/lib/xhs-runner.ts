/**
 * 小红书执行器：浏览器会话、扫码登录、以及（Task 5/6 会补的）发布编排。
 *
 * 本文件当前实现 **Task 1 的范围**：浏览器会话 + 扫码登录 + 登录态自检。
 * 发布编排（`publishNote`）在 Task 6，页面步骤在 Task 5。
 *
 * ### 两条实测踩出来的登录纪律（写在这里免得后人重踩）
 *
 * ① **登录页默认是「短信登录」，页面上根本没有二维码**（2026-09-20 实测）。
 *    必须先点右上角那个切换图标（实测 `img.css-wemwzq`），而且**必须以「出现了更大的二维码元素」
 *    作为切换成功的判据** —— 那个切换图标本身就是一张 `data:image` 的 128×128 图，
 *    第一版探针按「面积最大的 data URL 图」去取，**取到的就是它**。
 *
 * ② **登录态判定不能要求「发布页 DOM 出现」**。扫码成功后平台把人送到 `/new/home`，
 *    那里标题框/编辑器**全部为 0**，于是「READY ∧ ¬BLOCKER」这种写法会让**扫码成功后还在原地傻等**
 *    （实测日志里只有一行「URL 变化: …/new/home」）。正确判据是
 *    **「已离开登录页 ∧ 无登录阻断信号」**；cookie 只作旁证 ——
 *    `access-token-creator` / `galaxy_creator_session_id` 这类 cookie **未登录访客也会被种**。
 */

import { mkdir } from "node:fs/promises";
import {
  XHS_AI_DECLARATION_TEXT,
  XhsPageError,
  clickSubmit,
  ensureImageTab,
  fillBody,
  fillTitle,
  selectAiDeclaration,
  saveDraftAndConfirm,
  uploadImages,
  type XhsPublishPageLike,
} from "./xhs-page.js";
import {
  XHS_BROWSER_GUIDANCE,
  XhsBrowserError,
  describeAttempts,
  resolveXhsBrowser,
  resolveXhsHeadedBrowser,
  resolveXhsProfileDir,
  type XhsBrowserConfig,
  type XhsBrowserTarget,
} from "./xhs-browser.js";

export type XhsRunnerErrorCode =
  | "xhs_browser_unavailable"
  | "xhs_profile_dir_unsafe"
  | "xhs_login_in_progress"
  | "xhs_not_logged_in"
  | "xhs_qr_unavailable"
  | "xhs_ai_declaration_required"
  | "xhs_already_logged_in";

/** 每个错误码对应的 HTTP 语义：并发冲突与其余「输入/环境不对」分开，界面/路由才能给出不同动作。 */
const ERROR_STATUS: Record<XhsRunnerErrorCode, number> = {
  xhs_browser_unavailable: 422,
  xhs_profile_dir_unsafe: 422,
  xhs_login_in_progress: 409,
  xhs_not_logged_in: 422,
  xhs_qr_unavailable: 422,
  xhs_ai_declaration_required: 422,
  // 「已经是登录状态」是**状态冲突**（不是参数/环境错），与「已有会话在进行中」同一档。
  xhs_already_logged_in: 409,
};

export class XhsRunnerError extends Error {
  readonly status: number;

  constructor(
    readonly code: XhsRunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "XhsRunnerError";
    this.status = ERROR_STATUS[code];
  }
}

/**
 * 登录只用页面接口里最小的一面（发布流程用 Task 5 的扩展面）。
 * 与头条同样的做法：先只声明这里真正用到的能力，Task 5 再扩。
 */
export interface XhsPageLike {
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load" }): Promise<unknown>;
  url(): string;
  evaluate<T>(expression: string): Promise<T>;
  waitForTimeout?(ms: number): Promise<void>;
  keyboard?: { press(key: string): Promise<void> };
  locator?(selector: string): {
    count(): Promise<number>;
    first(): { click(options?: { timeout?: number }): Promise<void> };
  };
}

export interface XhsBrowserSession {
  page: XhsPageLike;
  close(): Promise<void>;
  onClose?(callback: () => void): void;
}

export interface XhsLaunchOptions {
  profileDir: string;
  target: XhsBrowserTarget;
  headed?: boolean;
}

export type XhsSessionOpener = (options: XhsLaunchOptions) => Promise<XhsBrowserSession>;

export interface XhsRunnerConfig extends XhsBrowserConfig {
  storageRoot: string;
  /** 覆盖默认的 `<storageRoot>/xhs/profile`；**必须落在 storage 内**。 */
  profileDir?: string;
  /**
   * 注入会话开启器（测试用假会话；生产用 `openXhsSession`）。
   * ⚠️ 注入键名要与本接口一致 —— 头条那轮把夹具注入到**错误的配置键**上，
   * 结果测试里构造的是**真执行器**、真的启动了一个无头浏览器并留下 5 个孤儿进程。
   */
  openSession?: XhsSessionOpener;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  loginTimeoutMs?: number;
  windowLoginTimeoutMs?: number;
  /** 有头链与无头链各自允许的兜底层（透传 `resolveXhsBrowser*`）。 */
  allowPlaywrightCache?: boolean;
  allowSystemChrome?: boolean;
  repoRoot?: string;
}

/** 发布输入（由服务层从包记录 + 任务文案组装）。 */
export interface XhsPublishInput {
  title: string;
  body: string;
  /** 要上传的图片**绝对路径**（已按目标口径裁好）。 */
  imagePaths: string[];
  /**
   * 合规开关：**必须为 true**。我们的内容整条由 AI 生成，平台口径是「未标识 → 限制分发」，
   * 所以服务层会先拒掉 false，这里再兜一层（避免上层漏校验就发出去）。
   */
  aiDeclaration: boolean;
  /**
   * 最后一步开关：`false` = 显式暂存并核实浏览器本地草稿（真人在同一浏览器点发布）；
   * `true` = 由程序点「发布」。默认由调用方决定，spec §10 规定**默认 false**。
   */
  submit: boolean;
}

export interface XhsPublishResult {
  ok: boolean;
  /** 面向操作者的可执行原因（失败时）或结果摘要（成功时）。 */
  message: string;
  /** 逐步记录，进 `autoPublish.message` 供事后追查（失败时也带上，用来回答"停在哪一步"）。 */
  steps: string[];
  /** 程序**是否点过**「发布」。注意它不等于「是否真的发出去了」。 */
  submitted: boolean;
  /** 只有当前 profile 的完整草稿已持久化并读回才返回。 */
  xhsDraftId?: string;
  /**
   * ⚠️ 发布结果**恒为 `unconfirmed`**：点发布后不做读回，草稿保存另由 `xhsDraftId` 证明。
   * 按设计**点完发布不做任何读回**（spec §9，
   * `xiaohongshu-mcp` #715「让 AI 确认发布成功了没有 → 第一次警告第二次七天」）。
   * 保留这个字段是为了与抖音/头条通路的形状一致，让服务层能用同一套表达。
   */
  verification: "unconfirmed";
  /** 失败时的错误码（服务层据此落 failed 记录并给指引）。 */
  code?: string;
}

export interface XhsLoginState {
  loggedIn: boolean;
  url: string;
  username?: string;
}

export type XhsLoginStatus = "idle" | "waiting" | "logged_in" | "expired";

export const XHS_HOME_URL = "https://creator.xiaohongshu.com/";
export const XHS_LOGIN_URL = "https://creator.xiaohongshu.com/login";
/** 发布页；`target=image` 是实测能直接落在图文表单的写法。 */
export const XHS_PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?source=official&target=image";

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** 有头窗口扫码的等待上限（与抖音通路的 120 秒同量级；够扫一次码）。 */
const DEFAULT_WINDOW_LOGIN_TIMEOUT_MS = 180_000;
const WINDOW_LOGIN_POLL_MS = 2_000;
/** 页面跳转是 JS 驱动的，给页面一点时间落定再看 URL。 */
const NAVIGATION_SETTLE_MS = 3_000;

/**
 * 登录态**重试后才作数**（头条那轮真机实测的教训：只读一次 URL 就下结论，
 * 第一次自检会报「未登录」，几秒后再查同一份 profile 却是「已登录」）。
 * 假阴性的代价是发布会**被自己拦在**「登录态已失效，请重新扫码」上，用户跑去重扫一个其实好好的码。
 * 重试只是给页面落地的机会，**不放松判定**：两次都在登录页才是真的没登录。
 */
const LOGIN_CHECK_ATTEMPTS = 2;

/** 登录阻断信号：出现这些就说明**还停在登录界面**（哪怕是弹层形态）。 */
export const XHS_LOGIN_BLOCKER_SELECTORS = [
  'img[src*="qrcode"]',
  '[class*="qrcode"]',
  'text=扫码登录',
  'text=手机号登录',
  'text=验证码登录',
];

/** 「切换扫码登录」图标的候选（实测 `img.css-wemwzq`；类名是哈希的，所以给一条阶梯）。 */
export const XHS_QR_TOGGLE_SELECTORS = [
  "img.css-wemwzq",
  '[class*="qrcode"] img',
  'img[src*="qrcode"]',
  '[class*="scan"] img',
  '[class*="switch"] img',
];

/**
 * 二维码的**最小面积**门槛。
 *
 * 实测：切换图标 64×64=**4096**，真二维码渲染 160×160=**25600**（原图 196×196）。
 * 用 20000 把两者干净分开 —— 没有这条门槛，探针第一版就把切换图标当成了二维码。
 */
export const XHS_QR_MIN_AREA = 20_000;

export function isXhsLoginUrl(url: string): boolean {
  return url.includes("/login");
}

/** 页面侧代码**必须是字符串**（tsx/esbuild 会给内联函数包 `__name(...)` 助手 → 页面里 `ReferenceError`）。 */
export async function hasLoginBlocker(page: XhsPageLike): Promise<boolean> {
  const result = await page
    .evaluate<number>(`(() => {
      const selectors = ${JSON.stringify(XHS_LOGIN_BLOCKER_SELECTORS.filter((item) => !item.startsWith("text=")))};
      let hits = 0;
      for (const selector of selectors) {
        try {
          hits += document.querySelectorAll(selector).length;
        } catch (error) {
          // 忽略非法选择器：这里只是探测，不该因为一条写错就整体失败。
        }
      }
      const text = (document.body && document.body.innerText) || "";
      if (text.indexOf("扫码登录") >= 0 || text.indexOf("手机号登录") >= 0 || text.indexOf("验证码登录") >= 0) {
        hits += 1;
      }
      return hits;
    })()`)
    // 页面跳转中读不到 DOM 不代表没有阻断；继续等待，避免提前关闭登录会话。
    .catch(() => 1);
  return result > 0;
}

/**
 * 从登录页取二维码（data URL）。
 *
 * 取**面积最大**且**面积达到门槛**的那张 `data:` 图；同时兼顾 canvas 与 CSS 背景图。
 * 达不到门槛就返回 `null` —— 宁可报「取不到二维码」，也不能把切换图标当码给用户扫。
 */
export async function readXhsQrDataUrl(page: XhsPageLike): Promise<string | null> {
  return page.evaluate<string | null>(`(() => {
    const candidates = [];
    const area = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width * rect.height;
    };
    for (const image of Array.from(document.querySelectorAll("img"))) {
      const source = image.currentSrc || image.src || "";
      if (source.indexOf("data:image") === 0) candidates.push({ dataUrl: source, area: area(image) });
    }
    for (const canvas of Array.from(document.querySelectorAll("canvas"))) {
      try {
        const dataUrl = canvas.toDataURL("image/png");
        if (dataUrl && dataUrl.length > 200) candidates.push({ dataUrl: dataUrl, area: area(canvas) });
      } catch (error) {
        // 跨域画布取不到，跳过。
      }
    }
    for (const element of Array.from(document.querySelectorAll("*"))) {
      const background = getComputedStyle(element).backgroundImage || "";
      const match = background.match(/url\\("?(data:image[^")]+)"?\\)/);
      if (match) candidates.push({ dataUrl: match[1], area: area(element) });
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => right.area - left.area);
    const best = candidates[0];
    return best.area >= ${XHS_QR_MIN_AREA} ? best.dataUrl : null;
  })()`);
}

/**
 * 切到扫码登录模式（登录页默认是短信登录）。
 *
 * 判据是**「点完确实出现了更大的二维码元素」**，不是「点击没抛错」——
 * 点错元素（比如那个切换图标自己）也会「成功」，但码根本没换出来。
 */
export async function switchToQrMode(page: XhsPageLike): Promise<boolean> {
  for (const selector of XHS_QR_TOGGLE_SELECTORS) {
    const count = (await page.locator?.(selector).count().catch(() => 0)) ?? 0;
    if (count === 0) continue;
    await page.locator?.(selector).first().click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout?.(3_000);
    if ((await readXhsQrDataUrl(page)) !== null) return true;
  }
  return false;
}

/**
 * 读昵称（**仅用于界面展示，绝不用作任何判据**）。
 *
 * 首页 header 的文本形如「… 李在那 退出登录」，所以取「退出登录」前面那个词是最稳的写法
 *（比猜一堆哈希类名靠谱）。读不到返回 `undefined` —— 昵称读不到不该阻塞登录。
 */
export async function readXhsUsername(page: XhsPageLike): Promise<string | undefined> {
  const value = await page
    .evaluate<string>(`(() => {
      const text = ((document.body && document.body.innerText) || "").replace(/[\\s\\u00a0]+/g, " ").trim();
      // ① 有「退出登录」时最好认：取它前面那个词。
      const byLogout = text.match(/([^\\s]{1,24})\\s*退出登录/);
      if (byLogout) return byLogout[1];
      // ② ⚠️ 实测（2026-09-21）：创作中心首页**已经不再显示「退出登录」**，
      //    但会显示「<昵称> 2 关注数 0 粉丝数」——所以第二条按这个形状取。
      const byFollow = text.match(/([^\\s]{1,24})\\s*[0-9]+\\s*关注/);
      if (byFollow) return byFollow[1];
      // ③ 最后才试几个常见容器类名。
      const selectors = ["[class*='user-name']", "[class*='userName']", "[class*='nickname']", "[class*='nick-name']"];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const text2 = element && element.textContent ? element.textContent.trim() : "";
        if (text2) return text2;
      }
      return "";
    })()`)
    .catch(() => "");
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 把浏览器解析抛出的 `XhsBrowserError` 收敛成 `XhsRunnerError`（**码值与 status 原样保留**）。
 *
 * 为什么要收敛：服务层与路由层只需要认**一个**错误族。两族的码值本来就是同一套
 *（`xhs_browser_unavailable` / `xhs_profile_dir_unsafe`），所以收敛不丢任何信息，
 * 却省掉了「路由层要记得同时登记两个类」这个静默点。
 */
function safeResolve<T>(resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof XhsBrowserError) {
      throw new XhsRunnerError(error.code, error.message);
    }
    throw error;
  }
}

interface LoginSession {
  session: XhsBrowserSession;
  startedAt: number;
  expiresAt: number;
}

export class XhsRunner {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly loginTimeoutMs: number;
  private readonly windowLoginTimeoutMs: number;
  private readonly openSession: XhsSessionOpener;
  private readonly profileDir: string;
  private loginSession: LoginSession | undefined;
  /** 启动中的登录会话（同步置位）：没有它，两个并发请求会各开一个浏览器并互相覆盖。 */
  private loginStarting = false;
  private profileBusy = false;
  private draftSession: XhsBrowserSession | undefined;
  private exitCleanupInstalled = false;

  constructor(private readonly config: XhsRunnerConfig) {
    this.now = config.now ?? (() => Date.now());
    this.sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.loginTimeoutMs = config.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.windowLoginTimeoutMs = config.windowLoginTimeoutMs ?? DEFAULT_WINDOW_LOGIN_TIMEOUT_MS;
    const opener = config.openSession ?? openXhsSession;
    this.openSession = async options => {
      if (this.profileBusy) throw new XhsRunnerError("xhs_login_in_progress",
        "小红书浏览器正在使用中：请先关闭草稿浏览器，或等待当前登录/填稿完成后重试。");
      this.profileBusy = true;
      let released = false;
      const release = () => { if (!released) { released = true; this.profileBusy = false; } };
      try {
        const session = await opener(options);
        session.onClose?.(release);
        return { ...session, close: async () => { try { await session.close(); } finally { release(); } } };
      } catch (error) { release(); throw error; }
    };
    try {
      this.profileDir = resolveXhsProfileDir(config.storageRoot, config.profileDir);
    } catch (error) {
      if (error instanceof XhsBrowserError) {
        throw new XhsRunnerError(error.code, error.message);
      }
      throw error;
    }
  }

  /** 配置自检：解析不到浏览器时立刻抛错（必须发生在写入任何记录之前）。 */
  assertConfigured(): void {
    const resolution = safeResolve(() => resolveXhsBrowser(this.config));
    if (!resolution.target) {
      throw new XhsRunnerError(
        "xhs_browser_unavailable",
        `${XHS_BROWSER_GUIDANCE}\n逐层诊断：${describeAttempts(resolution.attempts)}`,
      );
    }
  }

  get profileDirectory(): string {
    return this.profileDir;
  }

  /** 使用填稿时的同一个 profile；窗口交给用户，直到手动关闭或应用退出。 */
  async openDraftWindow(): Promise<{ message: string }> {
    if (this.draftSession) return { message: "小红书草稿浏览器已打开，请在该窗口的「图文笔记」中核对。" };
    const resolution = safeResolve(() => resolveXhsHeadedBrowser(this.config));
    if (!resolution.target) throw new XhsRunnerError("xhs_browser_unavailable",
      "打开本地草稿需要可显示窗口的浏览器：请安装 Google Chrome，或运行 npx playwright install chromium。"
      + `\n逐层诊断：${describeAttempts(resolution.attempts)}`);
    const session = await this.openSession({ profileDir: this.profileDir, target: resolution.target, headed: true });
    try {
      await session.page.goto(XHS_PUBLISH_URL, { waitUntil: "domcontentloaded" });
      await settle(session.page);
      // 只打开草稿箱并选择图文类型；不打开编辑器、不触发发布。
      await session.page.evaluate(`(() => {
        const clickText = (pattern) => {
          const target = Array.from(document.querySelectorAll("span, div, button, a"))
            .find(element => element.children.length === 0 && pattern.test((element.textContent || "").trim()));
          if (target) target.click();
        };
        clickText(/^草稿箱(?:\\(\\d+\\))?$/u);
      })()`);
      await session.page.waitForTimeout?.(500);
      await session.page.evaluate(`(() => {
        const target = Array.from(document.querySelectorAll("span, div, button, a"))
          .find(element => element.children.length === 0 && /^图文笔记\\(\\d+\\)$/u.test((element.textContent || "").trim()));
        if (target) target.click();
      })()`);
      this.draftSession = session;
      session.onClose?.(() => { if (this.draftSession === session) this.draftSession = undefined; });
      return { message: "已打开小红书草稿浏览器。请在「图文笔记」核对；草稿仅存于这个浏览器，不会同步到手机。" };
    } catch (error) { await closeQuietly(session); throw error; }
  }

  /**
   * 零副作用自检：只开首页判登录态 + 读昵称，不填任何表单、不解锁任何东西。
   *
   * ⚠️ 判据是 **「已离开登录页 ∧ 无登录阻断信号」**，**不要求发布页 DOM 出现**（见文件头 ②）。
   */
  async checkLogin(): Promise<XhsLoginState> {
    if (this.loginStarting) {
      throw new XhsRunnerError("xhs_login_in_progress", "正在获取小红书登录二维码，请稍后校验。");
    }
    const active = this.loginSession;
    if (active && this.now() < active.expiresAt) {
      // 校验只观察正在扫码的页面，不能另开浏览器争用同一个 profile。
      const state = await this.readLoginState(active.session.page);
      if (!state.loggedIn) {
        throw new XhsRunnerError("xhs_login_in_progress", "正在等待小红书扫码确认，请在 App 中确认登录；当前二维码会继续等待，不需要重扫。");
      }
      await this.discardSession();
      return state;
    }
    if (active) await this.discardSession();
    const session = await this.openSessionFor(false);
    try {
      let url = XHS_HOME_URL;
      for (let attempt = 0; attempt < LOGIN_CHECK_ATTEMPTS; attempt += 1) {
        await session.page.goto(XHS_HOME_URL, { waitUntil: "domcontentloaded" });
        await settle(session.page);
        url = session.page.url();
        if (isXhsLoginUrl(url)) continue;
        if (await hasLoginBlocker(session.page)) continue;
        const username = await readXhsUsername(session.page);
        return username === undefined ? { loggedIn: true, url } : { loggedIn: true, url, username };
      }
      return { loggedIn: false, url };
    } finally {
      await closeQuietly(session);
    }
  }

  /** 开始扫码登录：返回二维码 data URL 与过期时间。同一时刻只允许一个会话。 */
  async startLogin(): Promise<{ qrDataUrl: string; startedAt: string; expiresAt: string }> {
    const existing = this.loginSession;
    if (this.loginStarting || (existing && this.now() < existing.expiresAt)) {
      // 让第二次扫码把第一次的页面顶掉，是「用户扫了旧码却等不到登录」的典型原因。
      throw new XhsRunnerError(
        "xhs_login_in_progress",
        "已有一个扫码登录会话在进行中，请先扫完当前二维码或点「取消」，再重新获取。",
      );
    }
    await this.discardSession();
    this.loginStarting = true;

    let session: XhsBrowserSession;
    try {
      session = await this.openSessionFor(false);
    } catch (error) {
      this.loginStarting = false;
      throw error;
    }
    try {
      // ⚠️ **先判登录态**（2026-09-21 真机实测的坑）：账号已经登录时访问登录页会被**重定向走**，
      // 页面上根本没有二维码 —— 原先那条路会一路走到取码失败，报出
      // 「页面结构可能已改版」这种**误诊**（把「你不需要扫码」说成「页面坏了」）。
      await session.page.goto(XHS_HOME_URL, { waitUntil: "domcontentloaded" });
      await settle(session.page);
      const already = await this.readLoginState(session.page);
      if (already?.loggedIn) {
        throw new XhsRunnerError(
          "xhs_already_logged_in",
          `当前已经是登录状态${already.username ? `（${already.username}）` : ""}，无需再扫码。`
            + "若要换账号，请先在小红书里退出登录（或用另一个浏览器会话目录），再重新扫码。",
        );
      }

      await session.page.goto(XHS_LOGIN_URL, { waitUntil: "domcontentloaded" });
      await settle(session.page);

      // 登录页默认是短信登录：先切到扫码模式，再取码。
      let qrDataUrl = await readXhsQrDataUrl(session.page);
      if (!qrDataUrl) {
        const switched = await switchToQrMode(session.page);
        if (switched) qrDataUrl = await readXhsQrDataUrl(session.page);
      }
      if (!qrDataUrl) {
        throw new XhsRunnerError(
          "xhs_qr_unavailable",
          "没能从小红书登录页取到二维码（登录页默认是短信登录，需要先切到扫码模式；页面结构可能已改版）。"
            + "请稍后重试；若持续失败，请用 `node --import tsx scripts/probe-xhs-publish-page.ts --login` 跑一次只读侦察。",
        );
      }

      const startedAt = this.now();
      this.loginSession = { session, startedAt, expiresAt: startedAt + this.loginTimeoutMs };
      return {
        qrDataUrl,
        startedAt: new Date(startedAt).toISOString(),
        expiresAt: new Date(startedAt + this.loginTimeoutMs).toISOString(),
      };
    } catch (error) {
      // 失败路径同样要关浏览器：否则每次「取二维码失败」都留下一个孤儿进程。
      await closeQuietly(session);
      throw error;
    } finally {
      this.loginStarting = false;
    }
  }

  /** 轮询登录状态；二维码过期或被取消时回到 `idle`。 */
  async pollLogin(): Promise<{ status: XhsLoginStatus; username?: string; qrDataUrl?: string }> {
    const current = this.loginSession;
    if (!current) return { status: "idle" };
    if (this.now() >= current.expiresAt) {
      await this.discardSession();
      return { status: "expired" };
    }

    const state = await this.readLoginState(current.session.page);
    if (!state.loggedIn) {
      // 平台会静默换码；同步页面当前二维码，而不是让用户一直扫旧图片。
      const qrDataUrl = await readXhsQrDataUrl(current.session.page).catch(() => null);
      return { status: "waiting", ...(qrDataUrl ? { qrDataUrl } : {}) };
    }
    await this.discardSession();
    return state.username === undefined ? { status: "logged_in" } : { status: "logged_in", username: state.username };
  }

  /**
   * 打开一个**真实浏览器窗口**扫码（与抖音 `/api/douyin/qr-login` 同一交互）。
   * 同步等待到登录成功或超时；`finally` 必关窗口。
   */
  async loginInWindow(options: { timeoutMs?: number } = {}): Promise<{ loggedIn: boolean; message: string; username?: string }> {
    const resolution = safeResolve(() => resolveXhsHeadedBrowser(this.config));
    if (!resolution.target) {
      throw new XhsRunnerError(
        "xhs_browser_unavailable",
        "本机没有可用于打开窗口扫码的浏览器（打包的 chrome-headless-shell 是无头专用构建，开不了窗口）。"
          + "请安装 Google Chrome，或运行 npx playwright install chromium，或改用界面上的「应用内扫码」。"
          + `\n逐层诊断：${describeAttempts(resolution.attempts)}`,
      );
    }

    const timeoutMs = options.timeoutMs ?? this.windowLoginTimeoutMs;
    const session = await this.openSession({ profileDir: this.profileDir, target: resolution.target, headed: true });
    const deadline = this.now() + timeoutMs;
    try {
      await session.page.goto(XHS_LOGIN_URL, { waitUntil: "domcontentloaded" });
      await settle(session.page);
      while (this.now() < deadline) {
        const state = await this.readLoginState(session.page);
        if (state.loggedIn) {
          return state.username === undefined
            ? { loggedIn: true, message: "扫码登录成功" }
            : { loggedIn: true, message: `扫码登录成功（${state.username}）`, username: state.username };
        }
        await this.sleep(WINDOW_LOGIN_POLL_MS);
      }
      return { loggedIn: false, message: `等待扫码超时（${Math.round(timeoutMs / 1000)} 秒）：请重试，或用界面上的「应用内扫码」。` };
    } finally {
      await closeQuietly(session);
    }
  }

  /**
   * 发布编排：**上传 → 标题 → 正文 → 声明 →（可选）点发布**。
   *
   * 顺序不能变：页面是**分阶段渲染**的 —— 不先上传图片，标题/正文/声明/提交都**不在 DOM 里**。
   *
   * 三条纪律（详见本文件头与 spec §9/§10/§11）：
   * · `submit: false`（默认）→ 暂存并核实完整本地草稿，绝不点发布；
   * · `submit: true` → 点「发布」，但**点完之后不再碰页面**，`verification` 恒为 `unconfirmed`；
   * · 任何一步失败都**停在点发布之前**，并在 message 里写明**已完成到哪一步**；
   *   任何异常都收敛成 `ok:false`，绝不抛给服务层变成 500。
   */
  async publishNote(input: XhsPublishInput, options: { dryRun?: boolean } = {}): Promise<XhsPublishResult> {
    const steps: string[] = [];
    const submitEnabled = input.submit === true && options.dryRun !== true;
    let session: XhsBrowserSession | undefined;
    /**
     * 当前正在做的步骤名。
     *
     * `steps` 只记录**已经完成**的步骤（把没做成的也算进去是撒谎），
     * 所以「停在哪一步」必须靠这个变量在失败消息里回答 —— 操作者要的是
     * 「已完成 A → B，**失败于 C**」，而不是一句「失败」。
     */
    let current: string | undefined;

    try {
      // 合规兜底：宁可拒绝，也不发一条没标识的 AI 笔记。
      if (input.aiDeclaration !== true) {
        throw new XhsRunnerError(
          "xhs_ai_declaration_required",
          `本次没有声明「${XHS_AI_DECLARATION_TEXT}」。我们的内容由 AI 生成，`
            + "平台口径是「未主动标识 → 限制分发」，因此**拒绝发布**。",
        );
      }

      session = await this.openSessionFor(false);
      // 交集类型：页面步骤那套（locator/keyboard/mouse）+ 会话那套（goto/url）。
      // 两者本来就是同一个真实 page 对象的两面，分模块只是为了各自能被独立测试。
      const page = session.page as unknown as XhsPublishPageLike & XhsPageLike;

      await page.goto(XHS_PUBLISH_URL, { waitUntil: "domcontentloaded" });
      await settle(session.page);
      if (isXhsLoginUrl(session.page.url())) {
        // 一步都不做就返回：**不填表、不点任何东西**。
        return {
          ok: false,
          message: "小红书登录态已失效：请到「设置 → 小红书」重新扫码登录后再试。本次没有填写任何内容。",
          steps,
          submitted: false,
          verification: "unconfirmed",
          code: "xhs_not_logged_in",
        };
      }
      current = "进入发布页";
      steps.push(current);

      await ensureImageTab(page);

      current = "上传图片";
      const { uploaded } = await uploadImages(page, input.imagePaths);
      steps.push(`上传图片：送入 ${input.imagePaths.length} 张，页面读回 ${uploaded} 张`);

      current = "填写标题";
      await fillTitle(page, input.title);
      steps.push(`填写标题：读回与目标逐字一致（${[...input.title].length} 字）`);

      current = "填写正文";
      await fillBody(page, input.body);
      steps.push("填写正文：读回含首段与末段");

      current = "声明 AI 合成内容";
      await selectAiDeclaration(page);
      steps.push(`声明 AI 合成内容：${XHS_AI_DECLARATION_TEXT}`);

      if (!submitEnabled) {
        current = "保存并核实浏览器本地草稿";
        const xhsDraftId = await saveDraftAndConfirm(page, {
          title: input.title, body: input.body, imageCount: input.imagePaths.length,
        });
        steps.push(`${current}：${xhsDraftId}${options.dryRun ? "（演练，未发布）" : ""}`);
        return {
          ok: true,
          submitted: false,
          xhsDraftId,
          verification: "unconfirmed",
          steps,
          message: "已保存并核实小红书浏览器本地图文草稿（本工具没有点发布）。"
            + "请点「打开小红书草稿浏览器」核对并自行发布；草稿不会同步到手机或其它浏览器。",
        };
      }

      current = "点击发布";
      await clickSubmit(page, "publish");
      steps.push("点击发布");

      // ⚠️ 到这里**不再碰页面**：不抓 URL、不轮询成功文案、不读页面（spec §9）。
      return {
        ok: true,
        submitted: true,
        verification: "unconfirmed",
        steps,
        message: "已点击发布，但**按设计没有做任何读回**（平台风控会把「发布后再去页面确认」视为自动化特征）。"
          + "请先到小红书 App 核实是否真的发出去了，再决定是否需要重试 —— **重复发布是本功能最大的风险**。",
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const code = error instanceof XhsRunnerError || error instanceof XhsPageError ? error.code : "xhs_publish_unexpected";
      const completed = steps.length > 0 ? `已完成：${steps.join(" → ")}。` : "尚未开始填写。";
      // 三者缺一不可：**原始原因**（否则只剩一句「失败」）、**停在哪一步**、**已完成哪些**。
      const where = current ? `失败于「${current}」。` : "";
      return {
        ok: false,
        message: `${detail}（${where}${completed}）`,
        steps,
        submitted: false,
        verification: "unconfirmed",
        code,
      };
    } finally {
      if (session) await closeQuietly(session);
    }
  }

  async cancelLogin(): Promise<void> {
    await this.discardSession();
  }

  async dispose(): Promise<void> {
    await this.discardSession();
    const draft = this.draftSession;
    this.draftSession = undefined;
    if (draft) await closeQuietly(draft);
  }

  /** 退出清理：尽力关掉登录会话的浏览器，避免留下持有 profile 的孤儿进程。 */
  installExitCleanup(): void {
    if (this.exitCleanupInstalled) return;
    this.exitCleanupInstalled = true;
    const cleanup = (): void => {
      const current = this.loginSession;
      this.loginSession = undefined;
      if (current) void current.session.close().catch(() => undefined);
      if (this.draftSession) void this.draftSession.close().catch(() => undefined);
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }

  /** 只观察当前页面：轮询/窗口扫码绝不能导航，否则会销毁二维码及手机确认中的会话。 */
  private async readLoginState(page: XhsPageLike): Promise<XhsLoginState> {
    try {
      const url = page.url();
      if (isXhsLoginUrl(url)) return { loggedIn: false, url };
      if (await hasLoginBlocker(page)) return { loggedIn: false, url };
      const username = await readXhsUsername(page);
      return username === undefined ? { loggedIn: true, url } : { loggedIn: true, url, username };
    } catch (error) {
      // 判定过程中的**任何**异常都收敛成「未登录」，绝不让原始异常冒到路由层变成 500。
      return { loggedIn: false, url: "", username: undefined };
    }
  }

  private async openSessionFor(headed: boolean): Promise<XhsBrowserSession> {
    const resolution = safeResolve(() => resolveXhsBrowser(this.config));
    if (!resolution.target) {
      throw new XhsRunnerError(
        "xhs_browser_unavailable",
        `${XHS_BROWSER_GUIDANCE}\n逐层诊断：${describeAttempts(resolution.attempts)}`,
      );
    }
    return this.openSession({ profileDir: this.profileDir, target: resolution.target, headed });
  }

  private async discardSession(): Promise<void> {
    const current = this.loginSession;
    this.loginSession = undefined;
    if (current) await closeQuietly(current.session);
  }
}

async function settle(page: XhsPageLike): Promise<void> {
  await page.waitForTimeout?.(NAVIGATION_SETTLE_MS);
}

async function closeQuietly(session: XhsBrowserSession): Promise<void> {
  await session.close().catch(() => undefined);
}

/**
 * 用**打包资源里已有的** headless shell 启动持久化会话（零新依赖、零额外下载）。
 *
 * ⚠️ **会话目录由我们自己建**（头条那轮的教训）：交给 Playwright 建目录时，
 * 目录不可写只会得到一句 `launchPersistentContext: EPERM … mkdir`，
 * 看不出是权限问题还是浏览器问题。这里失败就报 `xhs_profile_dir_unsafe` 并写出**是哪个目录、什么原因**。
 */
export async function openXhsSession(options: XhsLaunchOptions): Promise<XhsBrowserSession> {
  try {
    await mkdir(options.profileDir, { recursive: true });
  } catch (error) {
    throw new XhsRunnerError(
      "xhs_profile_dir_unsafe",
      `小红书浏览器会话目录不可写：${options.profileDir}（${error instanceof Error ? error.message : String(error)}）。`
        + "请确认 storage 目录存在且当前用户可写；或用 XHS_PROFILE_DIR 指向 storage 内另一个可写目录后重启后端。",
    );
  }

  const { chromium } = await import("playwright");
  try {
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: options.headed !== true,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1440, height: 900 },
      // 实测：2 倍像素密度便于对「封闭 shadow root」的控件做元素截图取证；
      // 但它会放大截图体积，发布流程不需要，所以只在显式要求时打开。
      ...(options.target.kind === "executablePath" ? { executablePath: options.target.path } : {}),
      ...(options.target.kind === "channel" ? { channel: options.target.channel } : {}),
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      page: page as unknown as XhsPageLike,
      close: () => context.close().catch(() => undefined),
      onClose: callback => { context.once("close", callback); },
    };
  } catch (error) {
    // **任意**启动异常都包成带原因 + 带动作的错误：原始异常冒到路由层会变成 500，
    // 且会让 autoPublish 卡在 running 直到 30 分钟僵死阈值。
    throw new XhsRunnerError(
      "xhs_browser_unavailable",
      `小红书浏览器启动失败：${error instanceof Error ? error.message : String(error)}。`
        + "可照抄的动作：① npm run prepare:package:mac；② npx playwright install chromium；"
        + "③ 用 XHS_BROWSER_BINARY 指定一个 Chromium 系可执行文件后重启后端。",
    );
  }
}

/** 供服务层在写任何记录前做一次配置自检。 */
export function requireXhsRunnerConfig(config: XhsRunnerConfig): XhsRunner {
  const runner = new XhsRunner(config);
  runner.assertConfigured();
  return runner;
}
