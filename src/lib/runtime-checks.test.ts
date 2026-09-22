import assert from "node:assert/strict";
import test from "node:test";
import { CHECK_TIMEOUT_MS } from "./sau-runner.js";
import type { RuntimeChannelId, RuntimeVerifiedRecord } from "./runtime-status.js";
import {
  RUNTIME_CHECK_STALE_MS,
  RUNTIME_CHECK_TIMEOUT_MS,
  RuntimeCheckError,
  RuntimeChecks,
  type RuntimeCheckRecord,
  type RuntimeChecksStore,
} from "./runtime-checks.js";

/**
 * 深检任务的门禁。
 *
 * 这一层只有两条硬纪律，但两条都对应真实的破坏：
 * - **全局单飞**（INV-4a）：同时开多个浏览器既重又没必要。
 * - **按渠道与发布互斥**（INV-4b）：深检与发布**共用同一个浏览器 profile 目录**，
 *   同时跑会互相破坏。但**跨渠道不互斥** —— 抖音深检不该挡住头条发布。
 */

const NOW = new Date("2026-09-22T02:00:00.000Z");

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 可以手动控制的判定结果 —— 用例要观测「running 期间」的状态，所以不能立刻结束。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  checks: RuntimeChecks;
  store: MemoryStore;
  clock: { now: Date };
  probes: Record<RuntimeChannelId, ReturnType<typeof makeProbe>>;
  publishBusy: Set<RuntimeChannelId>;
}

function makeProbe(guidance: string[] = ["照抄这一条"]) {
  const gate = deferred<{ verdict: "valid" | "invalid" | "inconclusive"; detail: string }>();
  return {
    timeoutMs: RUNTIME_CHECK_TIMEOUT_MS,
    guidance,
    check: () => gate.promise,
    settle: gate.resolve,
    fail: gate.reject,
  };
}

class MemoryStore implements RuntimeChecksStore {
  verified: Record<string, RuntimeVerifiedRecord> = {};
  check: RuntimeCheckRecord | null = null;
  writes = 0;
  async read() {
    return { verified: { ...this.verified }, check: this.check };
  }
  async write(value: { verified: Record<string, RuntimeVerifiedRecord>; check: RuntimeCheckRecord | null }) {
    this.writes += 1;
    this.verified = { ...value.verified };
    this.check = value.check;
  }
}

function makeHarness(): Harness {
  const store = new MemoryStore();
  const clock = { now: new Date(NOW) };
  const publishBusy = new Set<RuntimeChannelId>();
  const probes = {
    douyin: makeProbe(["sau 指引"]),
    toutiao: makeProbe(["头条指引"]),
    xiaohongshu: makeProbe(["小红书指引"]),
  };
  const checks = new RuntimeChecks({
    now: () => new Date(clock.now),
    createId: () => `check-${Math.random().toString(36).slice(2, 8)}`,
    store,
    probes,
    publishBusy: (id) => publishBusy.has(id),
  });
  return { checks, store, clock, probes, publishBusy };
}

test("⚠️ INV-4a：深检全局单飞 —— 任一渠道在跑时，再发起任何渠道都 409", async () => {
  const h = makeHarness();
  const running = await h.checks.start("douyin");
  assert.equal(running.status, "running");
  assert.equal(running.elapsedMs, 0);

  for (const id of ["douyin", "toutiao", "xiaohongshu"] as const) {
    await assert.rejects(
      () => h.checks.start(id),
      (error: unknown) => error instanceof RuntimeCheckError && error.status === 409 && error.code === "runtime_check_in_progress",
      `${id} 在别的渠道检测中时也必须被挡`,
    );
  }

  h.probes.douyin.settle({ verdict: "valid", detail: "ok" });
  await h.checks.settle();
});

test("⚠️ INV-4b：互斥按渠道 —— 抖音深检进行中，头条不受影响", async () => {
  const h = makeHarness();
  await h.checks.start("douyin");

  assert.equal(await h.checks.isRunning("douyin"), true);
  assert.equal(await h.checks.isRunning("toutiao"), false, "抖音深检不该挡住头条（它俩不碰同一个 profile）");
  assert.equal(await h.checks.isRunning("xiaohongshu"), false);

  h.probes.douyin.settle({ verdict: "inconclusive", detail: "看不出" });
  await h.checks.settle();
});

test("该渠道有发布在跑 → 该渠道深检 409；别的渠道不受影响", async () => {
  const h = makeHarness();
  h.publishBusy.add("toutiao");

  await assert.rejects(
    () => h.checks.start("toutiao"),
    (error: unknown) => error instanceof RuntimeCheckError && error.status === 409 && error.code === "runtime_check_blocked_by_publish",
  );

  const other = await h.checks.start("xiaohongshu");
  assert.equal(other.status, "running");
  h.probes.xiaohongshu.settle({ verdict: "inconclusive", detail: "看不出" });
  await h.checks.settle();
});

test("判定有效 → succeeded 且写进 verified；说不准 → failed 且**不写** verified（INV-2）", async () => {
  const h = makeHarness();
  await h.checks.start("douyin");
  h.probes.douyin.settle({ verdict: "valid", detail: "登录态有效" });
  await h.checks.settle();

  assert.deepEqual(h.store.verified.douyin, { state: "valid", at: NOW.toISOString() });
  const done = await h.checks.status();
  assert.equal(done?.status, "succeeded");

  await h.checks.start("toutiao");
  h.probes.toutiao.settle({ verdict: "inconclusive", detail: "页面既不像登录页也不像发布页" });
  await h.checks.settle();

  assert.equal(h.store.verified.toutiao, undefined, "说不准时不许写 verified（不许猜）");
  const inconclusive = await h.checks.status();
  assert.equal(inconclusive?.status, "failed");
  assert.ok(inconclusive?.guidance?.length, "失败必须带可照抄的指引（INV-6）");
});

