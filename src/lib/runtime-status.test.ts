import assert from "node:assert/strict";
import test from "node:test";
import { SAU_INSTALL_GUIDANCE } from "./sau-runner.js";
import { TOUTIAO_BROWSER_GUIDANCE } from "./toutiao-browser.js";
import { XHS_BROWSER_GUIDANCE } from "./xhs-browser.js";
import {
  RUNTIME_VERIFIED_TTL_MS,
  collectRuntimeStatus,
  type RuntimeItem,
  type RuntimeStatusConfig,
  type RuntimeStatusDeps,
} from "./runtime-status.js";

/**
 * 运行环境聚合的门禁。
 *
 * 最要紧的一条是 **INV-1**：免费层永远不许说「已登录 / 有效」。
 * 免费检查最多能证明「凭据存在」，证明不了「服务端还认这个登录态」——
 * 后者只有深检（抖音最坏 5 分钟）能回答。
 */

const NOW = new Date("2026-09-22T02:00:00.000Z");
const W_OK = 2;

const SAU_BINARY = "/sau/bin/sau";
const SAU_BASE_DIR = "/sau/repo";
const BROWSER = "/browser/chrome-headless-shell";
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const STORAGE = "/storage";
const COOKIE = "/home/.douyin-ai-video/douyin-cookie.txt";

interface FakeFsCalls {
  access: Array<{ path: string; mode?: number }>;
  readFile: string[];
}

/**
 * 注入用的假 fs。
 *
 * ⚠️ 这个端口**故意只有读操作**（access / readFile）—— 免费检查的 INV-3 是
 * 「不改变任何状态」，把写能力从接口上拿掉，比靠用例去断言"没调用写"更硬。
 */
function makeFs(options: {
  existing: string[];
  writable?: string[];
  unreadable?: string[];
  errno?: string;
}) {
  const calls: FakeFsCalls = { access: [], readFile: [] };
  const existing = new Set(options.existing);
  const writable = new Set(options.writable ?? options.existing);
  const unreadable = new Set(options.unreadable ?? []);
  return {
    calls,
    fs: {
      async access(target: string, mode?: number): Promise<void> {
        calls.access.push({ path: target, mode });
        if (!existing.has(target)) {
          throw Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
        }
        if (mode === W_OK && !writable.has(target)) {
          throw Object.assign(new Error(`EACCES: ${target}`), { code: options.errno ?? "EACCES" });
        }
      },
      async readFile(target: string): Promise<string> {
        calls.readFile.push(target);
        if (unreadable.has(target)) {
          throw Object.assign(new Error(`EACCES: ${target}`), { code: "EACCES" });
        }
        return JSON.stringify({ verified: {} });
      },
    },
  };
}

function makeProbe(options: { fail?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    probe: {
      async runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
        calls.push({ command, args });
        if (options.fail) {
          throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
        }
        return { stdout: "ffmpeg version 7.0\n", stderr: "" };
      },
    },
  };
}

function makeBrowserProbe(existing: string[]) {
  const set = new Set(existing);
  return { isFile: (target: string) => set.has(target), listDirectories: () => [] as string[] };
}

/** 全配置齐备、凭据存在，但**没有任何 verified 记录** —— 免费层能给出的最好结论。 */
function makeDeps(overrides: Partial<RuntimeStatusDeps> = {}, fsOptions: Parameters<typeof makeFs>[0] = {
  existing: [SAU_BINARY, SAU_BASE_DIR, BROWSER, FFMPEG, STORAGE, `${STORAGE}/toutiao`, `${STORAGE}/xhs`],
}) {
  const fakeFs = makeFs(fsOptions);
  const probe = makeProbe();
  const deps: RuntimeStatusDeps = {
    fs: fakeFs.fs,
    probe: probe.probe,
    browserProbe: makeBrowserProbe(fsOptions.existing),
    cookie: { path: COOKIE, hasCookie: () => true, hasAuthCookie: () => true },
    now: () => new Date(NOW),
    ...overrides,
  };
  return { deps, fsCalls: fakeFs.calls, probeCalls: probe.calls };
}

