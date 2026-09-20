/**
 * 今日头条执行器的浏览器解析与持久化会话目录。
 *
 * 为什么需要这个模块（2026-09-18 实测，见 `docs/research/toutiao-ops-assessment.md` §4）：
 * 项目虽然依赖 `playwright@1.62.1`，但那台版本要 `chromium_headless_shell-1234`，
 * 本机 ms-playwright 缓存里只有 `1208`（属 patchright/sau）→ **直接 `chromium.launch()` 必然失败**。
 * 而打包资源里已经有 `chrome-headless-shell`（`npm run prepare:package:*` 的产物，实测 152.0.7928.2
 * 能打开真实头条登录页），所以「浏览器从哪来」必须是一条**明确的分层解析链**。
 *
 * 与既有 `asr.ts`（whisper 路径）、`hyperframes-video.ts`（浏览器路径）同一口径：
 * 显式配置优先，其次运行环境提供的资源，最后才退回「让 Playwright 自己找」。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** 与 `SauRunnerError` 同形：路由层的错误映射按 `status` + `code` + `message` 处理。 */
export type ToutiaoBrowserErrorCode = "toutiao_browser_unavailable" | "toutiao_profile_dir_unsafe";

export class ToutiaoBrowserError extends Error {
  readonly status = 422;

  constructor(
    readonly code: ToutiaoBrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToutiaoBrowserError";
  }
}

/**
 * 没找到浏览器时给操作者的**可执行指引**。
 *
 * 只说「未找到浏览器」等于把用户丢在原地：本机就是「有 playwright 却没有浏览器」的状态，
 * 所以必须给出两条能直接照抄的命令（与 `SAU_INSTALL_GUIDANCE` 同一口径）。
 */
export const TOUTIAO_BROWSER_GUIDANCE = [
  "未找到可用于头条号发布的浏览器。三选一：",
  "① 运行 npm run prepare:package:mac（产出打包用的 chrome-headless-shell，约 196MB）；",
  "② 运行 npx playwright install chromium（下载 Playwright 自己的 chromium，约 330MB）；",
  "③ 用 TOUTIAO_BROWSER_BINARY 直接指定一个 Chromium 系可执行文件的路径，然后重启后端。",
  "（只做扫码登录的话还需要一个能显示窗口的浏览器：系统装的 Google Chrome 即可；",
  "  以上 ①② 装的是无头专用构建，开不了窗口，届时可改用界面上的「应用内扫码」。）",
].join("");

export type ToutiaoBrowserTarget =
  | { kind: "executablePath"; path: string; source: "config" | "env" | "vendored" }
  /** 交给 Playwright 自己的缓存（不传 `executablePath`）。 */
  | { kind: "playwright" }
  /** 系统安装的 Chrome。**必须显式允许**：它的版本与策略由用户环境决定，不确定性更大。 */
  | { kind: "channel"; channel: "chrome" };

export interface ToutiaoBrowserAttempt {
  layer: "config" | "env" | "vendored" | "playwright-cache" | "system-chrome";
  ok: boolean;
  detail: string;
}

export interface ToutiaoBrowserResolution {
  target: ToutiaoBrowserTarget | null;
  /** 逐层诊断：出问题时能直接看出是哪一层没命中。 */
  attempts: ToutiaoBrowserAttempt[];
}

/** 文件系统探测点（注入以便单测，测试全程不碰真实磁盘）。 */
export interface ToutiaoBrowserProbe {
  isFile(target: string): boolean;
  listDirectories(target: string): string[];
}

export interface ToutiaoBrowserConfig {
  /** 显式可执行文件路径（env `TOUTIAO_BROWSER_BINARY` / Electron `binaryPaths`）。 */
  browserBinary?: string;
  /** 允许退到 Playwright 自身缓存；缺省允许。 */
  allowPlaywrightCache?: boolean;
  /** 允许退到系统 Chrome；缺省**不允许**（见 `ToutiaoBrowserTarget` 的说明）。 */
  allowSystemChrome?: boolean;
  /** 仓库根目录（开发态的 `vendor/package-assets` 在这里）；缺省 `process.cwd()`。 */
  repoRoot?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  probe?: ToutiaoBrowserProbe;
}

