/**
 * 小红书执行器（登录/会话部分）测试。
 *
 * **全程不启浏览器、不联网**：会话开启器按 `XhsRunnerConfig.openSession` 注入假实现。
 * ⚠️ 注入键名必须与配置接口一致 —— 头条那轮把夹具注入到**错误的键**上，测试里于是构造了
 * **真执行器**、真的启动了一个无头浏览器并留下 5 个孤儿进程（见 worklog 2026-09-18）。
 *
 * 本文件重点守两条**实测踩出来的**登录纪律：
 * ① 登录态判据是「已离开登录页 ∧ 无登录阻断信号」，**不能要求发布页 DOM 出现**；
 * ② 二维码要从「切换扫码登录」图标那一堆 `data:` 图里**按面积门槛**挑出来。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  XHS_HOME_URL,
  XHS_LOGIN_URL,
  XHS_QR_MIN_AREA,
  XhsRunner,
  XhsRunnerError,
  hasLoginBlocker,
  isXhsLoginUrl,
  openXhsSession,
  readXhsQrDataUrl,
  readXhsUsername,
  type XhsBrowserSession,
  type XhsPageLike,
} from "./xhs-runner.js";

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix = "xhs-runner-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface FakePageOptions {
  /** `goto` 之后落到的 URL（可以按调用次数依次给，模拟「跳转还没落地」）。 */
  urls: string[];
  qr?: string | null;
  /** 登录阻断信号命中数（>0 表示还停在登录界面）。 */
  blockers?: number;
  username?: string;
  /** 点「切换扫码登录」之后才出现二维码（模拟登录页默认短信登录）。 */
  qrAfterToggle?: string | null;
  toggles?: number;
}

interface FakePage extends XhsPageLike {
  setUrl(url: string): void;
  readonly visits: string[];
  readonly clicks: string[];
  readonly expressions: string[];
}

/** 按页面侧表达式里的标记词分派返回值 —— 我们只实现了登录需要的这一小面。 */
function fakePage(options: FakePageOptions): FakePage {
  const visits: string[] = [];
  const clicks: string[] = [];
  const expressions: string[] = [];
  let url = options.urls[0] ?? XHS_HOME_URL;
  let gotoCount = 0;
  let toggled = false;

  const page: FakePage = {
    visits,
    clicks,
    expressions,
    setUrl(nextUrl: string) { url = nextUrl; },
    async goto(target: string) {
      visits.push(target);
      url = options.urls[Math.min(gotoCount, options.urls.length - 1)] ?? target;
      gotoCount += 1;
      return undefined;
    },
    url: () => url,
    async evaluate<T>(expression: string): Promise<T> {
      expressions.push(expression);
      if (expression.includes("data:image")) {
        const value = toggled ? (options.qrAfterToggle ?? options.qr ?? null) : (options.qr ?? null);
        return (value ?? null) as unknown as T;
      }
      if (expression.includes("扫码登录")) {
        return ((toggled ? 0 : (options.blockers ?? 0)) as unknown) as T;
      }
      if (expression.includes("退出登录")) {
        return ((options.username ?? "") as unknown) as T;
      }
      return ("" as unknown) as T;
    },
    async waitForTimeout() {
      return undefined;
    },
    locator(selector: string) {
      return {
        count: async () => options.toggles ?? 0,
        first: () => ({
          click: async () => {
            clicks.push(selector);
            toggled = true;
          },
        }),
      };
    },
  };
  return page;
}

function fakeSession(page: XhsPageLike): XhsBrowserSession & { closed: boolean } {
  const session = {
    page,
    closed: false,
    async close() {
      session.closed = true;
    },
  };
  return session;
}

