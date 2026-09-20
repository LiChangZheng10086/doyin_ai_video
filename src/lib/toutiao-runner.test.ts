/**
 * 今日头条执行器：登录会话与账号自检测试。
 *
 * **全程不启浏览器、不联网**：页面与启动器都是注入的假实现。
 * 真实的页面步骤与选择器归 `toutiao-page.test.ts`（用离线 fixture 页跑真 Playwright）。
 *
 * 这里守住的是本功能最容易出事故的两处：
 * ① **孤儿浏览器**（本项目吃过「9 个孤儿无头浏览器」的亏）→ 每条路径都必须关闭 context；
 * ② **会话单飞**（同一时刻只允许一个登录会话，否则扫码页会互相顶掉）。
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ToutiaoRunner,
  ToutiaoRunnerError,
  isLoginUrl,
  openToutiaoSession,
  type ToutiaoBrowserSession,
  type ToutiaoLaunchOptions,
  type ToutiaoPageLike,
} from "./toutiao-runner.js";

const LOGIN_URL = "https://mp.toutiao.com/auth/page/login?redirect_url=JTJGcHJvZmlsZV92NCUyRg==";
const PUBLISH_URL = "https://mp.toutiao.com/profile_v4/graphic/publish";
const QR_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAgAAAAIA";

interface FakePageOptions {
  /** 依次返回的 URL；用完后固定用最后一个。 */
  urls?: string[];
  qrDataUrl?: string | null;
  username?: string;
  /** `goto` 之后把当前 URL 换成这个（模拟跳转）。 */
  urlAfterGoto?: string;
}

class FakePage implements ToutiaoPageLike {
  url_: string;
  readonly navigations: string[] = [];
  private reads = 0;

  constructor(private readonly options: FakePageOptions = {}) {
    this.url_ = options.urls?.[0] ?? LOGIN_URL;
  }

  url(): string {
    const urls = this.options.urls;
    if (urls && urls.length > 0) {
      const value = urls[Math.min(this.reads, urls.length - 1)];
      this.reads += 1;
      return value;
    }
    return this.url_;
  }

  async goto(target: string): Promise<void> {
    this.navigations.push(target);
    if (this.options.urlAfterGoto) this.url_ = this.options.urlAfterGoto;
  }

  async evaluate<T>(pageFunction: unknown, arg?: unknown): Promise<T> {
    const source = String(pageFunction);
    if (source.includes("data:image/png")) {
      return (this.options.qrDataUrl === undefined ? QR_DATA_URL : this.options.qrDataUrl) as T;
    }
    void arg;
    return (this.options.username ?? "") as T;
  }
}

class FakeSession implements ToutiaoBrowserSession {
  closed = false;

