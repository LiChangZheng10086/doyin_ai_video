/**
 * 今日头条执行器：登录会话、账号自检与（Task 4 起）发布编排。
 *
 * 与既有 `sau-runner.ts` 同一模式：**页面通过窄接口注入**，所以单测全程不启浏览器、不联网；
 * 真实的浏览器步骤与选择器在 `toutiao-page.ts`，用离线 fixture 页跑真 Playwright。
 *
 * 两条纪律（都来自参考项目的反面，见 `docs/research/toutiao-ops-assessment.md` §3）：
 * ① **每一步都要有落地证据**，任何一步失败都抛错中止，绝不吞异常继续点发布；
 * ② **发布结果必须独立校验**，拿不到判据就如实上报 `unconfirmed`，绝不谎报成功。
 */

import {
  ToutiaoPageError,
  isLoginUrl,
  ensureWeitoutiaoUnchecked,
  fillBodyHtml,
  fillTitle,
  gotoPublishPage,
  setDeclarations,
  setFirstPublish,
  submitAndConfirm,
  uploadCover,
} from "./toutiao-page.js";
import {
  TOUTIAO_BROWSER_GUIDANCE,
  ToutiaoBrowserError,
  describeAttempts,
  resolveToutiaoBrowser,
  resolveToutiaoHeadedBrowser,
  resolveToutiaoProfileDir,
  type ToutiaoBrowserConfig,
  type ToutiaoBrowserTarget,
} from "./toutiao-browser.js";

export type ToutiaoRunnerErrorCode =
  | "toutiao_browser_unavailable"
  | "toutiao_profile_dir_unsafe"
  | "toutiao_login_in_progress"
  | "toutiao_not_logged_in"
  | "toutiao_qr_unavailable";

/** 每个错误码对应的 HTTP 语义：并发冲突与其余「输入/环境不对」分开，界面/路由才能给出不同动作。 */
const ERROR_STATUS: Record<ToutiaoRunnerErrorCode, number> = {
  toutiao_browser_unavailable: 422,
  toutiao_profile_dir_unsafe: 422,
  toutiao_login_in_progress: 409,
  toutiao_not_logged_in: 422,
  toutiao_qr_unavailable: 422,
};

export class ToutiaoRunnerError extends Error {
  readonly status: number;

  constructor(
    readonly code: ToutiaoRunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToutiaoRunnerError";
    this.status = ERROR_STATUS[code];
  }
}

/**
 * 页面接口由 `toutiao-page.ts` 定义（登录只用其中最小的一面，发布流程用扩展面）。
 * 这里再导出一次，是为了让调用方（含既有用例）不必同时 import 两个模块。
 */
// 本模块内部要用到这两个页面类型；同时转发给调用方（含既有用例），免得大家 import 两个模块。
import type { ToutiaoPageLike, ToutiaoPublishPageLike } from "./toutiao-page.js";
export type { ToutiaoPageLike, ToutiaoPublishPageLike };

export interface ToutiaoBrowserSession {
  page: ToutiaoPageLike;
  close(): Promise<void>;
}

export interface ToutiaoLaunchOptions {
  profileDir: string;
  target: ToutiaoBrowserTarget;
  /** 有头窗口（扫码登录用）；缺省无头。 */
  headless?: boolean;
}

export interface ToutiaoRunnerConfig extends ToutiaoBrowserConfig {
  /** storage 根目录；会话目录缺省落在它里面（`storage/toutiao/profile`）。 */
  storageRoot: string;
  /** 会话目录覆盖；必须落在 storage 内。 */
  profileDir?: string;
  /** 注入启动器（测试用假实现，绝不启浏览器）。 */
  launch?: (options: ToutiaoLaunchOptions) => Promise<ToutiaoBrowserSession>;
  /** 注入时钟（测试用）。 */
  now?: () => number;
  /** 扫码会话的有效期；缺省 10 分钟。 */
  loginTimeoutMs?: number;
}