const CONFIG: RuntimeStatusConfig = {
  storageRoot: STORAGE,
  sauBinary: SAU_BINARY,
  sauBaseDir: SAU_BASE_DIR,
  toutiaoBrowserBinary: BROWSER,
  xhsBrowserBinary: BROWSER,
  ffmpegBinary: FFMPEG,
};

function find(response: Awaited<ReturnType<typeof collectRuntimeStatus>>, id: string): RuntimeItem {
  const item = [...response.channels, ...response.dependencies].find((candidate) => candidate.id === id);
  assert.ok(item, `缺少条目 ${id}`);
  return item;
}

test("聚合返回 5 项：3 个渠道顺序固定 + 2 项发布链路依赖", async () => {
  const { deps } = makeDeps();
  const response = await collectRuntimeStatus(CONFIG, deps);

  assert.deepEqual(response.channels.map((item) => item.id), ["douyin", "toutiao", "xiaohongshu"]);
  assert.deepEqual(response.dependencies.map((item) => item.id), ["ffmpeg", "storage"]);
  assert.equal(response.check, null, "Task 1 还没有深检，字段必须是 null 而不是缺失");
  assert.equal(response.checkedAt, NOW.toISOString());
  for (const item of [...response.channels, ...response.dependencies]) {
    assert.ok(item.label.length > 0, `${item.id} 缺 label`);
    assert.ok(item.detail.length > 0, `${item.id} 缺 detail`);
  }
});

test("⚠️ INV-1：免费层文案永不出现「已登录 / 有效」，且无 verified 时不下发该字段", async () => {
  const { deps } = makeDeps();
  const response = await collectRuntimeStatus(CONFIG, deps);

  for (const item of [...response.channels, ...response.dependencies]) {
    assert.doesNotMatch(item.detail, /已登录|登录态有效/u, `${item.id} 的 detail 越权谈有效性：${item.detail}`);
    assert.equal(item.verified, undefined, `${item.id} 没有 verified 记录时不该下发 verified`);
  }
});

test("未配置 SAU_BINARY → douyin 为 blocked，且指引与既有常量逐字一致", async () => {
  const { deps } = makeDeps();
  const response = await collectRuntimeStatus({ ...CONFIG, sauBinary: undefined }, deps);
  const douyin = find(response, "douyin");

  assert.equal(douyin.state, "blocked");
  assert.ok(douyin.guidance, "blocked 必须带可照抄的动作");
  assert.equal(douyin.guidance.join(""), SAU_INSTALL_GUIDANCE);
  assert.deepEqual(douyin.action, { kind: "login", target: "douyin" });
});

test("解析链能落地、凭据存在，但没有 verified → degraded（**不是** ready）", async () => {
  const { deps } = makeDeps();
  const response = await collectRuntimeStatus(CONFIG, deps);

  assert.equal(find(response, "toutiao").state, "degraded");
  assert.equal(find(response, "xiaohongshu").state, "degraded");
  assert.match(find(response, "toutiao").detail, /有效性未知/u);
});

test("cookie 三态各自的 detail，且都不出现「已登录」", async () => {
  const cases: Array<[boolean, boolean, RegExp]> = [
    [true, true, /凭据已存在/u],
    [true, false, /缺少登录态/u],
    [false, false, /尚未登录/u],
  ];
  for (const [hasCookie, hasAuth, pattern] of cases) {
    const { deps } = makeDeps({
      cookie: { path: COOKIE, hasCookie: () => hasCookie, hasAuthCookie: () => hasAuth },
    });
    const douyin = find(await collectRuntimeStatus(CONFIG, deps), "douyin");
    assert.match(douyin.detail, pattern, `hasCookie=${hasCookie} hasAuth=${hasAuth}`);
    assert.doesNotMatch(douyin.detail, /已登录/u);
  }
});

test("凭据为空 → douyin 为 blocked（明确发不出去，而不是「未知」）", async () => {
  const { deps } = makeDeps({
    cookie: { path: COOKIE, hasCookie: () => false, hasAuthCookie: () => false },
  });
  assert.equal(find(await collectRuntimeStatus(CONFIG, deps), "douyin").state, "blocked");
});

