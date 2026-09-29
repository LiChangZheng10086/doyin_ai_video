/**
 * 抖音 Cookie 管理
 *
 * 支持三种方式获取 cookie：
 * 1. 从持久化存储读取 (~/.douyin-ai-video/douyin-cookie.txt)
 * 2. 通过 Playwright 无头浏览器自动提取（没有登录态则 cookie 不完整）
 * 3. 扫码登录（打开可视化浏览器，等待用户扫码登录后自动存储）
 * 4. 手动粘贴 cookie 字符串（用户从 Chrome DevTools 复制）
 *
 * Cookie 持久化到 ~/.douyin-ai-video/douyin-cookie.txt，
 * 与 douyin_parse 项目格式兼容。
 */

import pathModule from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { Browser, BrowserContext, Page } from "playwright";

const COOKIE_DIR = pathModule.join(homedir(), ".douyin-ai-video");
const COOKIE_PATH = pathModule.join(COOKIE_DIR, "douyin-cookie.txt");

// ─── 读取/写入 cookie ────────────────────────────────────────────

export function loadCookie(): string {
  try {
    if (existsSync(COOKIE_PATH)) {
      return readFileSync(COOKIE_PATH, "utf-8").trim();
    }
  } catch {
    // ignore
  }
  return "";
}

export function saveCookie(cookie: string): void {
  mkdirSync(COOKIE_DIR, { recursive: true });
  writeFileSync(COOKIE_PATH, cookie.trim(), "utf-8");
}

export function hasCookie(): boolean {
  const c = loadCookie();
  return c.length > 0;
}

/**
 * Check if cookie contains authentication tokens (sessionid / sso_uid_tt).
 */
export function hasAuthCookie(): boolean {
  const c = loadCookie();
  return /sessionid[^=]*=/.test(c) || /sso_uid_tt=/.test(c) || /sid_guard=/.test(c);
}

export function getCookiePath(): string {
  return COOKIE_PATH;
}

// ─── 应用内扫码登录 ───────────────────────────────────────────────

const QR_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DOUYIN_URL = "https://www.douyin.com/";

type DouyinQrSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  qrDataUrl: string;
};

let qrSession: DouyinQrSession | undefined;
let qrStarting = false;
let qrGeneration = 0;

export class DouyinQrLoginError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "DouyinQrLoginError";
  }
}

async function readDouyinQr(page: Page): Promise<string | undefined> {
  const images = page.locator('article img[src^="data:image/"]');
  for (let index = 0; index < await images.count(); index += 1) {
    const image = images.nth(index);
    const box = await image.boundingBox();
    if (!box || box.width < 120 || box.height < 120) continue;
    const src = await image.getAttribute("src");
    if (src?.startsWith("data:image/") && src.length < 1_000_000) return src;
  }
  return undefined;
}

async function closeQrSession(): Promise<void> {
  const current = qrSession;
  qrSession = undefined;
  if (!current) return;
  clearTimeout(current.timer);
  await current.browser.close().catch(() => undefined);
}

