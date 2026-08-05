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

// ─── Playwright .mjs 脚本构建 ────────────────────────────────────

function buildCookieScript(manualLogin: boolean, loginTimeout: number): string {
  const playwrightPath = pathModule.join(process.cwd(), "node_modules", "playwright", "index.js");

  const scriptContent = `import pkg from ${JSON.stringify(playwrightPath)};
const { chromium } = pkg;

const manualLogin = ${manualLogin};
const loginTimeout = ${loginTimeout};

const browser = await chromium.launch({
  headless: !manualLogin,
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
