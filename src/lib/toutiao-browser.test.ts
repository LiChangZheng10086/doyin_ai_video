/**
 * 今日头条浏览器解析测试。
 *
 * 背景（spec §1.3，2026-09-18 实测）：我们自己的 `playwright@1.62.1` **本机没有可用浏览器**
 * （它要 `chromium_headless_shell-1234`，缓存里只有 patchright/sau 的 1208），
 * 但**打包资源里已经有 chrome-headless-shell 152.0.7928.2**，实测能打开真实头条登录页。
 * 所以「浏览器从哪来」必须有明确的解析链，而不是期望 `chromium.launch()` 碰巧成功。
 *
 * 解析顺序（spec §4.1）：显式配置 → env → 打包/开发态的 vendor 资源 → Playwright 自身缓存 → 系统 Chrome。
 *
 * 本文件**全程不启浏览器、不联网**：文件系统探测通过注入的假 probe 完成
 * （另有一条用真实临时目录的用例，确保真实的目录遍历写法也成立）。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  TOUTIAO_BROWSER_GUIDANCE,
  ToutiaoBrowserError,
  findSystemChrome,
  resolveToutiaoBrowser,
  resolveToutiaoBrowserTarget,
  resolveToutiaoHeadedBrowser,
  resolveToutiaoProfileDir,
  type ToutiaoBrowserProbe,
} from "./toutiao-browser.js";

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix = "toutiao-browser-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 假文件系统：只认显式登记的文件与目录，测试里不碰真实磁盘。 */
function fakeProbe(files: string[], directories: Record<string, string[]> = {}): ToutiaoBrowserProbe {
  const fileSet = new Set(files.map((item) => path.resolve(item)));
  return {
    isFile: (target) => fileSet.has(path.resolve(target)),
    listDirectories: (target) => directories[path.resolve(target)] ?? [],
  };
}

/** 与真实资源同形的 vendor 路径：<root>/vendor/package-assets/browser/chrome-headless-shell/<版本>/<目标>/<可执行文件>。 */
function vendoredShellPath(root: string, version = "mac_arm-152.0.7928.2"): string {
  return path.join(
    root,
    "vendor",
    "package-assets",
    "browser",
    "chrome-headless-shell",
    version,
    "chrome-headless-shell-mac-arm64",
    "chrome-headless-shell",
  );
}

