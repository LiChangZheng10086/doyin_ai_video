/**
 * 小红书浏览器解析测试。
 *
 * 与 `toutiao-browser.test.ts` 同形（这是刻意的：形状一致才好复用测试范式），
 * 但**码值与文案是小红书自己的**。本文件**全程不启浏览器、不联网**：
 * 文件系统探测通过注入的假 probe 完成，另有两条用真实临时目录的用例，
 * 确保真实的目录遍历写法也成立。
 *
 * 解析顺序：显式配置 → env(`XHS_BROWSER_BINARY`) → vendor 打包资源 → Playwright 缓存 → 系统 Chrome。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  XHS_BROWSER_GUIDANCE,
  XhsBrowserError,
  findSystemChrome,
  requireXhsBrowserTarget,
  resolveXhsBrowser,
  resolveXhsBrowserTarget,
  resolveXhsHeadedBrowser,
  resolveXhsProfileDir,
  type XhsBrowserProbe,
} from "./xhs-browser.js";

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix = "xhs-browser-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 假文件系统：只认显式登记的文件与目录，测试里不碰真实磁盘。 */
function fakeProbe(files: string[], directories: Record<string, string[]> = {}): XhsBrowserProbe {
  const fileSet = new Set(files.map((item) => path.resolve(item)));
  return {
    isFile: (target) => fileSet.has(path.resolve(target)),
    listDirectories: (target) => directories[path.resolve(target)] ?? [],
  };
}

/** 与真实资源同形的 vendor 路径。 */
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