function runnerWith(options: {
  page: XhsPageLike;
  storageRoot: string;
  now?: () => number;
}): { runner: XhsRunner; session: XhsBrowserSession & { closed: boolean }; calls: number } {
  const session = fakeSession(options.page);
  let calls = 0;
  const runner = new XhsRunner({
    storageRoot: options.storageRoot,
    // 与真实环境同形的 vendor 路径不必存在：解析链允许注入 probe，这里直接给假可执行文件。
    browserBinary: process.execPath,
    ...(options.now ? { now: options.now } : {}),
    sleep: async () => undefined,
    openSession: async () => {
      calls += 1;
      return session;
    },
  });
  return {
    runner,
    session,
    get calls() {
      return calls;
    },
  } as { runner: XhsRunner; session: XhsBrowserSession & { closed: boolean }; calls: number };
}

test("登录态判据：已离开登录页且无阻断信号即算已登录（**不要求发布页 DOM 出现**）", async () => {
  const storage = await tempDir();
  // 这正是实测踩过的坑：扫码成功后落到 /new/home，那里标题框/编辑器全部为 0；
  // 若把「发布页 DOM 出现」当必要条件，就会在扫码成功后还傻等。
  const page = fakePage({ urls: [XHS_HOME_URL], blockers: 0, username: "李在那" });
  const { runner, session } = runnerWith({ page, storageRoot: storage });

  const state = await runner.checkLogin();
  assert.equal(state.loggedIn, true);
  assert.equal(state.username, "李在那");
  assert.equal(state.url, XHS_HOME_URL);
  assert.equal(session.closed, true, "自检结束后必须关掉浏览器（否则留下孤儿进程）");
  // 全程只读：没有任何点击。
  assert.deepEqual(page.clicks, []);
});

test("登录态判据：停在登录页要**重试后才作数**（第一次未落地、第二次已登录 → 已登录）", async () => {
  const storage = await tempDir();
  const page = fakePage({ urls: [XHS_LOGIN_URL, XHS_HOME_URL], blockers: 0, username: "李在那" });
  const { runner } = runnerWith({ page, storageRoot: storage });

  const state = await runner.checkLogin();
  assert.equal(state.loggedIn, true, "第二次已落地就必须判为已登录（假阴性会让用户去重扫一个好码）");
  assert.equal(page.visits.length, 2);
});

test("登录态判据：两次都停在登录页 → 未登录（重试不放松判定）", async () => {
  const storage = await tempDir();
  const page = fakePage({ urls: [XHS_LOGIN_URL, XHS_LOGIN_URL] });
  const { runner } = runnerWith({ page, storageRoot: storage });

  const state = await runner.checkLogin();
  assert.equal(state.loggedIn, false);
  assert.equal(page.visits.length, 2);
});

test("登录态判据：同一 URL 上出现登录弹层（阻断信号）也算未登录", async () => {
  const storage = await tempDir();
  const page = fakePage({ urls: [XHS_HOME_URL, XHS_HOME_URL], blockers: 2 });
  const { runner } = runnerWith({ page, storageRoot: storage });

  const state = await runner.checkLogin();
  assert.equal(state.loggedIn, false);
});

test("isXhsLoginUrl / hasLoginBlocker 基本口径", async () => {
  assert.equal(isXhsLoginUrl("https://creator.xiaohongshu.com/login"), true);
  assert.equal(isXhsLoginUrl("https://creator.xiaohongshu.com/new/home"), false);

  const blocked = fakePage({ urls: [XHS_HOME_URL], blockers: 1 });
  assert.equal(await hasLoginBlocker(blocked), true);
  const clean = fakePage({ urls: [XHS_HOME_URL], blockers: 0 });
  assert.equal(await hasLoginBlocker(clean), false);
});

test("二维码：面积达不到门槛一律返回 null（那个 64×64 的「切换扫码登录」图标不是二维码）", async () => {
  const small = fakePage({ urls: [XHS_LOGIN_URL], qr: "data:image/png;base64,AAA" });
  // 假页面无法给真实面积，所以这里直接断言门槛常量本身与「页面返回什么就透传什么」的行为，
  // 面积计算逻辑由探针在真机上验证（实测真码 160×160=25600 ≥ 20000、图标 64×64=4096 < 20000）。
  assert.equal(XHS_QR_MIN_AREA, 20_000);
  assert.equal(await readXhsQrDataUrl(small), "data:image/png;base64,AAA");

  const none = fakePage({ urls: [XHS_LOGIN_URL], qr: null });
  assert.equal(await readXhsQrDataUrl(none), null);
});