function vendoredProbe(root: string, versions = ["mac_arm-152.0.7928.2"]): ToutiaoBrowserProbe {
  const shellRoot = path.join(root, "vendor", "package-assets", "browser", "chrome-headless-shell");
  const directories: Record<string, string[]> = { [shellRoot]: versions };
  const files: string[] = [];
  for (const version of versions) {
    const versionDir = path.join(shellRoot, version);
    directories[versionDir] = ["chrome-headless-shell-mac-arm64"];
    files.push(path.join(versionDir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"));
  }
  return fakeProbe(files, directories);
}

const NO_BROWSER = { allowPlaywrightCache: false, allowSystemChrome: false } as const;

test("显式配置的浏览器路径优先，且被标成 config 来源", () => {
  const config = "/opt/chromium/chrome";
  const resolution = resolveToutiaoBrowser({
    browserBinary: config,
    env: { TOUTIAO_BROWSER_BINARY: "/env/chrome" },
    probe: fakeProbe([config, "/env/chrome"]),
    ...NO_BROWSER,
  });

  assert.deepEqual(resolution.target, { kind: "executablePath", path: config, source: "config" });
});

test("没有显式配置时用 env 里的 TOUTIAO_BROWSER_BINARY", () => {
  const resolution = resolveToutiaoBrowser({
    env: { TOUTIAO_BROWSER_BINARY: "/env/chrome" },
    probe: fakeProbe(["/env/chrome"]),
    ...NO_BROWSER,
  });

  assert.deepEqual(resolution.target, { kind: "executablePath", path: "/env/chrome", source: "env" });
});

test("显式配置指向不存在的文件时明确报错，不静默退到下一层", () => {
  // 静默回退会把「路径打错了」变成「用的是别的浏览器」，排查时完全看不出真相。
  assert.throws(
    () => resolveToutiaoBrowser({
      browserBinary: "/nope/chrome",
      repoRoot: "/repo",
      probe: vendoredProbe("/repo"),
      ...NO_BROWSER,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ToutiaoBrowserError);
      assert.equal(error.code, "toutiao_browser_unavailable");
      assert.match(error.message, /\/nope\/chrome/u);
      return true;
    },
  );
});

test("env 里指向不存在的文件同样明确报错（而不是悄悄换一个浏览器）", () => {
  assert.throws(
    () => resolveToutiaoBrowser({
      env: { TOUTIAO_BROWSER_BINARY: "/env/missing" },
      probe: fakeProbe([]),
      ...NO_BROWSER,
    }),
    (error: unknown) => error instanceof ToutiaoBrowserError && error.code === "toutiao_browser_unavailable",
  );
});

test("开发态的 vendor 打包资源能被解析到（这是本机唯一真正可用的浏览器）", () => {
  const root = "/repo";
  const resolution = resolveToutiaoBrowser({
    repoRoot: root,
    probe: vendoredProbe(root),
    ...NO_BROWSER,
  });

  assert.deepEqual(resolution.target, {
    kind: "executablePath",
    path: vendoredShellPath(root),
    source: "vendored",
  });
});

test("vendor 下有多个版本时取最新的那个（版本目录按名降序）", async () => {
  const root = "/repo";
  const resolution = resolveToutiaoBrowser({
    repoRoot: root,
    probe: vendoredProbe(root, ["mac_arm-152.0.7928.2", "mac_arm-153.0.8000.1"]),
    ...NO_BROWSER,
  });

  assert.deepEqual(resolution.target, {
    kind: "executablePath",
    path: vendoredShellPath(root, "mac_arm-153.0.8000.1"),
    source: "vendored",
  });

  // 真实的目录遍历写法也要成立：在临时目录里造一棵同形的树。
  const real = await tempDir();
  const shell = vendoredShellPath(real, "mac_arm-152.0.7928.2");
  await mkdir(path.dirname(shell), { recursive: true });
  await writeFile(shell, "#!/bin/sh\n");
  const realResolution = resolveToutiaoBrowser({ repoRoot: real, ...NO_BROWSER });
  assert.deepEqual(realResolution.target, { kind: "executablePath", path: shell, source: "vendored" });
});

test("vendor 资源不存在、且 Playwright 缓存里确实有浏览器时，退到它（不传 executablePath）", () => {
  const home = process.env.HOME ?? "";
  const cacheRoot = path.join(home, "Library", "Caches", "ms-playwright");
  const chromiumDir = path.join(cacheRoot, "chromium_headless_shell-1234");
  const probe = fakeProbe([], { [cacheRoot]: ["chromium_headless_shell-1234"], [chromiumDir]: ["chrome-headless-shell-mac-arm64"] });

  const resolution = resolveToutiaoBrowser({ repoRoot: "/repo", probe });

  assert.deepEqual(resolution.target, { kind: "playwright" });
});

test("Playwright 缓存里其实没有浏览器时**不许**当成就绪（否则真正的失败会拖到启动那一刻）", () => {
  // 这条是评审抓到的真问题：早先这一层无条件 ok=true，于是「本机没浏览器」也能通过
  // `assertConfigured()`，真失败发生在 launch() → 500，而且 autoPublish 会卡在 running
  // 直到 30 分钟僵死阈值。现在探测不到就继续往下，最终给出可照抄的指引。
  const resolution = resolveToutiaoBrowser({
    repoRoot: "/repo",
    probe: fakeProbe([]),
    allowSystemChrome: false,
  });

  assert.equal(resolution.target, null);
  assert.match(
    resolution.attempts.find((attempt) => attempt.layer === "playwright-cache")?.detail ?? "",
    /npx playwright install chromium/u,
  );
});

test("系统 Chrome 只作为最后一层兜底，且必须显式允许", () => {
  const withChrome = resolveToutiaoBrowser({
    repoRoot: "/repo",
    probe: fakeProbe([]),
    allowPlaywrightCache: false,
    allowSystemChrome: true,
  });
  assert.deepEqual(withChrome.target, { kind: "channel", channel: "chrome" });

  // 两层都允许时仍是 Playwright 优先：系统 Chrome 的版本/策略由用户环境决定，不确定性更大。
  // 两层都允许时：Playwright 缓存里**真的有**浏览器才轮到它（缓存为空则落到系统 Chrome）。
  const home = process.env.HOME ?? "";
  const cacheRoot = path.join(home, "Library", "Caches", "ms-playwright");
  const dir = path.join(cacheRoot, "chromium-1234");
  const both = resolveToutiaoBrowser({
    repoRoot: "/repo",
    probe: fakeProbe([], { [cacheRoot]: ["chromium-1234"], [dir]: ["chrome-mac-arm64"] }),
    allowSystemChrome: true,
  });
  assert.deepEqual(both.target, { kind: "playwright" });

  // 缓存里没有浏览器时，系统 Chrome 才是最终兜底。
  assert.deepEqual(
    resolveToutiaoBrowser({ repoRoot: "/repo", probe: fakeProbe([]), allowSystemChrome: true }).target,
    { kind: "channel", channel: "chrome" },
  );
});

test("一层都不可用时 target 为 null，且诊断里逐层记下原因", () => {
  const resolution = resolveToutiaoBrowser({ repoRoot: "/repo", probe: fakeProbe([]), ...NO_BROWSER });

  assert.equal(resolution.target, null);
  assert.equal(resolveToutiaoBrowserTarget({ repoRoot: "/repo", probe: fakeProbe([]), ...NO_BROWSER }), null);
  assert.deepEqual(
    resolution.attempts.map((attempt) => attempt.layer),
    ["config", "env", "vendored", "playwright-cache", "system-chrome"],
  );
  assert.equal(resolution.attempts.every((attempt) => attempt.ok === false), true);
});

test("不可用时的指引必须给出可照抄的命令（只说「未找到浏览器」等于把用户丢在原地）", () => {
  assert.match(TOUTIAO_BROWSER_GUIDANCE, /npm run prepare:package:mac/u);
  assert.match(TOUTIAO_BROWSER_GUIDANCE, /npx playwright install chromium/u);
  assert.match(TOUTIAO_BROWSER_GUIDANCE, /TOUTIAO_BROWSER_BINARY/u);
});

test("会话目录缺省落在 storage 内，越界的 override 被拒", () => {
  assert.equal(resolveToutiaoProfileDir("/data/storage"), path.resolve("/data/storage/toutiao/profile"));
  assert.equal(
    resolveToutiaoProfileDir("/data/storage", "/data/storage/custom/profile"),
    path.resolve("/data/storage/custom/profile"),
  );

  // 浏览器 profile 里带着登录态；允许它落到 storage 之外就等于让「数据都在一个根里」这条约束失效。
  for (const escape of ["/tmp/elsewhere", "../outside", "/data/storage/../escape"]) {
    assert.throws(
      () => resolveToutiaoProfileDir("/data/storage", escape),
      (error: unknown) => error instanceof ToutiaoBrowserError && error.code === "toutiao_profile_dir_unsafe",
      `应当拒绝 ${escape}`,
    );
  }
  assert.throws(
    () => resolveToutiaoProfileDir("/data/storage", "/data/storage"),
    (error: unknown) => error instanceof ToutiaoBrowserError,
  );
});

// ─── 「打开浏览器窗口扫码」用的有头解析链 ────────────────────────────────────

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("有头链跳过打包的 headless shell（它开不了窗口），改用系统 Chrome", () => {
  const root = "/repo";
  const resolution = resolveToutiaoHeadedBrowser({
    repoRoot: root,
    platform: "darwin",
    env: {},
    // 打包资源在，但它是无头专用构建 —— 有头链必须**不用**它。
    probe: { ...vendoredProbe(root), isFile: (target: string) => target === MAC_CHROME },
  });

  assert.deepEqual(resolution.target, { kind: "channel", channel: "chrome" });
  assert.equal(
    resolution.attempts.find((attempt) => attempt.layer === "vendored")?.ok,
    false,
    "有头链不该把无头 shell 当成可用目标",
  );
  assert.match(
    resolution.attempts.find((attempt) => attempt.layer === "vendored")?.detail ?? "",
    /不能开窗口/u,
  );
});

test("没有系统 Chrome 时退到 Playwright 缓存里的完整 chromium（headless shell 不算）", () => {
  const home = process.env.HOME ?? "";
  const cacheRoot = path.join(home, "Library", "Caches", "ms-playwright");
  const chromiumDir = path.join(cacheRoot, "chromium-1234");
  const probe = fakeProbe([], {
    [cacheRoot]: ["chromium-1234", "chromium_headless_shell-1234"],
    [chromiumDir]: ["chrome-mac-arm64"],
  });

  const resolution = resolveToutiaoHeadedBrowser({
    platform: "darwin",
    env: { HOME: home },   // 缓存根按传入 env 解析（不再直接读 process.env）
    probe,
  });
  assert.deepEqual(resolution.target, { kind: "playwright" });
});

test("有头链一层都不可用时返回 null（界面据此提示改用应用内扫码）", () => {
  const resolution = resolveToutiaoHeadedBrowser({
    platform: "darwin",
    env: {},
    probe: fakeProbe([]),
  });

  assert.equal(resolution.target, null);
  assert.equal(
    resolution.attempts.every((attempt) => attempt.ok === false),
    true,
  );
});

test("findSystemChrome 按平台找常见位置", () => {
  assert.equal(
    findSystemChrome({ platform: "darwin", probe: fakeProbe([MAC_CHROME]) }),
    MAC_CHROME,
  );
  assert.equal(findSystemChrome({ platform: "darwin", probe: fakeProbe([]) }), undefined);
  assert.equal(
    findSystemChrome({ platform: "linux", probe: fakeProbe(["/usr/bin/google-chrome"]) }),
    "/usr/bin/google-chrome",
  );
});
