/**
 * 小红书创作服务平台发布页 **只读侦察**探针（零副作用）。
 *
 * 为什么需要它：我们要接的「小红书图文自动发布」这条通路，参考项目的选择器
 * **最新也只到 2026-09-10、多数是 2026-03 甚至 2026-01**，而且 8 个参考实现里
 * **没有一个**做过「提交前读回」，所以它们的写法只能当线索、不能当依据
 *（详见 `docs/research/xhs-publish-projects-assessment.md` §3）。
 * 选择器必须来自我们自己账号上的实测证据 —— 与头条那次同一个结论。
 *
 * 它**只做**这几件事：
 *   1. 用持久化 profile 启动浏览器（会话落 `storage/xhs/profile`，登录态不出 storage）；
 *   2. 未登录时从登录页 DOM 取出二维码 → 落盘 PNG + 打印路径（用小红书 App 扫码）；
 *   3. 轮询到登录成功；
 *   4. 进发布页，落盘完整 DOM 快照 + 打印各候选选择器的命中数与元素摘要；
 *   5. 用 `--tab` 时可以点一下「上传图文」页签（**只是切模式**）再看表单的 DOM；
 *   6. 关闭浏览器。
 *
 * 它**绝不**：填标题、写正文、传图片、点任何提交类按钮、点「发布」、点「存草稿」、
 * 点「定时发布」。默认**也不**往编辑器里派发粘贴事件 —— 小红书可能自动存草稿，
 * 而我们的原则是这一步零副作用（要验证粘贴能力请显式加 `--paste-probe`，见下）。
 *
 * 用法（仓库根目录）：
 *
 * ```bash
 * # ① 只登录（默认无头，二维码落盘后你自己打开看；需要真实窗口就加 --headed）
 * node --import tsx scripts/probe-xhs-publish-page.ts --login
 * node --import tsx scripts/probe-xhs-publish-page.ts --login --headed
 *
 * # ② 侦察发布页（复用 profile 的登录态，所以不用再扫码）
 * node --import tsx scripts/probe-xhs-publish-page.ts
 *
 * # ③ 先点「上传图文」页签再侦察（只切模式，不填表不传图）
 * node --import tsx scripts/probe-xhs-publish-page.ts --tab
 *
 * # 可选环境变量：
 * #   XHS_BROWSER_BINARY   指定 Chromium 系可执行文件
 * #   XHS_PROFILE_DIR      会话目录覆盖（必须落在 storage 内）
 * #   STORAGE_PATH         storage 根目录覆盖
 * #   XHS_PROBE_TIMEOUT_MS 扫码等待上限（默认 300000）
 * ```
 *
 * 退出码：侦察完成 0；未登录成功 / 发布页打不开 1。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { runCommand } from "../src/lib/command.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const storageRoot = path.resolve(process.env.STORAGE_PATH ?? path.join(rootDir, "storage"));
const profileDir = path.resolve(process.env.XHS_PROFILE_DIR ?? path.join(storageRoot, "xhs", "profile"));
const reconDir = path.join(storageRoot, "xhs", "recon");
const waitMs = Number(process.env.XHS_PROBE_TIMEOUT_MS ?? 300_000);

/** 创作服务平台首页与发布页。发布页带 `target=image` 是参考项目实测出来的写法（能直接落在图文表单）。 */
const CREATOR_HOME = "https://creator.xiaohongshu.com/";
const PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?source=official&target=image";

/**
 * 「已进入可操作页面」的信号（源自 `SvenKunkka/xhs-auto-deepseek:739`，我们只做证据采集，不照抄结论）。
 * 判定口径是 **READY ∧ ¬BLOCKER**：access-token-creator / galaxy_creator_session_id 这类 cookie
 * **未登录访客也会被种**，所以 cookie 只能当旁证（同一文件 :754-767 的实测记录）。
 */
const READY_SELECTORS = [
  'input[placeholder*="标题"]',
  "div.ProseMirror",
  "div.ql-editor",
  'div[contenteditable="true"]',
  'input[type="file"]',
  '[class*="creator-tab"]',
];

const BLOCKER_SELECTORS = [
  'img[src*="qrcode"]',
  '[class*="qrcode"]',
  '[class*="login"]',
  'text=扫码登录',
  'text=手机号登录',
];

/** 标题 / 正文 / 话题 / 发布按钮的候选（跨项目共识 + 兜底），命中数就是证据。 */
const TITLE_CANDIDATES = [
  'input[placeholder*="标题"]',
  'div.d-input input',
  "input.d-text",
  'input[placeholder*="填写标题"]',
  "textarea",
];

const EDITOR_CANDIDATES = [
  'div.ProseMirror[contenteditable="true"]',
  "div.tiptap.ProseMirror",
  'div[contenteditable="true"]',
  "div.ql-editor",
  "#post-textarea",
  'p[data-placeholder*="正文"]',
];

const TOPIC_CANDIDATES = [
  "#creator-editor-topic-container .item",
  ".publish-topic-item",
  'div[class*="topic"] .item',
  'ul[class*="topic"] li',
  'input[placeholder*="话题"]',
  '[class*="topic-container"]',
  '[class*="hash-tag"]',
];

const PUBLISH_BUTTON_CANDIDATES = [
  "div.publish-page-publish-btn button",
  "button.publishBtn",
  ".publish-page-publish-btn button.bg-red",
  'button:has-text("发布")',
];

/** 合规相关：AI 合成内容标识 / 内容类型声明（2026-02-12 公告要求，未标识会被限制分发）。 */
const DECLARATION_TEXT_CANDIDATES = [
  "添加内容类型声明",
  // ⚠️ **选中之后控件文案会变成所选项**（2026-09-21 实测）：所以「添加内容类型声明」在演练后
  // 必然是 0 命中，而这一项才是当时该看到的。少了它，报告会让人误以为「声明控件消失了」。
  "笔记含AI合成内容",
  "内容类型声明",
  "AI合成内容",
  "AI 合成内容",
  "AI生成",
  "声明原创",
  "原创声明",
];

/** 这些文案是否存在，决定「自动发布」会不会误触到别的动作。 */
const OTHER_TEXT_CANDIDATES = [
  "上传图文",
  "上传视频",
  "写长文",
  "存草稿",
  "定时发布",
  "发布笔记",
  "发布",
];

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function bytesToKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/**
 * 浏览器解析链。**这是探针自带的简化版**：真正的产品模块
 * （`xhs-browser.ts`）要等设计评审通过后再写，届时按头条 `toutiao-browser.ts`
 * 的形状落地（显式配置 → env → vendor → Playwright 缓存 → 系统 Chrome，并逐层记录）。
 * 这里先保证「探针能在本机跑起来」。
 */
function resolveBrowser(headed: boolean): { executablePath?: string; channel?: "chrome"; detail: string } {
  const explicit = process.env.XHS_BROWSER_BINARY?.trim();
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`XHS_BROWSER_BINARY 指向的文件不存在：${explicit}（不静默退到下一层）`);
    }
    return { executablePath: explicit, detail: `显式配置: ${explicit}` };
  }

  if (headed) {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(chrome)) return { channel: "chrome", detail: `系统 Chrome（有头）: ${chrome}` };
    throw new Error("--headed 需要系统安装 Google Chrome（打包的 headless shell 开不了窗口）");
  }

  // vendor：<repo>/vendor/package-assets/browser/chrome-headless-shell/<平台-架构-版本>/<三元组>/chrome-headless-shell
  const vendoredRoot = path.join(rootDir, "vendor", "package-assets", "browser", "chrome-headless-shell");
  if (existsSync(vendoredRoot)) {
    const versions = readdirSync(vendoredRoot).sort().reverse();
    for (const version of versions) {
      const versionDir = path.join(vendoredRoot, version);
      for (const triple of readdirSync(versionDir)) {
        const candidate = path.join(versionDir, triple, "chrome-headless-shell");
        if (existsSync(candidate)) {
          return { executablePath: candidate, detail: `打包资源: ${candidate}` };
        }
      }
    }
  }

  return { channel: "chrome", detail: "回退到系统 Chrome（channel=chrome）" };
}