test("startLogin：登录页默认短信登录 → 先切扫码模式再取码", async () => {
  const storage = await tempDir();
  const page = fakePage({
    urls: [XHS_LOGIN_URL],
    qr: null,
    qrAfterToggle: "data:image/png;base64,REAL",
    toggles: 1,
  });
  const { runner } = runnerWith({ page, storageRoot: storage });

  const started = await runner.startLogin();
  assert.equal(started.qrDataUrl, "data:image/png;base64,REAL");
  assert.equal(page.clicks.length, 1, "必须点过一次「切换扫码登录」");
  assert.ok(Date.parse(started.expiresAt) > Date.parse(started.startedAt));
  await runner.dispose();
});

test("startLogin：切了也取不到码 → xhs_qr_unavailable 且给出可照抄的侦察命令", async () => {
  const storage = await tempDir();
  const page = fakePage({ urls: [XHS_LOGIN_URL], qr: null, qrAfterToggle: null, toggles: 1 });
  const { runner, session } = runnerWith({ page, storageRoot: storage });

  await assert.rejects(
    () => runner.startLogin(),
    (error: unknown) =>
      error instanceof XhsRunnerError &&
      error.code === "xhs_qr_unavailable" &&
      error.status === 422 &&
      error.message.includes("probe-xhs-publish-page.ts --login"),
  );
  assert.equal(session.closed, true, "失败路径也必须关掉浏览器");
});

test("startLogin：已有进行中的会话 → 409（不许两个扫码会话并存）", async () => {
  const storage = await tempDir();
  const page = fakePage({ urls: [XHS_LOGIN_URL], qr: "data:image/png;base64,REAL" });
  const { runner } = runnerWith({ page, storageRoot: storage });

  await runner.startLogin();
  await assert.rejects(
    () => runner.startLogin(),
    (error: unknown) => error instanceof XhsRunnerError && error.code === "xhs_login_in_progress" && error.status === 409,
  );
  await runner.dispose();
});

test("pollLogin：没有会话时 idle；过期后 expired", async () => {
  const storage = await tempDir();
  const page = fakePage({ urls: [XHS_LOGIN_URL], qr: "data:image/png;base64,REAL" });
  let clock = 1_000;
  const { runner } = runnerWith({ page, storageRoot: storage, now: () => clock });

  assert.deepEqual(await runner.pollLogin(), { status: "idle" });

  await runner.startLogin();
  clock += 11 * 60 * 1000; // 越过默认 10 分钟
  assert.deepEqual(await runner.pollLogin(), { status: "expired" });
});

test("pollLogin：登录成功后回 logged_in 并带回昵称", async () => {
  const storage = await tempDir();
  // 扫码后由平台自行跳转，不应靠轮询重新导航才模拟成功。
  const page = fakePage({
    urls: [XHS_LOGIN_URL],
    qr: "data:image/png;base64,REAL",
    blockers: 0,
    username: "李在那",
  });
  const { runner } = runnerWith({ page, storageRoot: storage });

  await runner.startLogin();
  page.setUrl("https://creator.xiaohongshu.com/new/home");
  const state = await runner.pollLogin();
  assert.equal(state.status, "logged_in");
  assert.equal(state.username, "李在那");
  await runner.dispose();
});