const VENDORED_SHELL_ROOT = ["vendor", "package-assets", "browser", "chrome-headless-shell"] as const;

const defaultProbe: ToutiaoBrowserProbe = {
  isFile(target: string): boolean {
    try {
      return statSync(target).isFile();
    } catch {
      return false;
    }
  },
  listDirectories(target: string): string[] {
    try {
      return readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  },
};

function shellBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
}

/**
 * 在打包/开发态的 vendor 资源里找 headless shell。
 *
 * 目录形状（`prepare-package-assets.mjs` 产出）：
 * `<repo>/vendor/package-assets/browser/chrome-headless-shell/<平台-架构-版本>/<目标三元组>/chrome-headless-shell`。
 * 版本目录**按名降序**取第一个命中的，保证「装了新版就用新版」且结果确定（不依赖 readdir 顺序）。
 */
function findVendoredShell(config: {
  repoRoot: string;
  platform: NodeJS.Platform;
  probe: ToutiaoBrowserProbe;
}): string | undefined {
  const root = path.join(config.repoRoot, ...VENDORED_SHELL_ROOT);
  const versionDirs = [...config.probe.listDirectories(root)].sort().reverse();
  const binaryName = shellBinaryName(config.platform);

  for (const version of versionDirs) {
    const versionDir = path.join(root, version);
    for (const triple of config.probe.listDirectories(versionDir)) {
      const candidate = path.join(versionDir, triple, binaryName);
      if (config.probe.isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function unavailable(message: string): never {
  throw new ToutiaoBrowserError("toutiao_browser_unavailable", message);
}

/**
 * 按固定顺序解析浏览器，并逐层记录结果。
 *
 * 显式配置/en v指向的文件**不存在**时直接抛错，**不静默退到下一层** ——
 * 静默回退会把「路径打错了」变成「用的是别的浏览器」，排查时完全看不出真相。
 */
export function resolveToutiaoBrowser(config: ToutiaoBrowserConfig = {}): ToutiaoBrowserResolution {
  const platform = config.platform ?? process.platform;
  const env = config.env ?? process.env;
  const probe = config.probe ?? defaultProbe;
  const repoRoot = path.resolve(config.repoRoot ?? process.cwd());
  const attempts: ToutiaoBrowserAttempt[] = [];

  const explicit = config.browserBinary?.trim();
  if (explicit) {
    if (!probe.isFile(explicit)) {
      unavailable(`配置的头条号浏览器不存在：${explicit}。请修正 TOUTIAO_BROWSER_BINARY 后重启后端。`);
    }
    attempts.push({ layer: "config", ok: true, detail: explicit });
    return { target: { kind: "executablePath", path: explicit, source: "config" }, attempts };
  }
  attempts.push({ layer: "config", ok: false, detail: "未配置 TOUTIAO_BROWSER_BINARY" });

  const fromEnv = env.TOUTIAO_BROWSER_BINARY?.trim();
  if (fromEnv) {
    if (!probe.isFile(fromEnv)) {
      unavailable(`TOUTIAO_BROWSER_BINARY 指向的文件不存在：${fromEnv}。请修正后重启后端。`);
    }
    attempts.push({ layer: "env", ok: true, detail: fromEnv });
    return { target: { kind: "executablePath", path: fromEnv, source: "env" }, attempts };
  }
  attempts.push({ layer: "env", ok: false, detail: "环境变量 TOUTIAO_BROWSER_BINARY 未设置" });

  const vendored = findVendoredShell({ repoRoot, platform, probe });
  if (vendored) {
    attempts.push({ layer: "vendored", ok: true, detail: vendored });
    return { target: { kind: "executablePath", path: vendored, source: "vendored" }, attempts };
  }
  attempts.push({
    layer: "vendored",
    ok: false,
    detail: `未找到 ${path.join(repoRoot, ...VENDORED_SHELL_ROOT)} 下的 ${shellBinaryName(platform)}（需先运行 npm run prepare:package:mac）`,
  });

  if (config.allowPlaywrightCache !== false) {
    if (probePlaywrightCache(probe, env)) {
      attempts.push({ layer: "playwright-cache", ok: true, detail: "Playwright 缓存里有可用的 chromium/headless shell" });
      return { target: { kind: "playwright" }, attempts };
    }
    // **必须真的探测**：早先这一层无条件返回 ok，于是「本机根本没有浏览器」也被当成配置就绪
    // —— 真正的失败发生在启动那一刻（Playwright 抛原始错误 → 500，且 autoPublish 会卡在 running
    // 直到 30 分钟僵死阈值）。现在探测不到就继续往下走，最终给出可照抄的指引。
    attempts.push({
      layer: "playwright-cache",
      ok: false,
      detail: "Playwright 缓存里没有 chromium/headless shell（需先运行 npx playwright install chromium）",
    });
  } else {
    attempts.push({ layer: "playwright-cache", ok: false, detail: "已禁用 Playwright 自身缓存" });
  }

  if (config.allowSystemChrome) {
    attempts.push({ layer: "system-chrome", ok: true, detail: "channel=chrome" });
    return { target: { kind: "channel", channel: "chrome" }, attempts };
  }
  attempts.push({ layer: "system-chrome", ok: false, detail: "未允许使用系统 Chrome" });

  return { target: null, attempts };
}

/**
 * **可显示窗口**的浏览器解析：只有它能做「打开浏览器窗口扫码登录」。
 *
 * 与无头解析链的关键差别：**打包进来的 `chrome-headless-shell` 不能开窗口**，
 * 所以这一条链上它不算数。顺序：
 * 显式配置 → env → 系统 Chrome（`channel: "chrome"`）→ Playwright 自己的 chromium。
 *
 * 返回 `null` 表示本机没有可显示窗口的浏览器，调用方据此给出可执行指引
 * （界面上那条路会退回「应用内扫码」）。
 */
export function resolveToutiaoHeadedBrowser(config: ToutiaoBrowserConfig = {}): ToutiaoBrowserResolution {
  const platform = config.platform ?? process.platform;
  const env = config.env ?? process.env;
  const probe = config.probe ?? defaultProbe;
  const attempts: ToutiaoBrowserAttempt[] = [];

  const explicit = config.browserBinary?.trim() ?? env.TOUTIAO_BROWSER_BINARY?.trim();
  if (explicit) {
    if (!probe.isFile(explicit)) {
      unavailable(`配置的头条号浏览器不存在：${explicit}。请修正后重启后端。`);
    }
    const layer = config.browserBinary?.trim() ? "config" : "env";
    attempts.push({ layer, ok: true, detail: explicit });
    return { target: { kind: "executablePath", path: explicit, source: layer }, attempts };
  }
  attempts.push({ layer: "config", ok: false, detail: "未配置 TOUTIAO_BROWSER_BINARY" });
  attempts.push({ layer: "env", ok: false, detail: "环境变量 TOUTIAO_BROWSER_BINARY 未设置" });
  // 打包的 headless shell 不能开窗口：这一层在「有头」链上**故意跳过**，但要说明白。
  attempts.push({
    layer: "vendored",
    ok: false,
    detail: "打包的 chrome-headless-shell 是无头专用构建，不能开窗口做扫码登录",
  });

  const chrome = findSystemChrome({ platform, probe });
  if (chrome) {
    attempts.push({ layer: "system-chrome", ok: true, detail: chrome });
    return { target: { kind: "channel", channel: "chrome" }, attempts };
  }
  attempts.push({ layer: "system-chrome", ok: false, detail: "未找到系统安装的 Google Chrome" });

  if (config.allowPlaywrightCache !== false && hasPlaywrightChromium(probe, env)) {
    attempts.push({ layer: "playwright-cache", ok: true, detail: "Playwright 自身缓存里的 chromium" });
    return { target: { kind: "playwright" }, attempts };
  }
  attempts.push({
    layer: "playwright-cache",
    ok: false,
    detail: "Playwright 缓存里没有可显示窗口的 chromium（chrome-headless-shell 不算）",
  });

  return { target: null, attempts };
}

/** 系统 Chrome 的可执行文件（按平台给常见位置；找到第一个就算）。 */
export function findSystemChrome(config: { platform: NodeJS.Platform; probe: ToutiaoBrowserProbe }): string | undefined {
  const candidates: Record<string, string[]> = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(process.env.HOME ?? "", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ],
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  };
  for (const candidate of candidates[config.platform] ?? []) {
    if (candidate.length > 0 && config.probe.isFile(candidate)) return candidate;
  }
  return undefined;
}

/** Playwright 的浏览器缓存根（认 `PLAYWRIGHT_BROWSERS_PATH`，并按平台取默认位置）。 */
function playwrightCacheRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured && configured !== "0") return configured;
  const home = env.HOME ?? env.USERPROFILE ?? "";
  if (platform === "darwin") return path.join(home, "Library", "Caches", "ms-playwright");
  if (platform === "win32") return path.join(home, "AppData", "Local", "ms-playwright");
  return path.join(home, ".cache", "ms-playwright");
}

/**
 * Playwright 缓存里是否有**能启动的**浏览器（完整 chromium 或 headless shell）。
 *
 * 只在这里看目录名，不解析 playwright 的 browsers.json（避免为了探测而引入依赖）；
 * 判断依据是「目录存在且里面有平台专属的可执行目录」。
 */
function probePlaywrightCache(probe: ToutiaoBrowserProbe, env: NodeJS.ProcessEnv = process.env): boolean {
  const platform = env === process.env ? process.platform : process.platform;
  const root = playwrightCacheRoot(env, platform);
  for (const name of probe.listDirectories(root)) {
    if (!/^chromium(_headless_shell)?-\d+$/u.test(name)) continue;
    const inside = probe.listDirectories(path.join(root, name));
    if (inside.length > 0) return true;
  }
  return false;
}

/** Playwright 缓存里是否有**完整** chromium（`chromium-<数字>`，不是 headless shell）。 */
function hasPlaywrightChromium(probe: ToutiaoBrowserProbe, env: NodeJS.ProcessEnv = process.env): boolean {
  const root = playwrightCacheRoot(env, process.platform);

  for (const name of probe.listDirectories(root)) {
    if (!/^chromium-\d+$/u.test(name)) continue;
    if (probe.listDirectories(path.join(root, name)).some((dir) => dir.startsWith("chrome-mac") || dir.startsWith("chrome-linux") || dir.startsWith("chrome-win"))) {
      return true;
    }
  }
  return false;
}

export function resolveToutiaoBrowserTarget(config: ToutiaoBrowserConfig = {}): ToutiaoBrowserTarget | null {
  return resolveToutiaoBrowser(config).target;
}

/** 解析失败时的统一报错（带上面那三条可照抄的命令）。 */
export function requireToutiaoBrowserTarget(config: ToutiaoBrowserConfig = {}): ToutiaoBrowserTarget {
  const resolution = resolveToutiaoBrowser(config);
  if (!resolution.target) {
    unavailable(`${TOUTIAO_BROWSER_GUIDANCE}\n逐层诊断：${describeAttempts(resolution.attempts)}`);
  }
  return resolution.target;
}

export function describeAttempts(attempts: ToutiaoBrowserAttempt[]): string {
  return attempts.map((attempt) => `${attempt.layer}=${attempt.ok ? "ok" : "miss"}(${attempt.detail})`).join("; ");
}

/**
 * 头条登录态落在**浏览器 profile 目录**里（不是 Cookie 文本文件），所以它必须和其余数据一样
 * 被约束在 storage 根内 —— 与 `video-output.ts` 的根目录约束同一条纪律。
 */
export function resolveToutiaoProfileDir(storageRoot: string, override?: string): string {
  const root = path.resolve(storageRoot);
  const target = path.resolve(override?.trim() ? override.trim() : path.join(root, "toutiao", "profile"));
  const relative = path.relative(root, target);

  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ToutiaoBrowserError(
      "toutiao_profile_dir_unsafe",
      `头条号浏览器会话目录必须落在 storage 内：${target} 不在 ${root} 之内。`,
    );
  }
  return target;
}