  constructor(readonly page: FakePage) {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

function fakeRunner(options: {
  page?: FakePage;
  nowRef?: { value: number };
  config?: Record<string, unknown>;
} = {}) {
  const page = options.page ?? new FakePage();
  const session = new FakeSession(page);
  const launches: ToutiaoLaunchOptions[] = [];
  const nowRef = options.nowRef ?? { value: Date.UTC(2026, 8, 18, 0, 0, 0) };

  const runner = new ToutiaoRunner({
    storageRoot: "/data/storage",
    launch: async (launchOptions) => {
      launches.push(launchOptions);
      return session;
    },
    now: () => nowRef.value,
    // 假启动器已经绕过了真实浏览器解析；这里仍给出一个存在的资源，避免 assertConfigured 先抛。
    browserBinary: fileURLToPath(import.meta.url),
    ...options.config,
  });

  return { runner, session, page, launches, nowRef };
}

test("isLoginUrl 认得登录页与 SSO 跳转，不误判发布页", () => {
  assert.equal(isLoginUrl(LOGIN_URL), true);
  assert.equal(isLoginUrl("https://sso.toutiao.com/login"), true);
  assert.equal(isLoginUrl(PUBLISH_URL), false);
  assert.equal(isLoginUrl("https://mp.toutiao.com/profile_v4/"), false);
});

// 真机实测（2026-09-18）：应用刚启动时第一次自检报「未登录」，几秒后再查同一份 profile 就是
// 「已登录（昵称）」。也就是说**首页还没跳到终点就下了结论**，而那结论会直接把发布拦在
// 「登录态已失效，请重新扫码」上 —— 用户被误导去重扫一个其实好好的码。所以必须**重试后再判**。
test("checkLogin 只在重试后仍停在登录页时才报未登录（避免刚启动时的假阴性）", async () => {
  // 第一次读到的还是登录页（跳转没完成），第二次才是首页。
  const flaky = fakeRunner({ page: new FakePage({ urls: [LOGIN_URL, PUBLISH_URL], username: "头条作者" }) });
  const state = await flaky.runner.checkLogin();
  assert.equal(state.loggedIn, true);
  assert.equal(state.username, "头条作者");
  assert.equal(flaky.session.closed, true);

  // 真的没登录：两次都停在登录页 → 仍然如实报未登录（不能因为重试就放松判定）。
  const loggedOut = fakeRunner({ page: new FakePage({ urls: [LOGIN_URL] }) });
  const state2 = await loggedOut.runner.checkLogin();
  assert.equal(state2.loggedIn, false);
});

test("checkLogin 用 URL 判登录态（未登录时头条会 302 到 /auth/page/login）", async () => {
  const loggedIn = fakeRunner({ page: new FakePage({ urls: [PUBLISH_URL], username: "头条作者" }) });
  const state = await loggedIn.runner.checkLogin();
  assert.equal(state.loggedIn, true);
  assert.equal(state.username, "头条作者");
  assert.equal(state.url, PUBLISH_URL);
  // 零副作用 + 不留孤儿：自检结束后必须关闭 context。
  assert.equal(loggedIn.session.closed, true);

  const loggedOut = fakeRunner({ page: new FakePage({ urls: [LOGIN_URL] }) });
  const state2 = await loggedOut.runner.checkLogin();
  assert.equal(state2.loggedIn, false);
  assert.equal(loggedOut.session.closed, true);
});

test("startLogin 返回二维码 data URL 与过期时间，并把页面导航到登录页", async () => {
  const { runner, page, nowRef } = fakeRunner();

  const started = await runner.startLogin();
  assert.equal(started.qrDataUrl, QR_DATA_URL);
  assert.equal(page.navigations.length, 1);
  assert.match(page.navigations[0]!, /auth\/page\/login/u);
  // 二维码约 50 秒刷新一次，10 分钟足够扫完；过期后重新 startLogin 即可。
  assert.equal(
    new Date(started.expiresAt).getTime() - new Date(started.startedAt).getTime(),
    10 * 60 * 1000,
  );
  assert.equal(new Date(started.startedAt).getTime(), nowRef.value);
});

test("同一时刻只允许一个登录会话（避免两个扫码页互相顶掉）", async () => {
  const { runner, launches } = fakeRunner();
  await runner.startLogin();

  await assert.rejects(
    () => runner.startLogin(),
    (error: unknown) => {
      assert.ok(error instanceof ToutiaoRunnerError);
      assert.equal(error.code, "toutiao_login_in_progress");
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.equal(launches.length, 1);
});

test("拿不到二维码时明确报错并关闭浏览器（不留孤儿）", async () => {
  const { runner, session } = fakeRunner({ page: new FakePage({ qrDataUrl: null }) });

  await assert.rejects(
    () => runner.startLogin(),
    (error: unknown) => error instanceof ToutiaoRunnerError && error.code === "toutiao_qr_unavailable",
  );
  assert.equal(session.closed, true);
  // 失败后不留下「正在登录」的假状态，用户可以立刻重试。
  assert.deepEqual(await runner.pollLogin(), { status: "idle" });
});

test("轮询到已登录时返回昵称并关闭浏览器（会话留在 profile 目录里）", async () => {
  const { runner, session } = fakeRunner({
    page: new FakePage({ urls: [LOGIN_URL, PUBLISH_URL], username: "头条作者" }),
  });
  await runner.startLogin();

  assert.deepEqual(await runner.pollLogin(), { status: "waiting" });
  assert.deepEqual(await runner.pollLogin(), { status: "logged_in", username: "头条作者" });
  assert.equal(session.closed, true);
  assert.deepEqual(await runner.pollLogin(), { status: "idle" });
});

test("扫描超时（10 分钟无活动）自动过期并关浏览器", async () => {
  const nowRef = { value: Date.UTC(2026, 8, 18, 0, 0, 0) };
  const { runner, session } = fakeRunner({ nowRef });
  await runner.startLogin();

  nowRef.value += 10 * 60 * 1000 - 1;
  assert.deepEqual(await runner.pollLogin(), { status: "waiting" });

  nowRef.value += 1;
  assert.deepEqual(await runner.pollLogin(), { status: "expired" });
  assert.equal(session.closed, true);

  // 过期后可以重新开始（用户重新扫码即可）。
  const again = await runner.startLogin();
  assert.equal(again.qrDataUrl, QR_DATA_URL);
});

test("cancelLogin 关闭浏览器，之后轮询回到 idle", async () => {
  const { runner, session } = fakeRunner();
  await runner.startLogin();

  await runner.cancelLogin();
  assert.equal(session.closed, true);
  assert.deepEqual(await runner.pollLogin(), { status: "idle" });

  // 取消之后再取消是无害的（界面可能重试）。
  await runner.cancelLogin();
});

test("assertConfigured 在解析不到浏览器时抛错，且指引可照抄", () => {
  const runner = new ToutiaoRunner({
    storageRoot: "/data/storage",
    browserBinary: undefined,
    repoRoot: "/definitely/not/a/repo",
    allowPlaywrightCache: false,
    allowSystemChrome: false,
  });

  assert.throws(
    () => runner.assertConfigured(),
    (error: unknown) => {
      assert.ok(error instanceof ToutiaoRunnerError);
      assert.equal(error.code, "toutiao_browser_unavailable");
      assert.match(error.message, /npm run prepare:package:mac/u);
      return true;
    },
  );
});

test("会话目录越界时构造即报错（登录态不能落到 storage 之外）", () => {
  assert.throws(
    () => new ToutiaoRunner({ storageRoot: "/data/storage", profileDir: "/tmp/elsewhere" }),
    (error: unknown) => error instanceof ToutiaoRunnerError && error.code === "toutiao_profile_dir_unsafe",
  );
});

// ─── 启动失败必须「带原因 + 带动作」──────────────────────────────────────────
//
// 2026-09-18 用户实测：应用里点「扫码登录 / 校验登录」只看到一句
// 「发布服务暂时不可用，请稍后重试」。真实原因是 Playwright 启动失败的原始异常
// （`launchPersistentContext: EPERM: operation not permitted, mkdir '<profileDir>'`）
// **既没被包成头条错误、也没被记录**，于是原因与指引一起消失在兜底 500 里。
// 这两条用例守住：启动异常 → `toutiao_browser_unavailable`（422）+ 原始原因 + 可照抄动作。

test("启动器抛出的原始异常被包成头条错误：保留原因并给出动作", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "toutiao-launch-"));

  await assert.rejects(
    () => openToutiaoSession({
      storageRoot,
      browserBinary: fileURLToPath(import.meta.url),
      launch: async () => {
        throw new Error("browserType.launchPersistentContext: EPERM: operation not permitted, mkdir '/Users/x/storage/toutiao'");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ToutiaoRunnerError);
      assert.equal(error.code, "toutiao_browser_unavailable");
      assert.equal(error.status, 422);
      // 原始原因必须留下来（否则用户/维护者都无从判断）。
      assert.match(error.message, /EPERM/u);
      assert.match(error.message, /mkdir/u);
      // 必须给出可照抄的动作，而不是「稍后重试」。
      assert.match(error.message, /TOUTIAO_BROWSER_BINARY/u);
      return true;
    },
  );
});

test("启动器抛出的头条错误原样透出（不被二次包装）", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "toutiao-launch-"));
  const original = new ToutiaoRunnerError("toutiao_browser_unavailable", "原始指引：请装 Chrome");