/**
 * 发布一次文章的输入。
 *
 * `articleHtml` 用于富文本粘贴，`articleText` 是纯文本兜底（段落数组，**不带**小标题标记）；
 * `coverPath` 是已经裁成 16:9 的封面文件（头条封面必填）。
 */
export interface ToutiaoPublishInput {
  title: string;
  articleHtml: string;
  articleText: string;
  coverPath: string;
  firstPublish: boolean;
  declarations: string[];
  crossPostWeitoutiao: boolean;
}

export interface ToutiaoPublishResult {
  ok: boolean;
  /** 面向操作者的可执行原因（失败时）或结果摘要（成功时）。 */
  message: string;
  url?: string;
  /**
   * 独立校验的结论：`confirmed` = 页面上拿到了成功判据；`unconfirmed` = 点了发布但没拿到判据。
   * **绝不谎报**：拿不到判据时必须如实上报，让操作者先去后台核实。
   */
  verification: "confirmed" | "unconfirmed";
  /** 富文本粘贴是否生效（`plain` = 退化成了逐段纯文本输入，排版会丢）。 */
  bodyMode: "rich" | "plain";
  /** 逐步记录，进 `autoPublish.message` 供事后追查。 */
  steps: string[];
}

export interface ToutiaoLoginState {
  loggedIn: boolean;
  url: string;
  username?: string;
}

export type ToutiaoLoginStatus = "idle" | "waiting" | "logged_in" | "expired";

export const TOUTIAO_HOME_URL = "https://mp.toutiao.com/";
export const TOUTIAO_LOGIN_URL = "https://mp.toutiao.com/auth/page/login";
export const TOUTIAO_PUBLISH_URL = "https://mp.toutiao.com/profile_v4/graphic/publish";

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** 有头窗口扫码的等待上限（与抖音通路的 120 秒同量级；够扫一次码）。 */
const DEFAULT_WINDOW_LOGIN_TIMEOUT_MS = 180_000;
const WINDOW_LOGIN_POLL_MS = 2_000;
/** 头条的跳转是 HTTP + JS 混合的，给页面一点时间落定再看 URL。 */
const NAVIGATION_SETTLE_MS = 3_000;

// 未登录判定只有一份实现（在 `toutiao-page.ts`，页面步骤与登录会话共用）——
// 早先这里另写了一份，结果页面模块漏了 SSO 分支，两处口径不一致。
export { isLoginUrl } from "./toutiao-page.js";

/** 从登录页取二维码。头条把二维码直接渲染成 `data:image/png;base64,…` 的 `<img>`（实测 512×512）。 */
export async function readQrDataUrl(page: ToutiaoPageLike): Promise<string | null> {
  // 页面侧代码**必须是字符串**：tsx/esbuild 会给内联函数（尤其是里面的具名 const 箭头函数）
  // 包上 `__name(...)` 助手，而 Playwright 把函数源码丢进页面执行 → 页面里没有 `__name`。
  // 实测踩到过一次（`page.evaluate` 直接 ReferenceError），`dist/` 由 tsc 编译不受影响。
  return page.evaluate<string | null>(`(() => {
    const images = Array.from(document.querySelectorAll("img"));
    const qr = images.find(function (image) {
      const source = image.currentSrc || image.src || "";
      // 只认 data URL 的大图：登录页上还有一堆 CDN 小图标（logo/插图），不能误取。
      return source.indexOf("data:image/png") === 0 && image.naturalWidth >= 200;
    });
    return qr ? (qr.currentSrc || qr.src) : null;
  })()`);
}

/**
 * 读作者昵称（**仅用于界面展示，绝不用作任何判据**）。
 *
 * 选择器目前是待侦察校准的候选：Task 1 的只读侦察会拿到真实 DOM，届时按证据收窄。
 * 读不到就返回 undefined —— 昵称读不到不该阻塞登录（登录态由 URL 判定）。
 */