test("判定失效 → 写 verified=invalid（这样界面才敢把它标成红灯）", async () => {
  const h = makeHarness();
  await h.checks.start("xiaohongshu");
  h.probes.xiaohongshu.settle({ verdict: "invalid", detail: "被踢到登录页" });
  await h.checks.settle();

  assert.deepEqual(h.store.verified.xiaohongshu, { state: "invalid", at: NOW.toISOString() });
});

test("⚠️ INV-6：超时 → failed，且必须带上该渠道的指引", async () => {
  const h = makeHarness();
  h.probes.douyin.timeoutMs = 10;
  await h.checks.start("douyin");
  await h.checks.settle(); // 探测永远不 settle → 走到超时分支

  const summary = await h.checks.status();
  assert.equal(summary?.status, "failed");
  assert.match(summary!.detail, /超时/u);
  assert.deepEqual(summary!.guidance, ["sau 指引"]);
  assert.equal(h.store.verified.douyin, undefined, "超时是「没验成」，不是「失效」");
});

test("探测抛错 → failed（收敛成记录，绝不把任务留在 running）", async () => {
  const h = makeHarness();
  await h.checks.start("toutiao");
  h.probes.toutiao.fail(new Error("浏览器起不来"));
  await h.checks.settle();

  const summary = await h.checks.status();
  assert.equal(summary?.status, "failed");
  assert.match(summary!.detail, /浏览器起不来/u);
  assert.deepEqual(summary!.guidance, ["头条指引"]);
});

test("取消 → cancelled（**不是** failed），并如实提示可能要重新验证一次", async () => {
  const h = makeHarness();
  const started = await h.checks.start("douyin");

  const cancelled = await h.checks.cancel(started.checkId);
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.detail, /重新验证/u);
  assert.match(cancelled.detail, /会话锁|profile|浏览器/u);

  // 晚到的判定**不许覆盖**取消这件事
  h.probes.douyin.settle({ verdict: "valid", detail: "迟到的有效" });
  await h.checks.settle();
  const after = await h.checks.status();
  assert.equal(after?.status, "cancelled");
  assert.equal(h.store.verified.douyin, undefined, "已取消的检测不该顺手写 verified");
});

test("取消一个不认识/已结束的 checkId → 409", async () => {
  const h = makeHarness();
  await assert.rejects(
    () => h.checks.cancel("check-nope"),
    (error: unknown) => error instanceof RuntimeCheckError && error.status === 409,
  );
});

test("僵死恢复：残留的 running 超过阈值即视为中断，可重新发起；阈值必须 > 抖音自检超时", async () => {
  const h = makeHarness();
  h.store.check = {
    checkId: "check-dead",
    id: "douyin",
    status: "running",
    startedAt: new Date(NOW.getTime() - RUNTIME_CHECK_STALE_MS - 1000).toISOString(),
    detail: "检测中。",
  };

  assert.equal(await h.checks.isRunning("douyin"), false, "僵死的记录不该永久锁死这个渠道");
  const summary = await h.checks.status();
  assert.equal(summary?.status, "failed");
  assert.match(summary!.detail, /中断/u);

  const restarted = await h.checks.start("douyin");
  assert.equal(restarted.status, "running");
  h.probes.douyin.settle({ verdict: "inconclusive", detail: "看不出" });
  await h.checks.settle();

  // 阈值必须大于抖音自检自己的超时，否则会误判活着的进程（照抄 AUTO_PUBLISH_STALE_MS 的推理）
  assert.ok(
    RUNTIME_CHECK_STALE_MS > CHECK_TIMEOUT_MS,
    `僵死阈值 ${RUNTIME_CHECK_STALE_MS} 必须大于抖音自检超时 ${CHECK_TIMEOUT_MS}`,
  );
});

test("阈值内的 running 仍然算在跑（别把活着的进程判死）", async () => {
  const h = makeHarness();
  h.store.check = {
    checkId: "check-alive",
    id: "toutiao",
    status: "running",
    startedAt: new Date(NOW.getTime() - 5_000).toISOString(),
    detail: "检测中。",
  };
  assert.equal(await h.checks.isRunning("toutiao"), true);
  await assert.rejects(() => h.checks.start("xiaohongshu"), /./u);
});

test("没注入探测器的渠道 → 422（明确说「这个渠道没有深检」，而不是 500）", async () => {
  const store = new MemoryStore();
  const checks = new RuntimeChecks({ store, probes: {}, now: () => new Date(NOW) });
  await assert.rejects(
    () => checks.start("douyin"),
    (error: unknown) => error instanceof RuntimeCheckError && error.status === 422 && error.code === "runtime_check_unsupported",
  );
});

test("status() 在没有记录时返回 null（不是伪造一条空任务）", async () => {
  const h = makeHarness();
  assert.equal(await h.checks.status(), null);
});

test("每个写动作都落盘一次（轮询端读到的是持久化状态，不是内存里的影子）", async () => {
  const h = makeHarness();
  const before = h.store.writes;
  await h.checks.start("toutiao");
  assert.ok(h.store.writes > before, "start 必须落盘 —— 否则重启后僵死恢复无从判断");
  h.probes.toutiao.settle({ verdict: "valid", detail: "ok" });
  await h.checks.settle();
  assert.ok(h.store.writes >= before + 2, "完成也要落盘");
});