  await assert.rejects(
    () => openToutiaoSession({
      storageRoot,
      browserBinary: fileURLToPath(import.meta.url),
      launch: async () => {
        throw original;
      },
    }),
    (error: unknown) => error === original,
  );
});

test("会话目录建不出来时报「不可写」并指出路径（而不是丢一句通用的启动失败）", async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "toutiao-profile-"));
  // 用一个**普通文件**当父目录：`mkdir -p` 必然失败（ENOTDIR），且不依赖权限位。
  const blocker = path.join(storageRoot, "blocker");
  await writeFile(blocker, "not a directory");

  await assert.rejects(
    () => openToutiaoSession({
      storageRoot,
      browserBinary: fileURLToPath(import.meta.url),
      profileDir: path.join(blocker, "profile"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ToutiaoRunnerError);
      assert.equal(error.code, "toutiao_profile_dir_unsafe");
      assert.match(error.message, /不可写|无法创建/u);
      assert.match(error.message, /blocker/u);
      return true;
    },
  );
});

// ─── 「打开浏览器窗口扫码」────────────────────────────────────────────────────

test("窗口扫码：有头启动、URL 离开登录页即判定成功，并关闭窗口", async () => {
  const page = new FakePage({ urls: [LOGIN_URL, LOGIN_URL, PUBLISH_URL], username: "头条作者" });
  const { runner, session, launches } = fakeRunner({ page });
  // 有头链要系统 Chrome；这里注入假的探测结果即可（不真启浏览器）。
  const headedRunner = new ToutiaoRunner({
    storageRoot: "/data/storage",
    launch: async (options) => {
      launches.push(options);
      return session;
    },
    now: () => Date.now(),
    platform: "darwin",
    env: {},
    probe: {
      isFile: (target: string) => target.endsWith("Google Chrome"),
      listDirectories: () => [],
    },
  });
  void runner;

  const result = await headedRunner.loginInWindow({ timeoutMs: 20_000 });
  assert.equal(result.loggedIn, true);
  assert.equal(result.username, "头条作者");
  // 必须是有头（`headless: false`）——否则用户看不到窗口，扫码无从谈起。
  assert.equal(launches[0]!.headless, false);
  assert.equal(session.closed, true);
});