test("扫码轮询不导航打断二维码，平台换码后回传当前码，扫码后关闭会话保存登录态", async () => {
  const options = { urls: [XHS_LOGIN_URL], qr: "data:image/png;base64,OLD" };
  const page = fakePage(options);
  const { runner, session } = runnerWith({ page, storageRoot: await tempDir() });
  try {
    await runner.startLogin();
    const visits = [...page.visits];
    options.qr = "data:image/png;base64,NEW";
    assert.deepEqual(await runner.pollLogin(), { status: "waiting", qrDataUrl: "data:image/png;base64,NEW" });
    assert.deepEqual(page.visits, visits, "轮询不能刷新登录页，否则用户扫的是已被作废的旧码");
    assert.equal(session.closed, false);
    page.setUrl("https://creator.xiaohongshu.com/new/home");
    assert.deepEqual(await runner.pollLogin(), { status: "logged_in" });
    assert.equal(session.closed, true);
    assert.deepEqual(page.visits, visits);
  } finally {
    await runner.dispose();
  }
});

test("扫码期间校验复用活跃页面，未确认时保留二维码，不另开持有相同 profile 的浏览器", async () => {
  const page = fakePage({ urls: [XHS_LOGIN_URL], qr: "data:image/png;base64,REAL", username: "测试用户" });
  const fixture = runnerWith({ page, storageRoot: await tempDir() });
  try {
    await fixture.runner.startLogin();
    const visits = [...page.visits];
    await assert.rejects(() => fixture.runner.checkLogin(), (error: unknown) =>
      error instanceof XhsRunnerError && error.code === "xhs_login_in_progress");
    assert.equal(fixture.calls, 1);
    assert.equal(fixture.session.closed, false);
    page.setUrl("https://creator.xiaohongshu.com/new/home");
    assert.equal((await fixture.runner.checkLogin()).loggedIn, true);
    assert.equal(fixture.session.closed, true, "校验成功必须落盘并释放 profile，不能依赖用户继续停留等下一次轮询");
    assert.equal(fixture.calls, 1);
    assert.deepEqual(page.visits, visits);
    assert.equal((await fixture.runner.pollLogin()).status, "idle");
  } finally {
    await fixture.runner.dispose();
  }
});

test("扫码后跳转尚未稳定、页面读取异常时继续等待，不能误报成功并关闭登录会话", async () => {
  const page = fakePage({ urls: [XHS_LOGIN_URL], qr: "data:image/png;base64,REAL" });
  const { runner, session } = runnerWith({ page, storageRoot: await tempDir() });
  try {
    await runner.startLogin();
    page.setUrl("https://creator.xiaohongshu.com/new/home");
    page.evaluate = async () => { throw new Error("Execution context was destroyed"); };
    assert.deepEqual(await runner.pollLogin(), { status: "waiting" });
    assert.equal(session.closed, false);
  } finally {
    await runner.dispose();
  }
});

test("本机没有可显示窗口的浏览器时，loginInWindow 指向「应用内扫码」", async () => {
  const storage = await tempDir();
  const page = fakePage({ urls: [XHS_LOGIN_URL] });
  const runner = new XhsRunner({
    storageRoot: storage,
    env: {},
    // 一张干净的文件系统：vendor 没有、系统 Chrome 没有、Playwright 缓存也没有。
    probe: { isFile: () => false, listDirectories: () => [] },
    allowPlaywrightCache: false,
    openSession: async () => fakeSession(page),
  });

  await assert.rejects(
    () => runner.loginInWindow(),
    (error: unknown) =>
      error instanceof XhsRunnerError &&
      error.code === "xhs_browser_unavailable" &&
      error.status === 422 &&
      error.message.includes("应用内扫码") &&
      error.message.includes("逐层诊断"),
  );
});