/** 取码时后台浏览器保留页面会话，二维码直接显示在应用内。 */
export async function startDouyinQrLogin(): Promise<{ qrDataUrl: string; startedAt: string; expiresAt: string }> {
  if (qrStarting || qrSession) {
    throw new DouyinQrLoginError(409, "douyin_login_in_progress", "已有抖音扫码会话，请先取消当前二维码再重新获取。");
  }
  qrStarting = true;
  const generation = ++qrGeneration;
  let browser: Browser | undefined;
  try {
    const { chromium } = await import("playwright");
    // 抖音对无头访问会返回滑块页；有头 Chrome 必须先最小化，二维码只显示在应用内。
    browser = await chromium.launch({
      headless: false,
      chromiumSandbox: true,
      ...(!existsSync(chromium.executablePath()) ? { channel: "chrome" } : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    let minimized = false;
    for (let attempt = 0; attempt < 10 && !minimized; attempt += 1) {
      minimized = (await cdp.send("Browser.getWindowBounds", { windowId })).bounds.windowState === "minimized";
      if (!minimized) await page.waitForTimeout(100);
    }
    if (!minimized) {
      throw new DouyinQrLoginError(422, "douyin_background_unavailable", "无法隐藏抖音登录浏览器窗口，已停止取码。请使用备用的浏览器扫码入口。");
    }
    await page.goto(DOUYIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    let qrDataUrl = await readDouyinQr(page);
    if (!qrDataUrl) {
      const qrTab = page.getByText("扫码登录", { exact: true });
      // 首页会跳到 /jingxuan，并在加载后自动打开登录框；先等扫码页签，避免点到框内的「登录」按钮。
      const modalOpened = await qrTab.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
      if (!modalOpened) {
        const login = page.getByRole("button", { name: "登录", exact: true });
        if (await login.count()) await login.first().click({ timeout: 3_000 });
        await qrTab.waitFor({ state: "visible", timeout: 5_000 });
      }
      await qrTab.first().click();
      for (let attempt = 0; attempt < 10 && !qrDataUrl; attempt += 1) {
        await page.waitForTimeout(500);
        qrDataUrl = await readDouyinQr(page);
      }
    }
    if (!qrDataUrl) {
      throw new DouyinQrLoginError(422, "douyin_qr_unavailable", "抖音登录页未出现二维码（可能要求滑块验证或页面已改版）。请稍后重试，或使用手动粘贴 Cookie。");
    }
    if (generation !== qrGeneration) {
      throw new DouyinQrLoginError(409, "douyin_login_cancelled", "本次扫码已取消，请重新获取二维码。");
    }
    const startedAt = Date.now();
    const expiresAt = startedAt + QR_LOGIN_TIMEOUT_MS;
    const timer = setTimeout(() => void closeQrSession(), QR_LOGIN_TIMEOUT_MS);
    timer.unref();
    qrSession = { browser, context, page, expiresAt, timer, qrDataUrl };
    return { qrDataUrl, startedAt: new Date(startedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
  } catch (error) {
    if (browser) await browser.close().catch(() => undefined);
    if (error instanceof DouyinQrLoginError) throw error;
    throw new DouyinQrLoginError(422, "douyin_qr_unavailable", `获取抖音二维码失败：${error instanceof Error ? error.message : String(error)}。可安装 Google Chrome 或运行 npx playwright install chromium 后重试。`);
  } finally {
    qrStarting = false;
  }
}

export async function pollDouyinQrLogin(): Promise<{ status: "idle" | "waiting" | "logged_in" | "expired"; qrDataUrl?: string }> {
  const current = qrSession;
  if (!current) return { status: "idle" };
  if (Date.now() >= current.expiresAt) {
    await closeQrSession();
    return { status: "expired" };
  }
  // 与原浏览器扫码通路相同，保存整个会话 Cookie；只取首页域名会漏掉登录子域的凭据。
  const cookies = await current.context.cookies();
  if (cookies.some((cookie) => cookie.name === "sessionid" && cookie.value)) {
    const byName = new Map(cookies.filter((cookie) => cookie.value).map((cookie) => [cookie.name, cookie.value]));
    try {
      saveCookie([...byName].map(([name, value]) => `${name}=${value}`).join("; "));
    } finally {
      await closeQrSession();
    }
    return { status: "logged_in" };
  }
  const qrDataUrl = await readDouyinQr(current.page);
  if (qrDataUrl && qrDataUrl !== current.qrDataUrl) {
    current.qrDataUrl = qrDataUrl;
    return { status: "waiting", qrDataUrl };
  }
  return { status: "waiting" };
}

export async function cancelDouyinQrLogin(): Promise<void> {
  qrGeneration += 1;
  await closeQrSession();
}

// ─── Playwright .mjs 脚本构建 ────────────────────────────────────

function buildCookieScript(manualLogin: boolean, loginTimeout: number): string {
  const playwrightPath = pathModule.join(process.cwd(), "node_modules", "playwright", "index.js");

  const scriptContent = `import { existsSync } from "node:fs";
import pkg from ${JSON.stringify(playwrightPath)};
const { chromium } = pkg;

const manualLogin = ${manualLogin};
const loginTimeout = ${loginTimeout};

const browser = await chromium.launch({
  headless: !manualLogin,
  ...(!existsSync(chromium.executablePath()) ? { channel: "chrome" } : {}),
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  viewport: { width: 1920, height: 1080 },
});

const page = await context.newPage();

// Navigate to Douyin homepage to trigger login QR
await page.goto("https://www.douyin.com/", {
  waitUntil: "domcontentloaded",
  timeout: 30000,
});

if (manualLogin) {
  // Wait for user to scan QR code and login
  // Poll for session cookie every 2 seconds
  const startTime = Date.now();
  let hasSession = false;
  while (Date.now() - startTime < loginTimeout * 1000) {
    await page.waitForTimeout(2000);
    const cookies = await context.cookies();
    hasSession = cookies.some(c => c.name === "sessionid" && c.value);
    if (hasSession) {
      console.log("LOGIN_DETECTED");
      break;
    }
  }
  if (!hasSession) {
    console.log("LOGIN_TIMEOUT");
    await browser.close();
    process.exit(1);
  }
} else {
  // Give the page some time to set non-auth cookies
  await page.waitForTimeout(5000);
  // Scroll to trigger more requests
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(2000);
}

// Extract all cookies
const allCookies = await context.cookies();
const cookieMap = new Map();

// Critical auth cookies (ordered by importance)
const keyCookies = [
  "sessionid", "sessionid_ss", "sso_uid_tt", "sso_uid_tt_ss",
  "sid_guard", "uid_tt", "uid_tt_ss", "sid_tt",
  "sid_ucp_v1", "ssid_ucp_v1",
  "passport_csrf_token", "passport_csrf_token_default",
  "passport_auth_status", "passport_auth_status_ss",
  "odin_tt", "ttwid",
  "bd_ticket_guard_client_data", "bd_ticket_guard_client_web_dy",
  "bd_ticket_crush_client_data_v2", "bd_ticket_crush_client_web_dy_v2",
  "n_mh", "s_v_web_id", "verify_FPP7",
  "IsDouyinActive", "download_guide",
  "stream_recommend_feed_params",
  "MONITOR_WEB_ID", "msToken",
  "__ac_nonce", "__ac_signature",
  "FPAU", "FPID", "FEED_LIVE_VERSION",
  "csrf_session_id", "d_ticket", "is_bd",
  "SEARCH_RESULT_LIST_TYPE", "strategy_abtest",
  "stream_feed_params", "volume_info",
];

for (const c of allCookies) {
  cookieMap.set(c.name, c.value);
}

// Build cookie string: key cookies first, then the rest
const resultParts = [];
const added = new Set();

for (const name of keyCookies) {
  const value = cookieMap.get(name);
  if (value) {
    resultParts.push(name + "=" + value);
    added.add(name);
  }
}

for (const c of allCookies) {
  if (!added.has(c.name)) {
    resultParts.push(c.name + "=" + c.value);
    added.add(c.name);
  }
}

const cookieStr = resultParts.join("; ");
console.log("COOKIE_START");
console.log(cookieStr);
console.log("COOKIE_END");
console.log("AUTH_KEYS:" + JSON.stringify({
  sessionid: cookieMap.has("sessionid"),
  passport_csrf_token: cookieMap.has("passport_csrf_token"),
  odin_tt: cookieMap.has("odin_tt"),
  ttwid: cookieMap.has("ttwid"),
  sid_guard: cookieMap.has("sid_guard"),
  total: resultParts.length,
}));

await browser.close();
`;
  return scriptContent;
}

// ─── 通过 Playwright 提取 cookie ─────────────────────────────────

export interface CookieExtractionResult {
  cookie: string;
  hasAuth: boolean;
  authInfo: {
    sessionid: boolean;
    passport_csrf_token: boolean;
    odin_tt: boolean;
    ttwid: boolean;
    sid_guard: boolean;
    total: number;
  };
}

function executeCookieScript(scriptContent: string): CookieExtractionResult {
  const tmpDir = pathModule.join(tmpdir(), `douyin-cookie-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(tmpDir, { recursive: true });
  const scriptPath = pathModule.join(tmpDir, "extract-cookie.mjs");

  try {
    writeFileSync(scriptPath, scriptContent, "utf-8");

    const result = execSync(`node --no-warnings "${scriptPath}"`, {
      cwd: tmpDir,
      timeout: 180_000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });

    // Parse cookie
    const cookieMatch = result.match(/COOKIE_START\n([\s\S]*?)\nCOOKIE_END/);
    const cookie = cookieMatch?.[1]?.trim() ?? "";

    // Parse auth info
    const authMatch = result.match(/AUTH_KEYS:(\{[\s\S]*?\})/);
    let authInfo = { sessionid: false, passport_csrf_token: false, odin_tt: false, ttwid: false, sid_guard: false, total: 0 };
    if (authMatch) {
      try {
        authInfo = JSON.parse(authMatch[1]);
      } catch { /* ignore */ }
    }

    if (cookie) {
      saveCookie(cookie);
    }

    return { cookie, hasAuth: authInfo.sessionid || authInfo.sid_guard || false, authInfo };
  } finally {
    try {
      const { rmSync } = require("node:fs");
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Start headless browser to extract whatever cookies the page sets.
 * Only gets non-login cookies (ttwid, odin_tt, etc.) — no sessionid.
 */
export async function extractCookiesViaBrowser(): Promise<string> {
  const script = buildCookieScript(false, 0);
  const result = executeCookieScript(script);
  console.log("[cookie] Headless extraction — auth:", result.hasAuth, "total:", result.authInfo.total);
  return result.cookie;
}

/**
 * Open a visible browser window for QR code login.
 * Waits for the user to scan the QR code and login,
 * then extracts the full authenticated cookie (including sessionid).
 *
 * This is meant to be called once to bootstrap the cookie.
 * After this, the persisted cookie should work for API calls.
 */
export async function extractCookiesWithQRLogin(loginTimeoutSec = 120): Promise<CookieExtractionResult> {
  const script = buildCookieScript(true, loginTimeoutSec);
  const result = executeCookieScript(script);
  if (!result.hasAuth) {
    throw new Error(
      "Login timeout: no session cookie detected after " + loginTimeoutSec + " seconds.\n" +
      "Please make sure you scanned the QR code and logged in successfully."
    );
  }
  console.log("[cookie] QR login successful — sessionid:", result.authInfo.sessionid);
  return result;
}

/**
 * Get or extract a working cookie.
 *
 * If we already have an auth cookie on disk, return it.
 * If only non-auth cookie exists, try headless extraction.
 * Returns empty string if no cookie at all, letting the caller decide
 * whether to fall back to browser mode or prompt for QR login.
 */
export async function getOrExtractCookie(): Promise<string> {
  const existing = loadCookie();
  if (existing && hasAuthCookie()) {
    return existing;
  }

  if (existing) {
    // We have cookie but no auth — try headless again to refresh
    console.log("[cookie] Cookie exists but lacks auth, refreshing via headless...");
    await extractCookiesViaBrowser();
    const refreshed = loadCookie();
    if (hasAuthCookie()) return refreshed;
    // Still no auth — return what we have (API will fail, caller falls back to browser)
    return refreshed;
  }

  // No cookie at all
  console.log("[cookie] No persisted cookie found, extracting via headless...");
  const extracted = await extractCookiesViaBrowser();
  return extracted;
}