test("窗口扫码：没人扫就超时返回失败（并且照样关掉窗口）", async () => {
  const session = new FakeSession(new FakePage({ urls: [LOGIN_URL] }));
  const runner = new ToutiaoRunner({
    storageRoot: "/data/storage",
    launch: async () => session,
    // 时钟每次调用都往前跳 1 分钟：不必真的等 3 分钟。
    now: (() => {
      let current = 0;
      return () => (current += 60_000);
    })(),
    platform: "darwin",
    env: {},
    probe: {
      isFile: (target: string) => target.endsWith("Google Chrome"),
      listDirectories: () => [],
    },
  });

  const result = await runner.loginInWindow({ timeoutMs: 180_000 });
  assert.equal(result.loggedIn, false);
  assert.match(result.message, /超时/u);
  assert.equal(session.closed, true, "超时也要关窗口，不能留下常驻浏览器");
});

test("窗口扫码：本机没有可显示窗口的浏览器时明确报错并指向应用内扫码", async () => {
  const runner = new ToutiaoRunner({
    storageRoot: "/data/storage",
    launch: async () => {
      throw new Error("不该走到启动这一步");
    },
    platform: "darwin",
    env: {},
    probe: { isFile: () => false, listDirectories: () => [] },
  });

  await assert.rejects(
    () => runner.loginInWindow(),
    (error: unknown) => {
      assert.ok(error instanceof ToutiaoRunnerError);
      assert.equal(error.code, "toutiao_browser_unavailable");
      assert.match(error.message, /应用内扫码/u);
      return true;
    },
  );
});