test("ffmpeg 探测失败 → blocked + 指引里能照抄出 FFMPEG_BINARY", async () => {
  const fakeFs = makeFs({ existing: [SAU_BINARY, SAU_BASE_DIR, BROWSER, STORAGE] });
  const probe = makeProbe({ fail: true });
  const { deps } = makeDeps({ fs: fakeFs.fs, probe: probe.probe });
  const ffmpeg = find(await collectRuntimeStatus(CONFIG, deps), "ffmpeg");

  assert.equal(ffmpeg.state, "blocked");
  assert.ok(ffmpeg.guidance?.some((line) => line.includes("FFMPEG_BINARY")), "指引必须点名 FFMPEG_BINARY");
});

test("storage 不可写 → blocked，且 errno 原样回显", async () => {
  const { deps } = makeDeps({}, {
    existing: [SAU_BINARY, SAU_BASE_DIR, BROWSER, FFMPEG, STORAGE],
    writable: [SAU_BINARY, SAU_BASE_DIR, BROWSER, FFMPEG],
    errno: "EPERM",
  });
  const storage = find(await collectRuntimeStatus(CONFIG, deps), "storage");

  assert.equal(storage.state, "blocked");
  assert.equal(storage.evidence?.errno, "EPERM");
  assert.equal(storage.evidence?.paths?.[0]?.value, STORAGE);
});

test("profile 目录不存在但最近的已存在祖先可写 → 不因此 blocked，并注明「尚未创建」", async () => {
  // `${STORAGE}/xhs` 存在且可写，但 `${STORAGE}/xhs/profile` 不存在
  const { deps } = makeDeps({}, {
    existing: [SAU_BINARY, SAU_BASE_DIR, BROWSER, FFMPEG, STORAGE, `${STORAGE}/toutiao`, `${STORAGE}/xhs`],
  });
  const xhs = find(await collectRuntimeStatus(CONFIG, deps), "xiaohongshu");

  assert.notEqual(xhs.state, "blocked", "目录尚未创建不该被判成 blocked（那是假阳性）");
  assert.equal(xhs.state, "degraded", "最终状态仍按总规则：没有 verified 就是 degraded");
  assert.ok(
    xhs.evidence?.notes?.some((note) => note.includes("尚未创建")),
    "必须留下「目录尚未创建」的说明，否则界面无法解释这条判决",
  );
});

test("profile 的祖先目录不可写 → blocked + errno", async () => {
  const { deps } = makeDeps({}, {
    existing: [SAU_BINARY, SAU_BASE_DIR, BROWSER, FFMPEG, STORAGE, `${STORAGE}/toutiao`, `${STORAGE}/xhs`],
    writable: [SAU_BINARY, SAU_BASE_DIR, BROWSER, FFMPEG, STORAGE, `${STORAGE}/toutiao`],
    errno: "EACCES",
  });
  const xhs = find(await collectRuntimeStatus(CONFIG, deps), "xiaohongshu");

  assert.equal(xhs.state, "blocked");
  assert.equal(xhs.evidence?.errno, "EACCES");
});

test("浏览器解析链走完仍未命中 → blocked + 逐层诊断 + 既有指引逐字一致", async () => {
  const { deps } = makeDeps({}, { existing: [SAU_BINARY, SAU_BASE_DIR, FFMPEG, STORAGE] });
  // 不配显式浏览器：让解析链自己走完（显式路径不存在时解析链会直接抛错，见下一条用例）
  const toutiao = find(await collectRuntimeStatus({ ...CONFIG, toutiaoBrowserBinary: undefined }, deps), "toutiao");

  assert.equal(toutiao.state, "blocked");
  assert.equal(toutiao.guidance?.join(""), TOUTIAO_BROWSER_GUIDANCE);
  assert.ok(toutiao.evidence?.attempts?.length, "必须带上解析链的逐层结果");
  assert.ok(toutiao.evidence!.attempts!.every((attempt) => "layer" in attempt && "ok" in attempt));
});

test("显式配置的浏览器不存在 → blocked 且点名那个路径（不静默退到别的浏览器）", async () => {
  const { deps } = makeDeps({}, { existing: [SAU_BINARY, SAU_BASE_DIR, FFMPEG, STORAGE] });
  const toutiao = find(await collectRuntimeStatus(CONFIG, deps), "toutiao");

  assert.equal(toutiao.state, "blocked");
  assert.match(toutiao.detail, /头条号浏览器不存在/u);
  assert.ok(toutiao.guidance?.some((line) => line.includes("TOUTIAO_BROWSER_BINARY")));
});