function vendoredProbe(root: string, versions = ["mac_arm-152.0.7928.2"]): XhsBrowserProbe {
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

/** 一个什么也没有的假环境（不认任何文件、任何目录、没有任何 env）。 */
function emptyProbe(): XhsBrowserProbe {
  return fakeProbe([], {});
}

test("显式配置优先，且指向不存在的文件时直接抛错、不静默退到下一层", () => {
  const root = "/repo";
  // 即使 vendor 里有可用的 shell，显式配置写错了也必须报错 ——
  // 静默回退会把「路径打错了」变成「用的是别的浏览器」，排查时完全看不出真相。
  assert.throws(
    () =>
      resolveXhsBrowser({
        browserBinary: "/nope/chrome-headless-shell",
        repoRoot: root,
        probe: vendoredProbe(root),
      }),
    (error: unknown) =>
      error instanceof XhsBrowserError &&
      error.code === "xhs_browser_unavailable" &&
      error.message.includes("/nope/chrome-headless-shell") &&
      error.message.includes("XHS_BROWSER_BINARY"),
  );
});

test("env 优先于 vendor，且 env 指向的文件不存在时同样抛错", () => {
  const root = "/repo";
  const envShell = "/env/chrome-headless-shell";

  const resolved = resolveXhsBrowser({
    repoRoot: root,
    env: { XHS_BROWSER_BINARY: envShell },
    probe: fakeProbe([envShell, vendoredShellPath(root)]),
  });
  assert.equal(resolved.target?.kind, "executablePath");
  assert.equal(resolved.target?.kind === "executablePath" ? resolved.target.path : "", envShell);
  assert.equal(resolved.target?.kind === "executablePath" ? resolved.target.source : "", "env");

  assert.throws(
    () =>
      resolveXhsBrowser({
        repoRoot: root,
        env: { XHS_BROWSER_BINARY: "/env/missing" },
        probe: vendoredProbe(root),
      }),
    (error: unknown) => error instanceof XhsBrowserError && error.message.includes("/env/missing"),
  );
});

test("vendor 解析：版本目录按名降序取第一个，且返回 vendored 来源", () => {
  const root = "/repo";
  const versions = ["mac_arm-150.0.0.0", "mac_arm-152.0.7928.2"];
  const resolution = resolveXhsBrowser({
    repoRoot: root,
    env: {},
    probe: vendoredProbe(root, versions),
  });

  assert.equal(resolution.target?.kind, "executablePath");
  assert.equal(
    resolution.target?.kind === "executablePath" ? resolution.target.path : "",
    vendoredShellPath(root, "mac_arm-152.0.7928.2"),
  );
  assert.equal(resolution.target?.kind === "executablePath" ? resolution.target.source : "", "vendored");
  assert.deepEqual(
    resolution.attempts.map((attempt) => [attempt.layer, attempt.ok]),
    [["config", false], ["env", false], ["vendored", true]],
  );
});

test("有头链跳过打包的 headless shell（它开不了窗口）", () => {
  const root = "/repo";
  const resolution = resolveXhsHeadedBrowser({
    repoRoot: root,
    env: {},
    probe: vendoredProbe(root),
  });

  // 有 vendor shell 也不能用它：headless shell 开不了窗口，扫码登录会失败。
  assert.equal(resolution.target, null);
  const vendored = resolution.attempts.find((attempt) => attempt.layer === "vendored");
  assert.equal(vendored?.ok, false);
  assert.match(vendored?.detail ?? "", /无头专用构建/);

  // 有系统 Chrome 时，有头链才给出 channel=chrome。
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const withChrome = resolveXhsHeadedBrowser({
    repoRoot: root,
    env: {},
    probe: fakeProbe([chromePath], {}),
  });
  assert.deepEqual(withChrome.target, { kind: "channel", channel: "chrome" });
});

test("全部不可用时给出两条可照抄的命令（而不是只说「未找到浏览器」）", () => {
  const error = (() => {
    try {
      requireXhsBrowserTarget({ repoRoot: "/repo", env: {}, probe: emptyProbe() });
      return null;
    } catch (caught: unknown) {
      return caught;
    }
  })();

  assert.ok(error instanceof XhsBrowserError);
  assert.equal(error.code, "xhs_browser_unavailable");
  assert.ok(error.message.includes("npm run prepare:package:mac"));
  assert.ok(error.message.includes("npx playwright install chromium"));
  assert.ok(error.message.includes("逐层诊断"));
  assert.equal(XHS_BROWSER_GUIDANCE.includes("XHS_BROWSER_BINARY"), true);
});

test("系统 Chrome 缺省**不允许**退到（它的不确定性更大）", () => {
  const root = "/repo";
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  const strict = resolveXhsBrowser({ repoRoot: root, env: {}, probe: fakeProbe([chromePath], {}) });
  assert.equal(strict.target, null);

  const allowed = resolveXhsBrowser({
    repoRoot: root,
    env: {},
    probe: fakeProbe([chromePath], {}),
    allowSystemChrome: true,
  });
  assert.deepEqual(allowed.target, { kind: "channel", channel: "chrome" });
});

test("真实临时目录也能被解析出来（不只假 probe 成立）", async () => {
  const root = await tempDir("xhs-real-");
  const binary = vendoredShellPath(root, "mac_arm-152.0.7928.2");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "#!/bin/sh\n");

  const target = resolveXhsBrowserTarget({ repoRoot: root, env: {} });
  assert.equal(target?.kind, "executablePath");
  assert.equal(target?.kind === "executablePath" ? target.path : "", binary);
});

test("会话目录：缺省落在 storage/xhs/profile，缺省值可用真实临时目录验证", async () => {
  const storage = await tempDir("xhs-storage-");
  assert.equal(resolveXhsProfileDir(storage), path.join(storage, "xhs", "profile"));
  assert.equal(resolveXhsProfileDir(storage, path.join(storage, "custom")), path.join(storage, "custom"));
});

test("会话目录：越出 storage 的 override 被拒（登录态不许落到 storage 之外）", () => {
  const storage = "/repo/storage";
  for (const bad of ["/tmp/elsewhere", path.join(storage, "..", "outside"), storage]) {
    assert.throws(
      () => resolveXhsProfileDir(storage, bad),
      (error: unknown) =>
        error instanceof XhsBrowserError &&
        error.code === "xhs_profile_dir_unsafe" &&
        error.message.includes("必须落在 storage 内"),
    );
  }
});

test("findSystemChrome 只认登记过的路径", () => {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.equal(findSystemChrome({ platform: "darwin", probe: fakeProbe([chromePath]) }), chromePath);
  assert.equal(findSystemChrome({ platform: "darwin", probe: emptyProbe() }), undefined);
});