export async function readUsername(page: ToutiaoPageLike): Promise<string | undefined> {
  const value = await page
    .evaluate<string>(`(() => {
      const candidates = [
        ".auth-avator-name",
        "[class*='avator-name']",
        "[class*='avatar-name']",
        "[class*='user-name']",
      ];
      for (const selector of candidates) {
        const element = document.querySelector(selector);
        const text = element && element.textContent ? element.textContent.trim() : "";
        if (text) return text;
      }
      return "";
    })()`)
    .catch(() => "");
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

interface LoginSession {
  session: ToutiaoBrowserSession;
  startedAt: number;
  expiresAt: number;
}

export class ToutiaoRunner {
  private readonly now: () => number;
  private readonly loginTimeoutMs: number;
  private readonly profileDir: string;
  private loginSession: LoginSession | undefined;
  /** 启动中的登录会话（同步置位）：没有它，两个并发请求会各开一个浏览器并互相覆盖。 */
  private loginStarting = false;
  private exitCleanupInstalled = false;

  constructor(private readonly config: ToutiaoRunnerConfig) {
    this.now = config.now ?? (() => Date.now());
    this.loginTimeoutMs = config.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    try {
      this.profileDir = resolveToutiaoProfileDir(config.storageRoot, config.profileDir);
    } catch (error) {
      if (error instanceof ToutiaoBrowserError) {
        throw new ToutiaoRunnerError(error.code, error.message);
      }
      throw error;
    }
  }

  /** 配置自检：解析不到浏览器时立刻抛错（必须发生在写入任何记录之前）。 */
  assertConfigured(): void {
    requireToutiaoTarget(this.config);
  }

  get profileDirectory(): string {
    return this.profileDir;
  }

  /**
   * 零副作用自检：只开首页判登录态 + 读昵称，不填任何表单、不解锁任何东西。
   * 与公众号通路的账号自检探针同一地位（用户唯一必须手工做的事，文案必须可执行）。
   */
  async checkLogin(): Promise<ToutiaoLoginState> {
    const session = await this.openSession();
    try {
      // **判定前要给它落在终点的机会**（真机实测 2026-09-18）：应用刚启动时第一次自检报「未登录」，
      // 几秒后再查同一份 profile 却是「已登录（昵称）」—— 首页那次跳转还没完成就下了结论。
      // 假阴性的代价不小：发布会被拦在「登录态已失效，请重新扫码」上，用户跑去重扫一个其实好好的码。
      // 所以「停在登录页」要**再确认一次**才作数（重试后仍停在登录页才是真的没登录）。
      let url = TOUTIAO_HOME_URL;
      for (let attempt = 0; attempt < LOGIN_CHECK_ATTEMPTS; attempt += 1) {
        await session.page.goto(TOUTIAO_HOME_URL, { waitUntil: "domcontentloaded" });
        await settle(session.page);
        url = session.page.url();
        if (!isLoginUrl(url)) {
          const username = await readUsername(session.page);
          return username === undefined ? { loggedIn: true, url } : { loggedIn: true, url, username };
        }
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
      throw new ToutiaoRunnerError(
        "toutiao_login_in_progress",
        "已有一个扫码登录会话在进行中，请先扫完当前二维码或点「取消」，再重新获取。",
      );
    }
    await this.discardSession();
    this.loginStarting = true;

    let session: ToutiaoBrowserSession;
    try {
      session = await this.openSession();
    } catch (error) {
      this.loginStarting = false;
      throw error;
    }
    try {
      await session.page.goto(TOUTIAO_LOGIN_URL, { waitUntil: "domcontentloaded" });
      await settle(session.page);
      const qrDataUrl = await readQrDataUrl(session.page);
      if (!qrDataUrl) {
        throw new ToutiaoRunnerError(
          "toutiao_qr_unavailable",
          "没能从头条登录页取到二维码（页面结构可能已改版）。请稍后重试；若持续失败，请按 AGENTS.md 的故障排查跑一次只读侦察脚本。",
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

  /** 轮询登录状态：`waiting` / `logged_in` / `expired` / `idle`。 */
  async pollLogin(): Promise<{ status: ToutiaoLoginStatus; username?: string }> {
    const active = this.loginSession;
    if (!active) return { status: "idle" };

    if (this.now() >= active.expiresAt) {
      await this.discardSession();
      return { status: "expired" };
    }

    const url = active.session.page.url();
    if (isLoginUrl(url)) return { status: "waiting" };

    const username = await readUsername(active.session.page);
    // 登录成功：会话已经落在 profile 目录里，浏览器可以关掉（避免常驻一个进程）。
    await this.discardSession();
    return username === undefined ? { status: "logged_in" } : { status: "logged_in", username };
  }

  /**
   * 打开一个**有头浏览器窗口**让用户扫码登录（与抖音那套 `qr-login` 同一交互）。
   *
   * 为什么要有这条路：头条号登录态是浏览器 profile，用户在窗口里扫码比「把二维码截图搬到界面上再扫」
   * 少一步心智负担；而且**登录一次之后，只读侦察脚本与发布都复用同一个 profile**，不必再扫码。
   *
   * 实现是同步的（与抖音通路一致）：请求挂着直到「扫码成功 / 超时」，前端显示等待态。
   * 无论成功、超时还是抛错，`finally` 里都会关闭浏览器 —— 绝不留下常驻窗口或孤儿进程。
   */
  async loginInWindow(options: { timeoutMs?: number } = {}): Promise<{
    loggedIn: boolean;
    username?: string;
    message: string;
  }> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WINDOW_LOGIN_TIMEOUT_MS;
    let resolution;
    try {
      resolution = resolveToutiaoHeadedBrowser(browserConfigOf(this.config));
    } catch (error) {
      // 显式配置指向不存在的文件时解析会直接抛 ToutiaoBrowserError：统一成 runner 的错误类型，
      // 调用方与路由层只需要认一种（两者的 `status`/`code` 本来就一致）。
      if (error instanceof ToutiaoBrowserError) throw new ToutiaoRunnerError(error.code, error.message);
      throw error;
    }
    if (!resolution.target) {
      throw new ToutiaoRunnerError(
        "toutiao_browser_unavailable",
        [
          "本机没有可用于「打开浏览器扫码」的浏览器（打包进来的是无头专用构建，开不了窗口）。二选一：",
          "① 装上 Google Chrome（系统自带的那个就行），或者",
          "② 运行 npx playwright install chromium（下载可显示窗口的完整 chromium，约 330MB），",
          "然后重试；也可以直接用界面上的「应用内扫码」（无头取二维码，不需要窗口）。",
          `逐层诊断：${describeAttempts(resolution.attempts)}`,
        ].join(""),
      );
    }

    const launch = this.config.launch ?? defaultLaunch;
    const session = await launch({
      profileDir: this.profileDir,
      target: resolution.target,
      headless: false,
    });

    try {
      await session.page.goto(TOUTIAO_LOGIN_URL, { waitUntil: "domcontentloaded" });
      const deadline = this.now() + timeoutMs;
      while (this.now() < deadline) {
        await sleep(WINDOW_LOGIN_POLL_MS);
        const url = session.page.url();
        if (!isLoginUrl(url)) {
          const username = await readUsername(session.page);
          return {
            loggedIn: true,
            ...(username ? { username } : {}),
            message: username
              ? `登录成功：${username}（登录态已保存在本机 storage 的头条会话目录里）`
              : "登录成功（登录态已保存在本机 storage 的头条会话目录里）",
          };
        }
      }
      return {
        loggedIn: false,
        message: `等待扫码超时（${Math.round(timeoutMs / 1000)} 秒）：请重新点「打开浏览器扫码登录」再试一次。`,
      };
    } finally {
      await closeQuietly(session);
    }
  }

  /**
   * 在头条号发布一篇文章。
   *
   * 与登录共用同一条浏览器启动路径（同一个 profile 目录 → 复用登录态），但**自建 context**
   * 并在 `finally` 里关闭：绝不因为一次发布失败留下常驻浏览器。
   *
   * 每一步都在 `toutiao-page.ts` 里做读回校验；任何一步失败都**停在点「发布」之前**并返回
   * `ok: false`（不抛异常，让上层把原因记进 `autoPublish.message`）。
   */
  async publishArticle(
    input: ToutiaoPublishInput,
    options: { dryRun?: boolean } = {},
  ): Promise<ToutiaoPublishResult> {
    const steps: string[] = [];
    const session = await this.openSession();
    const page = session.page as unknown as ToutiaoPublishPageLike;
    // 失败路径也要如实记录正文是怎么进去的（写死 "rich" 会在退化时误导排查）。
    let bodyMode: "rich" | "plain" = "rich";

    try {
      await gotoPublishPage(page, TOUTIAO_PUBLISH_URL);
      steps.push("进入发布页");

      await fillTitle(page, input.title);
      steps.push(`填标题（${[...input.title].length} 字）`);

      bodyMode = await fillBodyHtml(page, input.articleHtml, splitParagraphs(input.articleText));
      steps.push(bodyMode === "rich" ? "粘正文（富文本）" : "填正文（纯文本，排版已退化）");

      await uploadCover(page, input.coverPath);
      steps.push("上传封面");

      await setFirstPublish(page, input.firstPublish);
      if (input.firstPublish) steps.push("勾选头条首发");

      await setDeclarations(page, input.declarations);
      if (input.declarations.length > 0) steps.push(`设置作品声明（${input.declarations.length} 条）`);

      // 头条默认勾选「同时发布微头条」：不关就会在用户不知情时多发一条内容。
      if (!input.crossPostWeitoutiao) {
        await ensureWeitoutiaoUnchecked(page);
        steps.push("关闭「同时发布微头条」");
      }

      if (options.dryRun) {
        // **演练模式**：所有步骤都真的做了（填标题、粘正文、传封面、关微头条、勾首发/声明），
        // 但**绝不点「预览并发布」**。用途只有一个：在真实页面上验证读取/填写/上传链路，
        // 而不产生任何提交（唯一副作用是头条会把页面自动存成草稿）。
        steps.push("演练：已完成到点「发布」之前（未提交）");
        return {
          ok: true,
          message: `演练完成，未点「发布」（${steps.join(" → ")}）`,
          url: page.url(),
          verification: "unconfirmed",
          bodyMode,
          steps,
        };
      }

      const submitted = await submitAndConfirm(page);
      steps.push(submitted.confirmClicked ? "点击发布并确认" : "点击「预览并发布」（未找到确认按钮）");

      if (!submitted.confirmClicked) {
        // **绝不谎报**：只点了「预览并发布」而没有确认，事实上什么都没发出去。
        return {
          ok: false,
          message:
            `只点了「预览并发布」，但没有找到确认按钮（${steps.join(" → ")}）：`
            + "本次未提交任何内容，请先到头条后台确认没有产生草稿/文章，再重试。"
            + (submitted.diagnostics.length > 0
              ? `当时页面上的可见按钮是：${submitted.diagnostics}（把这段发给维护者即可校准选择器）。`
              : "若页面结构确已改版，请按 AGENTS.md 的故障排查跑一次只读侦察脚本。"),
          url: submitted.url,
          verification: "unconfirmed",
          bodyMode,
          steps,
        };
      }

      return submitted.signal.length > 0
        ? {
            ok: true,
            message: `页面提示「${submitted.signal}」（${steps.join(" → ")}）`,
            url: submitted.url,
            verification: "confirmed",
            bodyMode,
            steps,
          }
        : {
            ok: true,
            // 把「确认后页面长什么样」一起带回去：2026-09-20 真机第一次成功时，
            // 确认按钮命中了、文章也真发出去了，但我们读不到成功文案 → 如实记 unconfirmed，
            // 而当时页面是什么样没留下，成功提示只能靠人回忆。现在**每次都带证据**。
            message:
              `已点击发布，但未能从页面确认结果（${steps.join(" → ")}）：请先到头条后台「内容管理」核实是否已发出，再决定是否重试。`
              + `（确认后页面：${submitted.postConfirm.url}`
              + `${submitted.postConfirm.leftPublishPage ? "，已离开发布页" : "，仍停在发布页"}`
              + `${submitted.postConfirm.excerpt.length > 0 ? `；可见文案：「${submitted.postConfirm.excerpt}」` : ""}）`,
            url: submitted.url,
            verification: "unconfirmed",
            bodyMode,
            steps,
          };
    } catch (error) {
      // 页面步骤的可预期失败（选择器没命中、读回对不上）**以及** Playwright 自己的
      // TimeoutError / detached 之类，都收敛成 `ok: false`：
      // 抛出去会变成 500，而 `autoPublish` 会停在 `running` 直到 30 分钟僵死阈值
      //（按钮灰掉、界面只说「正在进行中」）——评审指出过这条路径。
      const detail = errorText(error);
      return {
        ok: false,
        message: error instanceof ToutiaoPageError
          ? `${error.message}（已完成的步骤：${steps.length > 0 ? steps.join(" → ") : "无"}）`
          : `发布过程中出现意外错误：${detail}（已完成的步骤：${steps.length > 0 ? steps.join(" → ") : "无"}）`,
        verification: "unconfirmed",
        bodyMode,
        steps,
      };
    } finally {
      await closeQuietly(session);
    }
  }

  async cancelLogin(): Promise<void> {
    await this.discardSession();
  }

  /** 关闭当前登录会话与浏览器（幂等）。 */
  async dispose(): Promise<void> {
    await this.discardSession();
  }

  /**
   * 尽力而为的退出清理：进程退出/收到信号时把登录会话用的浏览器关掉。
   *
   * spec §4.3 明确要求（本项目吃过「9 个孤儿无头浏览器」的亏）：留着登录会话直接退应用，
   * 会留下一个仍持有 profile 目录的无头 Chromium，下次启动会以奇怪的方式失败。
   * 只注册一次；`SIGINT/SIGTERM` 上不 `process.exit`，交回默认行为。
   */
  installExitCleanup(): void {
    if (this.exitCleanupInstalled) return;
    this.exitCleanupInstalled = true;
    const cleanup = () => {
      void this.discardSession();
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }

  private async discardSession(): Promise<void> {
    const active = this.loginSession;
    this.loginSession = undefined;
    if (active) await closeQuietly(active.session);
  }

  private async openSession(): Promise<ToutiaoBrowserSession> {
    return openToutiaoSession(this.config);
  }
}

/** 只保留浏览器解析用得上的字段（runner 专属的 storageRoot/launch/now… 不该传进去）。 */
function browserConfigOf(config: ToutiaoRunnerConfig): ToutiaoBrowserConfig {
  const { storageRoot, profileDir, launch, now, loginTimeoutMs, ...browser } = config;
  void storageRoot;
  void profileDir;
  void launch;
  void now;
  void loginTimeoutMs;
  return browser;
}

/**
 * 解析浏览器目标。失败文案（含三条可照抄的命令与逐层诊断）只在 `toutiao-browser.ts` 里有一份，
 * 这里只负责把错误类型换成 runner 的（路由层按 `code` 分类）。
 */
function requireToutiaoTarget(config: ToutiaoRunnerConfig): ToutiaoBrowserTarget {
  const resolution = resolveToutiaoBrowser(browserConfigOf(config));
  if (!resolution.target) {
    throw new ToutiaoRunnerError(
      "toutiao_browser_unavailable",
      `${TOUTIAO_BROWSER_GUIDANCE}\n逐层诊断：${describeAttempts(resolution.attempts)}`,
    );
  }
  return resolution.target;
}

/**
 * 打开一个持久化会话。
 *
 * **产品通路与只读侦察脚本共用这一条路径**（脚本里直接调它）—— 否则「脚本能跑、产品跑不起来」
 * 这类差异会等到人工复核才被发现。
 */
export async function openToutiaoSession(config: ToutiaoRunnerConfig): Promise<ToutiaoBrowserSession> {
  const target = requireToutiaoTarget(config);
  let profileDir: string;
  try {
    profileDir = resolveToutiaoProfileDir(config.storageRoot, config.profileDir);
  } catch (error) {
    if (error instanceof ToutiaoBrowserError) throw new ToutiaoRunnerError(error.code, error.message);
    throw error;
  }
  const launch = config.launch ?? defaultLaunch;
  try {
    return await launch({ profileDir, target });
  } catch (error) {
    // 头条自己的错误原样透出（别再包一层，否则原始指引会被埋掉）。
    if (error instanceof ToutiaoRunnerError) throw error;
    // **启动失败必须带原因 + 带动作**：此前这里什么都不做，Playwright 的原始异常（例如
    // `launchPersistentContext: EPERM: operation not permitted, mkdir '<profileDir>'`）
    // 直接冒到路由层 → 落进兜底 500「发布服务暂时不可用，请稍后重试」，
    // 用户在界面上既看不到原因、也没有任何可照抄的动作（2026-09-18 应用内实测）。
    throw new ToutiaoRunnerError(
      "toutiao_browser_unavailable",
      [
        `头条浏览器启动失败：${errorText(error)}`,
        "可照抄的动作：① 重新拉取打包资源 `npm run prepare:package:mac`；",
        "② 或装一个 `npx playwright install chromium`；",
        "③ 或用 `TOUTIAO_BROWSER_BINARY=<Chromium 系可执行文件>` 指定另一个浏览器，然后重启后端。",
        `（当前会话目录：${profileDir}；若报的是「不可写/EPERM」，请确认 storage 目录可写，`,
        "或用 `TOUTIAO_PROFILE_DIR` 指向 storage 内另一个可写目录后重启后端。）",
      ].join(""),
    );
  }
}

/** 把任意抛出物转成可读文本（`Error` 取 message，其余 `String()`）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 真实启动器：**持久化上下文**（登录态靠浏览器 profile 留存），无头运行。 */
async function defaultLaunch(options: ToutiaoLaunchOptions): Promise<ToutiaoBrowserSession> {
  const { mkdir } = await import("node:fs/promises");
  // **我们自己建会话目录，失败就说清楚是哪一步**：交给 Playwright 建的话，目录不可写时
  // 只会得到一句 `launchPersistentContext: EPERM … mkdir`，看不出是权限问题还是浏览器问题。
  try {
    await mkdir(options.profileDir, { recursive: true });
  } catch (error) {
    throw new ToutiaoRunnerError(
      "toutiao_profile_dir_unsafe",
      `头条会话目录不可写，无法创建：${options.profileDir}（${errorText(error)}）。`
      + "请确认 storage 目录存在且当前用户可写，或用 TOUTIAO_PROFILE_DIR 指向 storage 内的另一个可写目录后重启后端。",
    );
  }

  const { chromium } = await import("playwright");
  const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: options.headless !== false,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
  };
  if (options.target.kind === "executablePath") {
    launchOptions.executablePath = options.target.path;
  } else if (options.target.kind === "channel") {
    launchOptions.channel = options.target.channel;
  }

  const context = await chromium.launchPersistentContext(options.profileDir, launchOptions);
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    page: page as unknown as ToutiaoPageLike,
    close: () => context.close(),
  };
}

async function settle(page: ToutiaoPageLike): Promise<void> {
  await page.waitForTimeout?.(NAVIGATION_SETTLE_MS);
}

/**
 * 「是否未登录」要确认几次才作数。
 *
 * 首页跳转是异步的：第一次读到的 URL 可能还停在登录页（真机实测的假阴性），所以至少两次。
 * 两次都停在登录页才算真的没登录 —— 重试只是给页面落地的机会，不放松判定。
 */
const LOGIN_CHECK_ATTEMPTS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 纯文本兜底用：按空行切段（与文章正文的段落语义一致）。 */
function splitParagraphs(text: string): string[] {
  return (text ?? "")
    .split(/\n{2,}/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function closeQuietly(session: ToutiaoBrowserSession): Promise<void> {
  await session.close().catch(() => undefined);
}