async function launch(headed: boolean): Promise<BrowserContext> {
  await mkdir(profileDir, { recursive: true });
  const target = resolveBrowser(headed);
  console.log(`浏览器: ${target.detail}`);
  console.log(`会话目录: ${profileDir}`);

  return chromium.launchPersistentContext(profileDir, {
    headless: !headed,
    ...(target.executablePath ? { executablePath: target.executablePath } : {}),
    ...(target.channel ? { channel: target.channel } : {}),
    viewport: { width: 1440, height: 900 },
    // 2 倍像素密度：二维码做元素截图时拿到的就是页面上真实渲染尺寸（不做的话元素截图可能只有 128px）。
    deviceScaleFactor: 2,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

interface LoginSignals {
  url: string;
  ready: Array<{ selector: string; count: number }>;
  blockers: Array<{ selector: string; count: number }>;
  hasQr: boolean;
}

/**
 * 页面侧代码**必须以字符串下发**（本项目 2026-09-18 实测的坑）：
 * tsx/esbuild 会给内联函数包上 `__name(...)` 助手，而 Playwright 是把函数源码序列化后
 * 丢进页面执行 → 页面里没有 `__name`，直接 `ReferenceError`（`dist/` 由 tsc 编译不受影响）。
 * 另外：这段是模板字符串，**内层不要出现反引号与 `${`**（会把字符串截断）。
 */
const READ_SIGNALS = `(() => {
  const count = (selector) => {
    try { return document.querySelectorAll(selector).length; } catch (error) { return -1; }
  };
  const hasQr = Array.from(document.querySelectorAll("img, canvas")).some((element) => {
    const src = element.getAttribute("src") || "";
    if (src.indexOf("data:image") === 0) return true;
    const background = getComputedStyle(element).backgroundImage || "";
    return background.indexOf("data:image") >= 0;
  });
  return JSON.stringify({
    url: location.href,
    ready: READY.map((selector) => ({ selector: selector, count: count(selector) })),
    blockers: BLOCKER.map((selector) => ({ selector: selector, count: count(selector) })),
    hasQr: hasQr,
  });
})()`;

async function readSignals(page: Page): Promise<LoginSignals> {
  const expression = `((READY, BLOCKER) => ${READ_SIGNALS})(${JSON.stringify(READY_SELECTORS)}, ${JSON.stringify(BLOCKER_SELECTORS)})`;
  const raw = await page.evaluate<string>(expression);
  return JSON.parse(raw) as LoginSignals;
}

function looksLoggedIn(signals: LoginSignals): boolean {
  if (signals.url.includes("/login")) return false;
  // 有登录阻断信号（二维码/登录弹层）就是没登录 —— 这一条最硬，优先判。
  if (signals.blockers.some((item) => item.count > 0)) return false;
  const ready = signals.ready.some((item) => item.count > 0);
  if (ready) return true;
  /**
   * ⚠️ **READY 选择器是「发布页」的 DOM**（标题框 / 编辑器 / 文件框 / 页签），
   * 而扫码成功后平台会把人送到**创作中心首页** `/new/home` —— 那里这些选择器**全部为 0**。
   *
   * 实测（2026-09-20）：第一版把 READY 命中当成**必要条件**，于是用户扫码成功后探针
   * 还在原地傻等到超时（日志里只有一行「URL 变化: …/new/home」）。所以补一条：
   * **已经离开登录页 + 无任何登录阻断信号 = 已登录**。
   */
  return signals.url.startsWith("https://creator.xiaohongshu.com/");
}

/** 从登录页 DOM 取二维码（data URL）：先找 img[src^=data:]，再找 canvas，最后看 CSS 背景图。 */
const EXTRACT_QR = `(() => {
  const score = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height;
  };
  const candidates = [];
  for (const image of Array.from(document.querySelectorAll("img"))) {
    const src = image.getAttribute("src") || "";
    if (src.indexOf("data:image") === 0) candidates.push({ dataUrl: src, source: "img[src=data:]", area: score(image) });
  }
  for (const canvas of Array.from(document.querySelectorAll("canvas"))) {
    try {
      const dataUrl = canvas.toDataURL("image/png");
      if (dataUrl && dataUrl.length > 200) candidates.push({ dataUrl: dataUrl, source: "canvas.toDataURL", area: score(canvas) });
    } catch (error) { /* 跨域画布 */ }
  }
  for (const element of Array.from(document.querySelectorAll("*"))) {
    const background = getComputedStyle(element).backgroundImage || "";
    const match = background.match(/url\\("?(data:image[^")]+)"?\\)/);
    if (match) candidates.push({ dataUrl: match[1], source: "css-background", area: score(element) });
  }
  if (candidates.length === 0) return "";
  candidates.sort((left, right) => right.area - left.area);
  return JSON.stringify(candidates[0]);
})()`;

/**
 * 登录卡片右上角的「切换扫码登录」图标。
 *
 * **实测（2026-09-20 本探针第一版）**：创作服务平台登录页**默认是「短信登录」模式**
 * （手机号 + 验证码 + 登录按钮），根本没有二维码 —— 第一版把面积最大的 data: URL 图当二维码，
 * 取到的其实是这个 64×64 的**切换图标**（class `css-wemwzq`，natural 128×128）。
 * 参考项目 `jogholy/xhs-publisher:112` 用的正是这个 class，而它的动作是 **click**（切模式），
 * 与我们的证据完全吻合。
 *
 * 类名是哈希的、随时会变，所以这里给一条阶梯 + **点击后的验证**：
 * 只有真的出现了「更大的二维码元素」才算切换成功，不然如实报失败（不假装拿到了码）。
 */
const QR_TOGGLE_CANDIDATES = [
  "img.css-wemwzq",
  '[class*="qrcode"] img',
  'img[src*="qrcode"]',
  '[class*="scan"] img',
  '[class*="switch"] img',
];

/** 切换到扫码登录模式。返回是否**验证通过**（点完确实出现了像二维码的东西）。 */
async function switchToQrMode(page: Page): Promise<boolean> {
  for (const selector of QR_TOGGLE_CANDIDATES) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count === 0) continue;
    console.log(`  尝试点击「切换到扫码登录」：${selector}（命中 ${count} 个）`);
    await page.locator(selector).first().click({ timeout: 5_000 }).catch((error: unknown) => {
      console.log(`    点击失败：${error instanceof Error ? error.message : String(error)}`);
    });
    await page.waitForTimeout(3_000);

    // 验证：切换成功后，页面上应该出现一个明显更大的二维码容器。
    const biggest = await page.evaluate<string>(`(() => {
      let best = 0;
      let detail = "";
      const consider = (element, kind) => {
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > best) {
          best = area;
          detail = kind + " " + Math.round(rect.width) + "x" + Math.round(rect.height);
        }
      };
      for (const image of Array.from(document.querySelectorAll("img, canvas"))) {
        const src = image.getAttribute("src") || "";
        if (src.indexOf("data:image") === 0 || image.tagName === "CANVAS") consider(image, image.tagName);
      }
      for (const element of Array.from(document.querySelectorAll("*"))) {
        const background = getComputedStyle(element).backgroundImage || "";
        if (background.indexOf("data:image") >= 0) consider(element, "css-bg");
      }
      return JSON.stringify({ area: Math.round(best), detail: detail });
    })()`);
    const parsed = JSON.parse(biggest) as { area: number; detail: string };
    // 64×64 的切换图标面积约 4096；真二维码通常 ≥ 150×150（面积 ≥ 22500）。
    if (parsed.area >= 20_000) {
      console.log(`  ✅ 已切到扫码模式（当前最大二维码候选：${parsed.detail}）`);
      return true;
    }
    console.log(`  ⚠️ 点完仍没有像二维码的元素（最大候选：${parsed.detail || "无"}），继续试下一个候选`);
  }
  return false;
}

/**
 * 二维码失效后的自动刷新。
 *
 * 为什么要它：第一次实测时我们的轮询窗口是 5 分钟，而**平台的二维码本身会先过期**
 * （页面上会出现「二维码已失效／点击刷新」这类文案）。窗口再长也没用 ——
 * 用户看到的是一个已经失效的码。所以这里主动检测失效文案并点一下刷新，然后把**新的**码落盘。
 *
 * 只点「刷新二维码」这一类**非提交类**节点；点不到就退回重新点一次「切换扫码登录」。
 */
const REFRESH_QR = `(() => {
  const markers = ["二维码已失效", "已失效", "点击刷新", "刷新二维码", "重新获取", "重新加载"];
  const nodes = Array.from(document.querySelectorAll("div, span, p, button, a"));
  for (const node of nodes) {
    if (node.children.length !== 0) continue;
    const text = (node.textContent || "").trim();
    if (!text) continue;
    for (const marker of markers) {
      if (text.indexOf(marker) >= 0) {
        node.click();
        return text;
      }
    }
  }
  return "";
})()`;

async function tryExtractQr(page: Page): Promise<{ dataUrl: string; source: string; area: number } | null> {
  const raw = await page.evaluate<string>(EXTRACT_QR);
  return raw ? (JSON.parse(raw) as { dataUrl: string; source: string; area: number }) : null;
}

/**
 * 取出「像二维码」的那个元素：**面积门槛是必须的**。
 *
 * 登录页右上角那个「切换扫码登录」图标也是 data: URL 图，面积只有 64×64=4096，
 * 第一版探针就把它当成了二维码（看着像码、其实不是）。真码实测是 196×196。
 */
async function pickQr(page: Page): Promise<{ dataUrl: string; source: string; area: number } | null> {
  const qr = await tryExtractQr(page);
  return qr && qr.area >= 20_000 ? qr : null;
}

/** 落盘二维码：写一份带时间戳的，**同时**写一份稳定路径 `login-qrcode-latest.png`（省得每次找文件名）。 */
async function writeQrFile(qr: { dataUrl: string }, label: string): Promise<string> {
  const base64 = qr.dataUrl.replace(/^data:image\/\w+;base64,/u, "");
  const buffer = Buffer.from(base64, "base64");
  await mkdir(reconDir, { recursive: true });
  const qrPath = path.join(reconDir, `login-qrcode-${label}-${stamp()}.png`);
  await writeFile(qrPath, buffer);
  await writeFile(path.join(reconDir, "login-qrcode-latest.png"), buffer);
  return qrPath;
}

/**
 * 二维码的**证据采集**：不猜「哪个元素是二维码」，而是把登录页整页截图 + 每个候选元素
 * 各自的元素截图都落盘，人工看一眼就知道选对了没有。
 *
 * 为什么需要这一步：第一版探针按「面积最大的 data: URL 图」取，结果拿到一张 **128×128** 的图 ——
 * 那既可能是真的二维码，也可能只是页面上某个图标，**光看大小判断不了**。
 * 另一个更稳的取法是对二维码容器做**元素截图**（分辨率跟着 deviceScaleFactor 走），
 * 这样不依赖源图尺寸、拿到的就是页面上真实渲染出来的码。
 */
async function captureQrEvidence(page: Page): Promise<string[]> {
  await mkdir(reconDir, { recursive: true });
  const stampValue = stamp();
  const saved: string[] = [];

  const pageShot = path.join(reconDir, `login-page-${stampValue}.png`);
  await page.screenshot({ path: pageShot, fullPage: true });
  saved.push(pageShot);

  const candidatesJson = await page.evaluate<string>(`(() => {
    const list = [];
    const push = (element, kind) => {
      const rect = element.getBoundingClientRect();
      list.push({
        kind: kind,
        tag: element.tagName,
        class: (element.className || "").toString().slice(0, 110),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        natural: element.tagName === "IMG" ? [element.naturalWidth, element.naturalHeight] : null,
        selector: (() => {
          const id = element.getAttribute("id");
          if (id) return "#" + id;
          const cls = (element.className || "").toString().trim().split(/\\s+/u).filter(Boolean)[0];
          return cls ? element.tagName.toLowerCase() + "." + cls : element.tagName.toLowerCase();
        })(),
      });
    };
    for (const image of Array.from(document.querySelectorAll("img"))) {
      const src = image.getAttribute("src") || "";
      if (src.indexOf("data:image") === 0) push(image, "img-data-url");
    }
    for (const canvas of Array.from(document.querySelectorAll("canvas"))) push(canvas, "canvas");
    for (const element of Array.from(document.querySelectorAll("*"))) {
      const background = getComputedStyle(element).backgroundImage || "";
      if (background.indexOf("data:image") >= 0) push(element, "css-background");
    }
    list.sort((left, right) => right.width * right.height - left.width * left.height);
    return JSON.stringify(list.slice(0, 8));
  })()`);

  const candidates = JSON.parse(candidatesJson) as Array<Record<string, unknown>>;
  await writeFile(path.join(reconDir, `qr-candidates-${stampValue}.json`), `${JSON.stringify(candidates, null, 2)}\n`, "utf8");

  console.log("\n二维码候选元素（按面积降序，最多 8 个）：");
  for (const candidate of candidates) {
    console.log(`  ${JSON.stringify(candidate)}`);
  }

  // 对候选做元素截图：分辨率跟着 deviceScaleFactor，拿到的是真实渲染尺寸。
  for (const [index, candidate] of candidates.slice(0, 4).entries()) {
    const selector = String(candidate.selector ?? "");
    if (!selector) continue;
    const shotPath = path.join(reconDir, `qr-candidate-${index}-${stampValue}.png`);
    try {
      await page.locator(selector).first().screenshot({ path: shotPath, timeout: 8_000 });
      saved.push(shotPath);
      console.log(`  元素截图 → ${shotPath}`);
    } catch (error) {
      console.log(`  元素截图失败（${selector}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("\n已落盘以下证据（请打开看哪个才是真二维码）：");
  for (const file of saved) console.log(`  ${file}`);
  return saved;
}

async function ensureLoggedIn(page: Page): Promise<boolean> {
  await page.goto(CREATOR_HOME, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(4_000);

  const first = await readSignals(page);
  console.log(`\n登录态信号：${first.url}`);
  if (looksLoggedIn(first)) {
    console.log("✅ 已登录（页面信号 READY ∧ 无 BLOCKER）");
    return true;
  }

  console.log("未登录：登录页默认是「短信登录」，先尝试切到扫码模式…");
  const switched = await switchToQrMode(page);
  if (!switched) {
    console.log("⚠️ 没能确认切到扫码模式（可能类名变了）。下面仍会把当前页面的证据落盘，请人工看一眼。");
  }

  console.log("\n采集登录页证据（整页截图 + 二维码候选元素截图）…");
  await captureQrEvidence(page);

  let currentQr = await pickQr(page);
  if (currentQr) {
    const qrPath = await writeQrFile(currentQr, "v1");
    console.log(`\n✅ 二维码（请用「小红书」App 扫这一张）：${qrPath}`);
    console.log(`   稳定路径（内容相同）：${path.join(reconDir, "login-qrcode-latest.png")}`);
    console.log("   本探针不填任何表单、不提交任何内容。");
  } else {
    console.log("⚠️ 没能取到足够大的二维码（最大的那个可能只是「切换扫码登录」图标）。");
    console.log("   请改用 `--headed` 打开真实浏览器窗口扫码：");
    console.log("   node --import tsx scripts/probe-xhs-publish-page.ts --login --headed");
  }

  const deadline = Date.now() + waitMs;
  let lastUrl = first.url;
  let nextRefreshAt = Date.now() + 60_000;
  let version = 1;

  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const signals = await readSignals(page).catch(() => null);
    if (signals) {
      if (signals.url !== lastUrl) {
        console.log(`   URL 变化: ${signals.url}`);
        lastUrl = signals.url;
      }
      if (looksLoggedIn(signals)) {
        console.log("✅ 扫码成功，登录态已写入 profile（之后的侦察不用再扫）。");
        return true;
      }
    }

    // 二维码轮换检测。
    //
    // 第一版靠「二维码已失效／点击刷新」这类**文案**触发刷新，实测在 15 分钟的等待窗口里
    // **一次都没命中** —— 说明要么真实文案不是这些，要么平台是**静默轮换**（直接换掉 img 的 data URL）。
    // 所以改成**以内容为准**：定期重取一次二维码，只要 data URL 变了就是新码，落盘并提示。
    // 文案仍保留为次要触发（有些实现要点一下才轮换）。
    if (Date.now() >= nextRefreshAt) {
      nextRefreshAt = Date.now() + 20_000;
      const marker = await page.evaluate<string>(REFRESH_QR).catch(() => "");
      if (marker) await page.waitForTimeout(2_500);
      const latest = await pickQr(page);
      if (latest && latest.dataUrl !== currentQr?.dataUrl) {
        version += 1;
        currentQr = latest;
        const nextPath = await writeQrFile(latest, `v${version}`);
        console.log(`   ⏳ 二维码已轮换${marker ? `（页面文案「${marker}」）` : "（静默轮换）"}，请扫新的这张：${nextPath}`);
      }
    }
  }
  console.log("❌ 等待扫码超时（二维码过期会自动刷新，但总的等待窗口用完了）。重跑一次即可。");
  return false;
}

interface ReconReport {
  url: string;
  title: string;
  signals: LoginSignals;
  fileInputs: Array<Record<string, unknown>>;
  titleCandidates: Array<{ selector: string; count: number; samples: Array<Record<string, unknown>> }>;
  editorCandidates: Array<{ selector: string; count: number; samples: Array<Record<string, unknown>> }>;
  topicCandidates: Array<{ selector: string; count: number; samples: Array<Record<string, unknown>> }>;
  publishButtons: Array<{ selector: string; count: number; samples: Array<Record<string, unknown>> }>;
  visibleButtons: Array<Record<string, unknown>>;
  tabs: Array<Record<string, unknown>>;
  declarations: Array<{ text: string; matches: Array<Record<string, unknown>> }>;
  otherTexts: Array<{ text: string; matches: Array<Record<string, unknown>> }>;
  checkboxes: Array<Record<string, unknown>>;
  inputs: Array<Record<string, unknown>>;
}

/** 采集：纯读取，不改任何页面状态（唯一例外是 `--tab` 的页签切换，由调用方决定）。 */
const COLLECT = `(input) => {
  const summarize = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      class: (element.className || "").toString().slice(0, 110),
      placeholder: element.getAttribute("placeholder"),
      type: element.getAttribute("type"),
      accept: element.getAttribute("accept"),
      multiple: element.multiple === true,
      text: (element.textContent || "").trim().slice(0, 70),
      visible: rect.width > 0 && rect.height > 0,
      rect: [Math.round(rect.width), Math.round(rect.height)],
    };
  };
  const hit = (selector) => {
    let elements = [];
    try { elements = Array.from(document.querySelectorAll(selector)); } catch (error) { elements = []; }
    return { selector: selector, count: elements.length, samples: elements.slice(0, 3).map(summarize) };
  };
  const count = (selector) => {
    try { return document.querySelectorAll(selector).length; } catch (error) { return -1; }
  };
  const textMatches = (text) =>
    Array.from(document.querySelectorAll("button, [role='button'], label, span, div, a, p"))
      .filter((element) => (element.textContent || "").trim() === text)
      .slice(0, 4)
      .map(summarize);

  return JSON.stringify({
    url: location.href,
    title: document.title,
    /** 页面**可见文本**：分阶段渲染的页面光看 HTML 会漏掉「哪些阶段有哪些控件」。 */
    visibleText: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 4000),
    signals: {
      url: location.href,
      ready: input.ready.map((selector) => ({ selector: selector, count: count(selector) })),
      blockers: input.blocker.map((selector) => ({ selector: selector, count: count(selector) })),
      hasQr: false,
    },
    fileInputs: Array.from(document.querySelectorAll("input[type='file']")).map(summarize),
    titleCandidates: input.title.map(hit),
    editorCandidates: input.editor.map(hit),
    topicCandidates: input.topic.map(hit),
    publishButtons: input.publish.map(hit),
    visibleButtons: Array.from(document.querySelectorAll("button")).map(summarize)
      .filter((item) => item.visible && item.text.length > 0).slice(0, 30),
    tabs: Array.from(document.querySelectorAll("[class*='tab'], [role='tab']")).map(summarize).slice(0, 20),
    declarations: input.declaration.map((text) => ({ text: text, matches: textMatches(text) })),
    otherTexts: input.other.map((text) => ({ text: text, matches: textMatches(text) })),
    checkboxes: Array.from(document.querySelectorAll("input[type='checkbox'], [role='checkbox'], [class*='checkbox']")).map(summarize).slice(0, 25),
    inputs: Array.from(document.querySelectorAll("textarea, input")).map(summarize).slice(0, 35),
  });
}`;

async function collect(page: Page): Promise<ReconReport> {
  const input = {
    ready: READY_SELECTORS,
    blocker: BLOCKER_SELECTORS,
    title: TITLE_CANDIDATES,
    editor: EDITOR_CANDIDATES,
    topic: TOPIC_CANDIDATES,
    publish: PUBLISH_BUTTON_CANDIDATES,
    declaration: DECLARATION_TEXT_CANDIDATES,
    other: OTHER_TEXT_CANDIDATES,
  };
  const raw = await page.evaluate<string>(`(${COLLECT})(${JSON.stringify(input)})`);
  return JSON.parse(raw) as ReconReport;
}

/** 只切模式：点「上传图文」页签。**不填表、不传图、不点发布。** */
async function clickImageTab(page: Page): Promise<boolean> {
  const clicked = await page.evaluate<string>(`(() => {
    const leaves = Array.from(document.querySelectorAll("div, span, li, a, [role='tab']"));
    const target = leaves.find((element) => {
      if (element.children.length !== 0) return false;
      return (element.textContent || "").trim() === "上传图文";
    });
    if (!target) return "";
    target.click();
    return (target.className || "").toString().slice(0, 80);
  })()`);
  if (clicked) {
    console.log(`✅ 已点击「上传图文」页签（class=${clicked}）`);
    await page.waitForTimeout(3_000);
    return true;
  }
  console.log("⚠️ 没找到文案为「上传图文」的叶子节点（可能 URL 已经直接落在图文表单上）。");
  return false;
}

function printReport(report: ReconReport, reportPath: string): void {
  console.log("\n── 登录/页面信号 ──");
  for (const item of report.signals.ready) console.log(`  ${item.count > 0 ? "✅" : "  "} READY ${item.selector} → ${item.count}`);
  for (const item of report.signals.blockers) console.log(`  ${item.count > 0 ? "⚠️" : "  "} BLOCKER ${item.selector} → ${item.count}`);

  console.log("\n── 文件框（图片上传；注意第一个可能是视频框）──");
  if (report.fileInputs.length === 0) console.log("  （没有 input[type=file]：可能是常驻框还没渲染，或需要先点页签/上传区）");
  for (const item of report.fileInputs) console.log(`  ${JSON.stringify(item)}`);

  console.log("\n── 标题候选 ──");
  for (const candidate of report.titleCandidates) {
    console.log(`  ${candidate.count > 0 ? "✅" : "  "} ${candidate.selector} → ${candidate.count}`);
    for (const sample of candidate.samples) console.log(`       ${JSON.stringify(sample)}`);
  }

  console.log("\n── 正文编辑器候选 ──");
  for (const candidate of report.editorCandidates) {
    console.log(`  ${candidate.count > 0 ? "✅" : "  "} ${candidate.selector} → ${candidate.count}`);
    for (const sample of candidate.samples) console.log(`       ${JSON.stringify(sample)}`);
  }

  console.log("\n── 话题候选（跨项目唯一没有共识的一项）──");
  for (const candidate of report.topicCandidates) {
    console.log(`  ${candidate.count > 0 ? "✅" : "  "} ${candidate.selector} → ${candidate.count}`);
    for (const sample of candidate.samples) console.log(`       ${JSON.stringify(sample)}`);
  }

  console.log("\n── 发布按钮候选（必须精确匹配：页面上还有「发布笔记」「定时发布」）──");
  for (const candidate of report.publishButtons) {
    console.log(`  ${candidate.count > 0 ? "✅" : "  "} ${candidate.selector} → ${candidate.count}`);
    for (const sample of candidate.samples) console.log(`       ${JSON.stringify(sample)}`);
  }

  console.log("\n── 页签 ──");
  for (const tab of report.tabs) console.log(`  ${JSON.stringify(tab)}`);

  console.log("\n── ⚠️ 合规：AI 合成内容标识 / 内容类型声明（2026-02-12 公告，未标识会被限制分发）──");
  for (const candidate of report.declarations) {
    const mark = candidate.matches.length > 0 ? "✅" : "❌";
    console.log(`  ${mark} 「${candidate.text}」→ ${candidate.matches.length}`);
    for (const match of candidate.matches) console.log(`       ${JSON.stringify(match)}`);
  }

  console.log("\n── 其它关键文案（决定自动发布会不会误触别的动作）──");
  for (const candidate of report.otherTexts) {
    const mark = candidate.matches.length > 0 ? "✅" : "  ";
    console.log(`  ${mark} 「${candidate.text}」→ ${candidate.matches.length}`);
    for (const match of candidate.matches) console.log(`       ${JSON.stringify(match)}`);
  }

  console.log("\n── 可见按钮（前 30）──");
  for (const button of report.visibleButtons) console.log(`  ${JSON.stringify(button)}`);

  console.log(`\n完整报告: ${reportPath}`);
}

/**
 * `--upload-dummy`：上传一张**现生成的纯色假图**，好让发布表单渲染出来。
 *
 * ### 为什么非做不可
 * 2026-09-20 实测：进图文页签后 DOM 里**只有上传区** —— 标题框、正文编辑器、话题、
 * 发布按钮、声明控件、存草稿按钮**一个都不存在**（连全页 `placeholder` 属性都是 0 个）。
 * 也就是说**不先上传图片，就永远看不到表单**，选择器也就无从校准。
 *
 * ### 它的副作用（所以必须用户同意后才跑）
 * 这一步会**真的把一张图片传到小红书服务器**（很可能在「草稿箱」里留一条未完成的笔记）。
 * 所以它**刻意**：
 *   - 用 ffmpeg **现场生成**一张纯色 3:4 图（`#4b5563` 灰），**不使用用户的任何素材**、不含任何真实内容；
 *   - **绝不点「发布」**、也不点「存草稿」（如果之后发现存在的话）。
 *
 * 这与头条那轮的 `--dry-run` 是同一个思路（那次唯一副作用是头条自动存一条草稿，已获用户同意）。
 */
async function uploadDummyImage(page: Page): Promise<string> {
  const workDir = path.join(reconDir, `upload-dummy-${stamp()}`);
  await mkdir(workDir, { recursive: true });
  const imagePath = path.join(workDir, "dummy-3x4.png");

  await runCommand(process.env.FFMPEG_BINARY ?? "ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=#4b5563:s=1080x1440", "-frames:v", "1", imagePath,
  ], { captureStderr: true, timeoutMs: 60_000 });
  console.log(`\n已生成纯色假图（3:4 / 1080×1440 / 非用户素材）：${imagePath}`);

  const input = page.locator('input.upload-input[type="file"]').first();
  const count = await page.locator('input[type="file"]').count();
  console.log(`页面上 input[type=file] 数量：${count}（取 .upload-input 那一个）`);
  await input.setInputFiles(imagePath);
  console.log("已送入上传框，等待表单渲染…");
  await page.waitForTimeout(9_000);
  return imagePath;
}

/**
 * `--form`：在**表单已经渲染出来**之后，把剩下的未知点一次问清楚。
 *
 * 2026-09-20 第一轮上传后侦察的结论与遗留：
 *   ✅ 标题 = `input.d-text[placeholder="填写标题会有更多赞哦"]`（`input[placeholder*="标题"]` 命中 1）
 *   ✅ 正文 = `div.tiptap.ProseMirror[contenteditable="true"]`（空态是 `p.empty.is-editor-empty`）
 *   ✅ 图片计数「1/18」→ **18 张上限确认**；正文「0 /1000」→ **1000 字确认**
 *   ✅ 存在「添加内容类型声明」**下拉**（`div.d-select-wrapper`），选项文案含「**笔记含AI合成内容**」
 *   ⚠️ **提交按钮找不到**：全页**没有任何元素文本恰好是「发布」**；`div.publish-video`（文案「发布笔记」）
 *      出现在顶部、紧挨「退出登录」，看着像**全局导航**而不是表单提交键
 *   ⚠️ 引导浮层（`button.feature-guide__btn`「我知道了」）可能正好盖住提交按钮
 *
 * 所以这一步做三件事，**只开下拉、只看 DOM、绝不提交**：
 *   ① 关掉引导浮层；
 *   ② 打开声明下拉并把选项枚举出来（开完按 Escape，**不选任何一项**）；
 *   ③ 把所有「够大的可点元素」按**底部坐标**排序打印 —— 提交按钮就在最下面那个。
 */
async function openFormProbes(page: Page): Promise<void> {
  await mkdir(reconDir, { recursive: true });

  // ① 引导浮层
  const guideCount = await page.locator("button.feature-guide__btn").count().catch(() => 0);
  if (guideCount > 0) {
    await page.locator("button.feature-guide__btn").first().click({ timeout: 5_000 }).catch(() => undefined);
    console.log(`\n已关掉引导浮层（feature-guide__btn × ${guideCount}）`);
    await page.waitForTimeout(1_500);
  } else {
    console.log("\n没有引导浮层需要关闭");
  }

  // ② 声明下拉：打开、枚举、Escape 关掉（不选）
  const declCount = await page.locator("div.d-select-wrapper").count().catch(() => 0);
  console.log(`声明下拉 div.d-select-wrapper 数量：${declCount}`);
  if (declCount > 0) {
    await page.locator("div.d-select-wrapper").first().click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    const options = await page.evaluate<string>(`(() => {
      const nodes = Array.from(document.querySelectorAll("[class*='d-option'], [class*='option'], [class*='dropdown'] li, li"));
      return JSON.stringify(nodes.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          cls: (element.className || "").toString().slice(0, 80),
          text: (element.textContent || "").trim().slice(0, 40),
          visible: rect.width > 0 && rect.height > 0,
        };
      }).filter((item) => item.text.length > 0 && item.text.length <= 30).slice(0, 40));
    })()`);
    console.log("声明下拉的候选选项：");
    for (const option of JSON.parse(options) as Array<Record<string, unknown>>) console.log(`  ${JSON.stringify(option)}`);
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(800);
    console.log("（已按 Escape 关掉下拉，未选择任何一项）");
  }

  // ③ 提交按钮：不猜文案，按「够大 + 位置最靠下」找
  const buttons = await page.evaluate<string>(`(() => {
    const nodes = Array.from(document.querySelectorAll("button, [role='button'], div[class*='btn'], span[class*='btn'], div[class*='Btn']"));
    const mapped = nodes.map((element) => {
      const rect = element.getBoundingClientRect();
      const cls = (element.className || "").toString();
      return {
        tag: element.tagName,
        cls: cls.slice(0, 80),
        text: (element.textContent || "").trim().slice(0, 24),
        disabled: element.disabled === true || cls.indexOf("Disabled") >= 0 || cls.indexOf("disabled") >= 0,
        rect: [Math.round(rect.width), Math.round(rect.height)],
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right),
      };
    });
    return JSON.stringify(mapped.filter((item) => item.rect[0] > 20 && item.rect[1] > 16).slice(0, 80));
  })()`);
  const parsed = JSON.parse(buttons) as Array<{ bottom: number; text: string }>;
  parsed.sort((left, right) => right.bottom - left.bottom);
  console.log("\n够大的可点元素（按底部坐标降序 —— 提交按钮在最下面）：");
  for (const item of parsed) console.log(`  ${JSON.stringify(item)}`);

  await writeFile(
    path.join(reconDir, "form-probes.json"),
    `${JSON.stringify({ buttons: parsed }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * `--dry-run`：在真实页面上把**填表**这条链路走完，然后**停在点「发布」之前**。
 *
 * ### 为什么必须做这一步
 * 2026-09-20 实测：只上传了图片时，**页面上根本没有「发布」按钮**（全文档 `发布` 只出现在
 * 侧栏导航与「定时发布」里，`<button>` 只有 10 个且都不是提交键）。怀疑提交按钮是
 * **校验门控**的 —— 只有内容有效才渲染。所以「提交按钮在哪」与「填完会不会自动存草稿」
 * 这两件姿态甲/姿态乙的关键问题，**只能靠真的把内容填进去才能回答**。
 *
 * ### 副作用（所以必须用户同意后才跑）
 * - 会往页面里写**假标题 + 假正文**（明确标注「可删除」），并勾上 AI 标识声明；
 * - **绝不点「发布」**；唯一副作用是平台可能把页面自动存成一条草稿（与头条 `--dry-run` 同一口径）。
 *
 * ### 读写纪律（照头条那轮踩出来的坑）
 * - **清空输入框只按一个全选键**：macOS 上 `Cmd+A` 是全选，而 `Ctrl+A` 是「移到行首」，
 *   会把选区塌缩掉，后续 Backspace 什么都删不掉；
 * - 内容一律用 `keyboard.insertText`（单次事件，不走逐键竞态）；
 * - **每一步都读回**，读回不一致要看得见。
 */
async function dryRunFill(page: Page): Promise<void> {
  await mkdir(reconDir, { recursive: true });
  const title = "测试标题（可删除）";
  const body = "这是只读侦察演练写入的占位正文，不会提交。演练结束后可以直接在草稿箱里删掉这条笔记。";

  console.log("\n── 演练：填标题 ──");
  const titleInput = page.locator('input.d-text[placeholder*="标题"]').first();
  await titleInput.click({ timeout: 5_000 }).catch(() => undefined);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(title);
  await page.waitForTimeout(600);
  const titleReadBack = await titleInput.inputValue().catch(() => "");
  console.log(`  读回：${JSON.stringify(titleReadBack)} 期望：${JSON.stringify(title)} → ${titleReadBack === title ? "✅" : "❌"}`);

  console.log("── 演练：填正文 ──");
  const editor = page.locator("div.tiptap.ProseMirror").first();
  await editor.click({ timeout: 5_000 }).catch(() => undefined);
  await page.keyboard.insertText(body);
  await page.waitForTimeout(800);
  const bodyReadBack = await page.evaluate<string>(`(() => {
    const element = document.querySelector("div.tiptap.ProseMirror");
    return element ? (element.textContent || "").trim() : "";
  })()`);
  const bodyOk = bodyReadBack.includes("只读侦察演练") && bodyReadBack.includes("删掉这条笔记");
  console.log(`  读回（${bodyReadBack.length} 字）：${JSON.stringify(bodyReadBack.slice(0, 80))}… → ${bodyOk ? "✅ 首末段都在" : "❌ 内容不完整"}`);

  console.log("── 演练：勾 AI 合成内容标识（2026-02-12 公告要求）──");
  const declBefore = await page.evaluate<string>(`(() => {
    const element = document.querySelector("div.d-select-wrapper");
    return element ? (element.textContent || "").trim() : "";
  })()`);
  console.log(`  选择前文案：${JSON.stringify(declBefore)}`);
  await page.locator("div.d-select-wrapper").first().click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);
  const optionCount = await page.locator("div.d-option").count().catch(() => 0);
  const aiOption = page.locator("div.d-option", { hasText: "笔记含AI合成内容" }).first();
  const aiOptionCount = await page.locator("div.d-option", { hasText: "笔记含AI合成内容" }).count().catch(() => 0);
  console.log(`  下拉选项 ${optionCount} 个，其中「笔记含AI合成内容」${aiOptionCount} 个`);
  if (aiOptionCount > 0) {
    await aiOption.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_200);
    const declAfter = await page.evaluate<string>(`(() => {
      const element = document.querySelector("div.d-select-wrapper");
      return element ? (element.textContent || "").trim() : "";
    })()`);
    console.log(`  选择后文案：${JSON.stringify(declAfter)} → ${declAfter.includes("AI") ? "✅ 已选中" : "❌ 没选上（实现时必须 fail closed）"}`);
  } else {
    console.log("  ❌ 没找到该选项：按 §11 实现时**必须拒绝自动提交**");
  }

  console.log("\n── 演练后：重新找提交按钮（怀疑它是校验门控的）──");
  await page.waitForTimeout(2_000);
  const afterFill = await page.evaluate<string>(`(() => {
    const nodes = Array.from(document.querySelectorAll("button, [role='button'], div[class*='btn'], span[class*='btn'], div[class*='Btn'], div[class*='publish']"));
    const mapped = nodes.map((element) => {
      const rect = element.getBoundingClientRect();
      const cls = (element.className || "").toString();
      return {
        tag: element.tagName,
        cls: cls.slice(0, 70),
        text: (element.textContent || "").trim().slice(0, 20),
        disabled: element.disabled === true || cls.indexOf("Disabled") >= 0 || cls.indexOf("disabled") >= 0,
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    });
    const publishes = mapped.filter((item) => /发布/.test(item.text) || /publish/i.test(item.cls));
    return JSON.stringify(publishes, null, 2);
  })()`);
  console.log(afterFill);
  await writeFile(path.join(reconDir, "dry-run-publish-candidates.json"), `${afterFill}\n`, "utf8");

  console.log("\n演练结束：**没有点「发布」**，也没有选话题。");
}

/**
 * `--scroll-submit`：逐屏下滚，看提交按钮是不是**懒挂载**的。
 *
 * ### 为什么需要它
 * 2026-09-20 实测：把标题、正文、AI 声明**全部真的填进去之后**，快照里依然
 * 只有那 10 个 `<button>`、`>发布<` 精确文本 0 命中 ⇒ 提交按钮**不是校验门控**，
 * 更可能是「滚到某处才插入 DOM」。表单列的几何是 `publish-page-content`（y 64..900，高 836），
 * 但它的子块一直排到 y≈1494（`更多设置` 在 1242..1494），说明**内容比视口长**。
 *
 * 所以：逐屏下滚 + 每屏重新枚举，把**累积**到的候选并起来。
 * **只枚举、只滚动，绝不点击任何提交类按钮。**
 */
async function scrollForSubmit(page: Page): Promise<void> {
  await mkdir(reconDir, { recursive: true });
  console.log("\n── 逐屏下滚找提交按钮（懒挂载假设）──");

  const height = await page.evaluate<string>(`(() => JSON.stringify({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }))()`);
  console.log(`  文档高 ${height}`);

  const seen = new Map<string, Record<string, unknown>>();
  for (let screen = 0; screen < 10; screen += 1) {
    const found = await page.evaluate<string>(`(() => {
      const nodes = Array.from(document.querySelectorAll(
        "button, [role='button'], div[class*='btn'], span[class*='btn'], div[class*='Btn'], div[class*='submit'], div[class*='Submit'], div[class*='publish'], div[class*='Publish']"
      ));
      const mapped = nodes.map((element) => {
        const rect = element.getBoundingClientRect();
        const cls = (element.className || "").toString();
        return {
          tag: element.tagName,
          cls: cls.slice(0, 70),
          text: (element.textContent || "").trim().slice(0, 20),
          disabled: element.disabled === true || /[Dd]isabled/.test(cls),
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
      }).filter((item) => item.w > 20 && item.h > 16 && (/发布/.test(item.text) || /submit|publish/i.test(item.cls)));
      return JSON.stringify(mapped);
    })()`);
    const list = JSON.parse(found) as Array<Record<string, unknown>>;
    for (const item of list) seen.set(`${String(item.cls)}|${String(item.text)}`, item);
    if (list.length > 0) console.log(`  第 ${screen + 1} 屏：+${list.length}（累计去重后 ${seen.size}）`);

    await page.evaluate<string>(`(() => { window.scrollBy(0, 520); return ""; })()`);
    await page.waitForTimeout(1_000);
  }

  const all = [...seen.values()];
  console.log(`\n下滚 10 屏后累计候选 ${all.length} 个：`);
  for (const item of all) console.log(`  ${JSON.stringify(item)}`);
  await writeFile(path.join(reconDir, "submit-button.json"), `${JSON.stringify(all, null, 2)}\n`, "utf8");
  console.log("\n⚠️ 全程只滚动与枚举，**未点击任何提交类按钮**。");
}

/**
 * `--shadow`：把提交组件的 **shadow root** 挖开看。
 *
 * ### 为什么需要
 * 提交控件**不是 `<button>`，而是一个自定义元素 `<xhs-publish-btn>`**：
 *
 * ```html
 * <xhs-publish-btn is-publish="true" is-save-draft="true"
 *   submit-text="发布" save-text="暂存离开"
 *   submit-disabled="false" submit-loading="false" save-disabled="false">
 * </xhs-publish-btn>
 * ```
 *
 * 它**只在上传图片之后才出现**，而且序列化 HTML 里它的内部是空的（没有
 * `shadowrootmode`，即**命令式 shadow root**）⇒ `page.content()` 与
 * `document.querySelectorAll` **都看不到里面真正的按钮**。
 *
 * 这解释了为什么：① 我枚举 `<button>` 只有 10 个且没有提交键；② `>发布<` 文本 0 命中；
 * ③ **4 个参考实现的 `button.publishBtn` / `.publish-page-publish-btn button` 全部失效** ——
 * 它们都在找一个根本不存在（或不在同一子树里）的 `<button>`。
 *
 * 顺带发现：`save-text="暂存离开"` ⇒ **「存草稿」按钮的真实文案是「暂存离开」**
 *（这就是为什么按「存草稿」搜是 0 命中）。
 *
 * 本模式**只读**：挖 shadow 结构 + 用 Playwright 的 **shadow 穿透定位器**验证能不能选中，
 * **绝不点击**。
 */
async function dumpSubmitShadow(page: Page): Promise<void> {
  await mkdir(reconDir, { recursive: true });
  console.log("\n── 挖提交组件的 shadow root ──");

  // ① 光 DOM：宿主元素本身可见（自定义元素在 light DOM 里）
  const info = await page.evaluate<string>(`(() => {
    const host = document.querySelector("xhs-publish-btn");
    if (!host) return JSON.stringify({ found: false });
    const root = host.shadowRoot;
    const rect = host.getBoundingClientRect();
    const walk = (scope) => Array.from(scope.querySelectorAll("button, [class*='btn'], [class*='Btn'], span, div"))
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          cls: (element.className || "").toString().slice(0, 60),
          text: (element.textContent || "").trim().slice(0, 20),
          left: Math.round(box.left), top: Math.round(box.top),
          w: Math.round(box.width), h: Math.round(box.height),
        };
      })
      .filter((item) => item.w > 0 && item.h > 0);
    return JSON.stringify({
      found: true,
      /** 这个自定义元素**有没有被 upgrade**：false = 它的 JS 定义压根没跑（不是「定义了就渲染成空」）。 */
      customElementDefined: typeof customElements !== "undefined" ? !!customElements.get("xhs-publish-btn") : null,
      userAgent: navigator.userAgent,
      hostAttrs: {
        submitText: host.getAttribute("submit-text"),
        saveText: host.getAttribute("save-text"),
        submitDisabled: host.getAttribute("submit-disabled"),
        saveDisabled: host.getAttribute("save-disabled"),
      },
      hostRect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
      hasShadowRoot: root !== null,
      shadowHtml: root ? (root.innerHTML || "").slice(0, 1200) : null,
      shadowNodes: root ? walk(root) : [],
      lightNodes: walk(host),
    });
  })()`);
  console.log(info);
  await writeFile(path.join(reconDir, "submit-button-shadow.json"), `${info}\n`, "utf8");

  // ② Playwright 的定位器**会穿透 open shadow root** —— 这是实现时要用的能力。
  //    注意：`page.evaluate(document.querySelectorAll)` **不会**穿透，两者不能混用。
  for (const name of ["发布", "暂存离开"]) {
    const byRole = page.getByRole("button", { name, exact: true });
    const byCss = page.locator(`xhs-publish-btn >> text=${name}`);
    const roleCount = await byRole.count().catch(() => -1);
    const cssCount = await byCss.count().catch(() => -1);
    console.log(`  「${name}」→ getByRole=${roleCount} / xhs-publish-btn>>text=${cssCount}`);
  }
  console.log("\n⚠️ 只做了定位与枚举，**没有点击任何东西**。");
}

/**
 * `--shot-submit`：把 `<xhs-publish-btn>` 这个宿主元素**截图**下来。
 *
 * ### 为什么只能靠截图
 * 实测（2026-09-20）：该元素 `customElements.get(...)` **返回已定义**，但
 * `element.shadowRoot === null` 且**没有任何子节点** ⇒ 它用的是 **closed shadow root**
 *（`mode: "closed"`：JS 拿不到 `shadowRoot`，也不会序列化进 `page.content()`）。
 * 后果很硬：**Playwright 的 CSS / role 定位器都不穿透 closed shadow root**
 *（实测 `getByRole("button", { name: "发布" })` = 0、`xhs-publish-btn >> text=发布` = 0）。
 *
 * ⇒ 对「姿态甲」而言，点击只能靠**宿主元素的几何位置**（坐标点击）。
 * 所以这里先把宿主**画出来**：看清里面到底有几个按钮、各自在什么位置、文案是什么。
 * **只截图，不点击。**
 */
async function shootSubmitHost(page: Page): Promise<void> {
  await mkdir(reconDir, { recursive: true });
  console.log("\n── 截图提交按钮宿主元素 ──");
  const host = page.locator("xhs-publish-btn").first();
  const count = await page.locator("xhs-publish-btn").count().catch(() => 0);
  console.log(`  xhs-publish-btn 数量：${count}`);
  if (count === 0) {
    console.log("  ❌ 宿主元素不存在（表单还没渲染？）");
    return;
  }
  const box = await host.boundingBox();
  console.log(`  宿主几何：${JSON.stringify(box)}`);
  const shotPath = path.join(reconDir, "submit-host.png");
  await host.screenshot({ path: shotPath, timeout: 10_000 });
  console.log(`  ✅ 截图：${shotPath}`);

  // 顺带把宿主所在区域（含周边）也截一张，便于判断它与表单的相对位置。
  const widerPath = path.join(reconDir, "submit-area.png");
  if (box) {
    await page.screenshot({
      path: widerPath,
      clip: {
        x: Math.max(0, box.x - 40),
        y: Math.max(0, box.y - 60),
        width: Math.min(1400, box.width + 80),
        height: Math.min(900, box.height + 120),
      },
    });
    console.log(`  ✅ 周边区域截图：${widerPath}`);
  }
  console.log("\n⚠️ 只截图，**未点击任何东西**。");
}

async function main(): Promise<number> {
  const headed = process.argv.includes("--headed");
  const loginOnly = process.argv.includes("--login");
  const clickTab = process.argv.includes("--tab");
  const pasteProbe = process.argv.includes("--paste-probe");
  const uploadDummy = process.argv.includes("--upload-dummy");

  console.log("小红书发布页只读侦察（不填表、不传图、不点发布、不存草稿）");
  console.log(`storage: ${storageRoot}`);

  if (profileDir !== storageRoot && !profileDir.startsWith(`${storageRoot}${path.sep}`)) {
    console.error(`❌ 会话目录必须落在 storage 内：${profileDir}`);
    return 1;
  }

  const context = await launch(headed);
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    // `--check-drafts`：**零副作用**地看一眼创作中心的「草稿箱」计数。
    //
    // 它回答的是姿态乙（填完停手）到底成不成立：如果 `--dry-run` 填过内容之后草稿箱里
    // 多了一条，说明**平台会自动存草稿** → 姿态乙可用；如果还是 0，姿态乙就只是「填完即弃」。
    if (process.argv.includes("--check-drafts")) {
      await page.goto(CREATOR_HOME, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(6_000);
      const info = await page.evaluate<string>(`(() => {
        const text = (document.body.innerText || "").replace(/[\\s\\u00a0]+/g, " ");
        const match = text.match(/草稿箱[^0-9]{0,8}([0-9]+)/);
        // ⚠️ 「草稿箱的真实地址」**必须从页面里读**，不许猜：猜出来的 URL 正是
        // 「文案指错动作」那一类坑。只读地收集所有提到「草稿」的链接（含 iframe 外的 anchor）。
        const draftLinks = Array.from(document.querySelectorAll("a[href]"))
          .filter((el) => (el.textContent || "").indexOf("草稿") >= 0 || (el.getAttribute("href") || "").indexOf("draft") >= 0)
          .map((el) => ((el.textContent || "").replace(/[\\s\\u00a0]+/g, " ").trim() + " → " + el.getAttribute("href")).slice(0, 120));
        return JSON.stringify({
          url: location.href,
          draftBox: match ? match[0] : null,
          hasDraftWord: text.indexOf("草稿") >= 0,
          draftLinks,
          text: text.slice(0, 400),
        });
      })()`);
      console.log(info);
      return 0;
    }

    // `--frames`：零副作用地看**文档结构**（iframe / shadow DOM / 每个 frame 里有没有「发布」）。
    //
    // 为什么需要：页面上根本找不到提交按钮，而 `page.evaluate` 只在**主 frame**里跑 ——
    // 如果发布表单其实在 iframe 或 shadow root 里，我的所有查询都会**静默看不到它**。
    if (process.argv.includes("--frames")) {
      await page.goto(PUBLISH_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(6_000);
      if (process.argv.includes("--tab")) await clickImageTab(page);
      const frames = page.frames();
      console.log(`\nframes 数量：${frames.length}`);
      for (const frame of frames) {
        const info = await frame.evaluate<string>(`(() => {
          const body = document.body || { innerText: "", innerHTML: "" };
          const shadowHosts = Array.from(document.querySelectorAll("*")).filter((el) => el.shadowRoot);
          const shadowPublish = shadowHosts.filter((el) => (el.shadowRoot.innerHTML || "").indexOf("发布") >= 0).length;
          return JSON.stringify({
            url: location.href,
            hasPublishInHtml: (body.innerHTML || "").indexOf("发布") >= 0,
            buttons: Array.from(document.querySelectorAll("button")).map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 12),
            shadowHostCount: shadowHosts.length,
            shadowWithPublish: shadowPublish,
            textHead: (body.innerText || "").replace(/[\\s\\u00a0]+/g, " ").slice(0, 120),
          });
        })()`).catch((error: unknown) => `<无法访问: ${error instanceof Error ? error.message : String(error)}>`);
        console.log(`  · ${frame.url()}\n    ${info}`);
      }
      return 0;
    }

    // `--diagnostics`：零副作用地抓**页面报错与失败请求**。
    //
    // 动机：`<xhs-publish-btn>` 存在且可见（680×90）却**既没有 shadow root 也没有子节点**
    // ⇒ 这个自定义元素**没有被 upgrade**（它的 JS 定义没跑起来）。最可能的原因是
    // 某个 chunk 加载失败或页面里有未捕获异常 —— 那就得看 console 与网络。
    if (process.argv.includes("--diagnostics")) {
      const consoleMessages: string[] = [];
      const failedRequests: string[] = [];
      const badResponses: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          consoleMessages.push(`[${message.type()}] ${message.text().slice(0, 200)}`);
        }
      });
      page.on("pageerror", (error) => consoleMessages.push(`[pageerror] ${error.message.slice(0, 200)}`));
      page.on("requestfailed", (request) => {
        failedRequests.push(`${request.url().slice(0, 160)} → ${request.failure()?.errorText ?? "?"}`);
      });
      page.on("response", (response) => {
        if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url().slice(0, 160)}`);
      });

      await page.goto(PUBLISH_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(8_000);

      const defined = await page.evaluate<string>(`(() => JSON.stringify({
        defined: typeof customElements !== "undefined" ? !!customElements.get("xhs-publish-btn") : null,
        hasElement: !!document.querySelector("xhs-publish-btn"),
        customElementCount: document.querySelectorAll("*").length,
      }))()`);
      console.log(`\n自定义元素状态：${defined}`);
      console.log(`\nconsole 错误/警告 ${consoleMessages.length} 条：`);
      for (const item of consoleMessages.slice(0, 20)) console.log(`  ${item}`);
      console.log(`\n失败请求 ${failedRequests.length} 条：`);
      for (const item of failedRequests.slice(0, 20)) console.log(`  ${item}`);
      console.log(`\nHTTP >=400 响应 ${badResponses.length} 条：`);
      for (const item of badResponses.slice(0, 20)) console.log(`  ${item}`);
      await writeFile(
        path.join(reconDir, "diagnostics.json"),
        `${JSON.stringify({ defined: JSON.parse(defined), consoleMessages, failedRequests, badResponses }, null, 2)}\n`,
        "utf8",
      );
      return 0;
    }

    const loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) return 1;
    if (loginOnly) return 0;

    console.log(`\n进入发布页: ${PUBLISH_URL}`);
    await page.goto(PUBLISH_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(6_000);
    console.log(`当前 URL: ${page.url()}`);

    const signals = await readSignals(page);
    if (signals.url.includes("/login")) {
      console.error("❌ 被重定向回登录页：登录态没生效（也可能被风控）。");
      console.error("   下一步：加 --headed 用真实窗口复测，或检查 profile 是否被清。");
      return 1;
    }

    if (clickTab) await clickImageTab(page);

    // ⚠️ 有副作用（会把一张纯色假图传到平台）：只有显式加 --upload-dummy 才做。
    if (uploadDummy) await uploadDummyImage(page);

    // 表单已经渲染出来之后，再问清「提交按钮在哪 / 声明下拉有什么」。
    if (process.argv.includes("--form")) await openFormProbes(page);

    // ⚠️ 有副作用（会往页面写假标题/假正文）：只有显式加 --dry-run 才做；**绝不点发布**。
    if (process.argv.includes("--dry-run")) await dryRunFill(page);

    // 逐屏下滚找提交按钮（懒挂载假设）：只滚动、只枚举。
    if (process.argv.includes("--scroll-submit")) await scrollForSubmit(page);

    // 挖提交组件的 shadow root（它是自定义元素，按钮在命令式 shadow root 里）。
    if (process.argv.includes("--shadow")) await dumpSubmitShadow(page);

    // 截图提交按钮宿主（closed shadow root 只能靠看）。
    if (process.argv.includes("--shot-submit")) await shootSubmitHost(page);

    if (pasteProbe) {
      // 默认不跑：往编辑器里写内容可能触发平台自动存草稿，与「零副作用」冲突。
      const readBack = await page.evaluate<string>(`(() => {
        const editor = document.querySelector("div.ProseMirror[contenteditable='true'], div[contenteditable='true'], div.ql-editor");
        if (!editor) return "NO_EDITOR";
        editor.focus();
        const data = new DataTransfer();
        data.setData("text/html", "<p>侦察探针：粘贴能力测试</p><p>第二段</p>");
        data.setData("text/plain", "侦察探针：粘贴能力测试 第二段");
        const before = (editor.textContent || "").length;
        editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        return (editor.textContent || "").length > before
          ? "支持富文本粘贴：" + (editor.textContent || "").trim().slice(0, 80)
          : "粘贴未生效，改为逐段输入纯文本";
      })()`);
      console.log(`\n── 粘贴探针（--paste-probe）──\n  ${readBack}`);
    }

    await mkdir(reconDir, { recursive: true });

    const html = await page.content();
    const htmlPath = path.join(reconDir, uploadDummy ? "publish-page-after-upload.html" : "publish-page.html");
    await writeFile(htmlPath, html, "utf8");
    console.log(`✅ DOM 快照: ${htmlPath}（${bytesToKb(Buffer.byteLength(html))}）`);

    const report = await collect(page);
    const reportPath = path.join(reconDir, uploadDummy ? "selectors-after-upload.json" : "selectors.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    printReport(report, reportPath);

    // ⚠️ 这句**必须如实反映本次到底做了什么**：早先它固定打印「未填任何表单、未上传任何图片」，
    // 而带 `--upload-dummy` / `--dry-run` 时**明明填了也传了** —— 那就是输出在撒谎，
    // 比起「少说了什么」，它会让人误判副作用（本项目的纪律：宁可多说，不许假报）。
    const performed: string[] = [];
    if (uploadDummy) performed.push("上传了一张**现场生成的纯色假图**（非用户素材，已传到平台）");
    if (process.argv.includes("--dry-run")) performed.push("填入了假标题与假正文、勾选了 AI 声明（**未点发布**）");
    if (process.argv.includes("--form")) performed.push("点开过声明下拉与页签（只开不选）");
    if (process.argv.includes("--scroll-submit")) performed.push("滚动过页面以枚举按钮（只滚动、只枚举）");
    if (performed.length === 0) {
      console.log("\n本次未填任何表单、未上传任何图片、未点击任何提交类按钮。");
    } else {
      console.log("\n本次**做过**以下有副作用的操作（如实列出）：");
      for (const item of performed) console.log(`  · ${item}`);
      console.log("  始终**没有点击任何提交类按钮**（没有点「发布」、也没有点「暂存离开」）。");
    }
    return 0;
  } finally {
    await context.close().catch(() => undefined);
  }
}

process.exitCode = await main();