test("小红书解析不到时用的是小红书自己的指引（不是头条那份）", async () => {
  const { deps } = makeDeps({}, { existing: [SAU_BINARY, SAU_BASE_DIR, FFMPEG, STORAGE] });
  const xhs = find(await collectRuntimeStatus({ ...CONFIG, xhsBrowserBinary: undefined }, deps), "xiaohongshu");

  assert.equal(xhs.guidance?.join(""), XHS_BROWSER_GUIDANCE);
});

test("读不到 verified store 不让整条响应失败：只是「还没有已验证记录」→ degraded", async () => {
  const { deps } = makeDeps({}, {
    existing: [SAU_BINARY, SAU_BASE_DIR, BROWSER, FFMPEG, STORAGE, `${STORAGE}/toutiao`, `${STORAGE}/xhs`],
    unreadable: [`${STORAGE}/cache/runtime-checks.json`],
  });
  const response = await collectRuntimeStatus(CONFIG, deps);

  assert.equal(response.channels.length, 3);
  assert.equal(find(response, "douyin").state, "degraded", "读不到 store 只是「没有已验证记录」");
});

test("免费检查自身抛错 → unknown（如实说「不知道」，不编结论）", async () => {
  const { deps } = makeDeps({
    cookie: {
      path: COOKIE,
      hasCookie: () => {
        throw Object.assign(new Error("EIO: 读取凭据文件失败"), { code: "EIO" });
      },
      hasAuthCookie: () => false,
    },
  });
  const douyin = find(await collectRuntimeStatus(CONFIG, deps), "douyin");

  assert.equal(douyin.state, "unknown");
  assert.match(douyin.detail, /没能完成/u);
  assert.equal(douyin.verified, undefined);
});

test("⚠️ INV-3：整个过程不写任何东西，且只跑只读探测命令", async () => {
  const { deps, fsCalls, probeCalls } = makeDeps();
  await collectRuntimeStatus(CONFIG, deps);

  // 端口只暴露读能力，所以"没写"是结构保证；这里再验一遍调用面
  assert.ok(fsCalls.access.length > 0, "应当探测过路径");
  assert.ok(
    fsCalls.access.every((call) => call.mode === undefined || call.mode === W_OK),
    "access 只允许 F_OK / W_OK 两种只读探测",
  );
  assert.equal(probeCalls.length, 1, "只允许一次 ffmpeg 探测");
  assert.deepEqual(probeCalls[0].args, ["-version"]);
  assert.equal(probeCalls[0].command, FFMPEG);
});

test("verified 是唯一谈有效性的地方：有效且未过期 → ready，超过 TTL → degraded，失效 → blocked", async () => {
  const build = (state: "valid" | "invalid", at: Date) =>
    makeDeps({ verified: () => ({ state, at: at.toISOString() }) });

  const fresh = build("valid", new Date(NOW.getTime() - 60_000));
  assert.equal(find(await collectRuntimeStatus(CONFIG, fresh.deps), "douyin").state, "ready");

  const stale = build("valid", new Date(NOW.getTime() - RUNTIME_VERIFIED_TTL_MS - 1000));
  const staleItem = find(await collectRuntimeStatus(CONFIG, stale.deps), "douyin");
  assert.equal(staleItem.state, "degraded");
  assert.equal(staleItem.verified?.state, "valid", "过期只是降级，记录本身照实下发");

  const invalid = build("invalid", new Date(NOW.getTime() - 60_000));
  const invalidItem = find(await collectRuntimeStatus(CONFIG, invalid.deps), "douyin");
  assert.equal(invalidItem.state, "blocked");
  assert.deepEqual(invalidItem.action, { kind: "login", target: "douyin" });
});

test("ready 只可能来自 verified：全配置齐备且凭据存在也不足以变绿", async () => {
  const { deps } = makeDeps();
  const response = await collectRuntimeStatus(CONFIG, deps);

  for (const item of response.channels) {
    assert.notEqual(item.state, "ready", `${item.id} 没有 verified 却给了 ready`);
  }
});