test("显式配置的浏览器路径不存在时：**不静默退到别的浏览器**，直接把路径报出来", async () => {
  const storage = await tempDir();
  const runner = new XhsRunner({
    storageRoot: storage,
    browserBinary: "/nonexistent/Chrome",
    // 假 probe 必须**如实**说这个路径不存在；否则「显式配置」这一层会被判为可用，
    // 测试就变成了在测别的东西（第一版就是这么写错的：probe 一律返回 true）。
    probe: { isFile: (target) => target !== "/nonexistent/Chrome", listDirectories: () => [] },
    windowLoginTimeoutMs: 50,
    openSession: async () => fakeSession(fakePage({ urls: [XHS_LOGIN_URL] })),
  });

  await assert.rejects(
    () => runner.loginInWindow(),
    (error: unknown) =>
      error instanceof XhsRunnerError &&
      error.code === "xhs_browser_unavailable" &&
      error.status === 422 &&
      error.message.includes("/nonexistent/Chrome"),
  );
});

test("会话目录越出 storage：构造执行器时就报 xhs_profile_dir_unsafe", async () => {
  const storage = await tempDir();
  assert.throws(
    () => new XhsRunner({ storageRoot: storage, profileDir: "/tmp/elsewhere", browserBinary: process.execPath }),
    (error: unknown) =>
      error instanceof XhsRunnerError &&
      error.code === "xhs_profile_dir_unsafe" &&
      error.status === 422,
  );
});

test("openXhsSession：会话目录建不出来时报「不可写」并指出是哪个目录（不冒原始 EPERM）", async () => {
  const storage = await tempDir();
  // 把一个**文件**当成会话目录：mkdir recursive 会失败 → 必须报 xhs_profile_dir_unsafe。
  const asFile = path.join(storage, "profile-is-a-file");
  await writeFile(asFile, "not a directory");

  await assert.rejects(
    () => openXhsSession({ profileDir: asFile, target: { kind: "playwright" } }),
    (error: unknown) =>
      error instanceof XhsRunnerError &&
      error.code === "xhs_profile_dir_unsafe" &&
      error.message.includes(asFile),
  );
});

test("assertConfigured：解析不到浏览器时抛 xhs_browser_unavailable（在写任何记录之前）", async () => {
  const storage = await tempDir();
  const runner = new XhsRunner({
    storageRoot: storage,
    env: {},
    repoRoot: "/nonexistent-repo",
    probe: { isFile: () => false, listDirectories: () => [] },
    openSession: async () => fakeSession(fakePage({ urls: [XHS_HOME_URL] })),
  });
  assert.throws(
    () => runner.assertConfigured(),
    (error: unknown) =>
      error instanceof XhsRunnerError &&
      error.code === "xhs_browser_unavailable" &&
      error.message.includes("逐层诊断"),
  );
});

test("readXhsUsername：从「… 昵称 退出登录」里取昵称（读不到返回 undefined，不阻塞登录）", async () => {
  const withName = fakePage({ urls: [XHS_HOME_URL], username: "李在那" });
  assert.equal(await readXhsUsername(withName), "李在那");

  const withoutName = fakePage({ urls: [XHS_HOME_URL], username: "" });
  assert.equal(await readXhsUsername(withoutName), undefined);
});

test("⚠️ 已经登录时 startLogin **不再去取码**，而是明说「无需再扫码」（不误诊成页面改版）", async () => {
  const storage = await tempDir();
  // 账号已登录时的真实形态：访问登录页会被重定向走，页面上**没有二维码**。
  // 原先的实现会一路走到取码失败，报出「页面结构可能已改版」——把「你不需要扫码」说成「页面坏了」。
  const page = fakePage({ urls: [XHS_HOME_URL], blockers: 0, username: "李在那", qr: null, toggles: 0 });
  const { runner } = runnerWith({ page, storageRoot: storage });

  await assert.rejects(
    () => runner.startLogin(),
    (error: unknown) =>
      error instanceof XhsRunnerError &&
      error.code === "xhs_already_logged_in" &&
      error.status === 409 &&
      error.message.includes("已经是登录状态") &&
      error.message.includes("无需再扫码"),
  );
  // 也**不该**去点「切换扫码登录」——既然不需要码，就不该动那个页面。
  assert.deepEqual(page.clicks, []);
  assert.equal(page.visits.some((url) => url.includes("/login")), false, "不该再访问登录页");
});
