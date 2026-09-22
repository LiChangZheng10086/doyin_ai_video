/**
 * 运行环境的**深检**任务（会开浏览器的那一层）。
 *
 * 设计规格 §3.3 / §5 / §6.2；实施计划 Task 2。
 *
 * 为什么深检必须是后台任务而不是同步请求：抖音的 `sau douyin check` **最坏 5 分钟**
 * （`CHECK_TIMEOUT_MS`，上游每次 goto 超时 90s × 最多 3 次），同步等会把界面卡死、
 * 也让用户切走就丢结果。所以 `start()` 立刻返回 `running`，前端按 3 秒轮询（与
 * `QrLoginPanel` 同一套形状）。
 *
 * 两条互斥纪律（都对应真实的破坏，不是洁癖）：
 * - **INV-4a** 深检之间**全局单飞**：同时开多个浏览器既重又没必要。
 * - **INV-4b** 深检 ↔ 发布**按渠道**互斥：两者**共用同一个浏览器 profile 目录**
 *   （`xhs-runner.ts:728` / `toutiao-runner.ts:654`），同时跑会互相破坏；
 *   但**跨渠道不互斥** —— 抖音深检不该挡住头条发布。
 *
 * 另外两条与"如实"有关：
 * - 超时 / 探测抛错 / 说不准，一律收敛成 **`failed` 并且带上该渠道的指引**（INV-6）。
 *   超时是「没验成」，**不是**「失效」—— 绝不能顺手写 `verified: invalid`（那会变成
 *   最长 7 天的假红灯）。
 * - 取消后**晚到的判定一律丢弃**：既不覆盖 `cancelled`，也不写 `verified`。
 */

import { randomUUID } from "node:crypto";
import type { LocalStorage } from "./storage.js";
import {
  RUNTIME_CHECKS_RELATIVE_PATH,
  RUNTIME_CHANNEL_LABELS,
  readVerifiedRecordsFrom,
  type RuntimeChannelId,
  type RuntimeCheckSummary,
  type RuntimeVerifiedRecord,
} from "./runtime-status.js";

/** 头条 / 小红书的深检上限（runner 里**没有** verify 专属超时，不能借用登录超时）。 */
export const RUNTIME_CHECK_TIMEOUT_MS = 120_000;

/**
 * 僵死阈值：超过它仍停在 `running` 的记录视为「进程已死」，允许重新检测。
 *
 * 取值**必须大于最大深检超时**（抖音 `CHECK_TIMEOUT_MS = 300_000`），否则会误判活着的
 * 进程 —— 与 `AUTO_PUBLISH_STALE_MS` 是同一条推理。
 */
export const RUNTIME_CHECK_STALE_MS = 10 * 60_000;

export class RuntimeCheckError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 失败时必须一并给操作者可照抄的动作（INV-6）。 */
    readonly guidance?: string[],
  ) {
    super(message);
    this.name = "RuntimeCheckError";
  }
}

export type RuntimeCheckStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface RuntimeCheckRecord {
  checkId: string;
  id: RuntimeChannelId;
  status: RuntimeCheckStatus;
  startedAt: string;
  finishedAt?: string;
  detail: string;
  guidance?: string[];
  /** 结论为 valid / invalid 时同步写进 `verified` 段（INV-2 ①）。 */
  verdict?: "valid" | "invalid";
}

export interface RuntimeCheckProbeResult {
  /**
   * `valid` / `invalid` 是**结论**；`inconclusive` 是「看不出」——
   * 后者既不写 `verified`，也不假装成功。
   */
  verdict: "valid" | "invalid" | "inconclusive";
  detail: string;
}

export interface RuntimeChannelProbe {
  /** 外层兜底超时（探测自身也有超时，这是第二道）。 */
  timeoutMs: number;
  /** 该渠道的可照抄指引：超时 / 失败时原样带上。 */
  guidance: string[];
  /** 返回判定。**允许抛**（抛 = 没验成，由本模块收敛成 `failed`）。 */
  check(): Promise<RuntimeCheckProbeResult>;
}

export interface RuntimeChecksStore {
  read(): Promise<{ verified: Record<string, RuntimeVerifiedRecord>; check: RuntimeCheckRecord | null }>;
  write(value: { verified: Record<string, RuntimeVerifiedRecord>; check: RuntimeCheckRecord | null }): Promise<void>;
}

export interface RuntimeChecksDependencies {
  store: RuntimeChecksStore;
  probes: Partial<Record<RuntimeChannelId, RuntimeChannelProbe>>;
  now?(): Date;
  createId?(): string;
  /** 该渠道此刻是否有发布在跑（互斥的另一个方向，spec §5.2 规则 1）。 */
  publishBusy?(id: RuntimeChannelId): boolean | Promise<boolean>;
}

export class RuntimeChecks {
  private inflight: Promise<void> | null = null;

  constructor(private readonly deps: RuntimeChecksDependencies) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** 当前或最近一次深检的摘要；没有记录时返回 `null`（不伪造一条空任务）。 */
  async status(): Promise<RuntimeCheckSummary | null> {
    const { check } = await this.deps.store.read();
    if (!check) return null;
    return toSummary(this.normalizeStale(check), this.now());
  }

  /**
   * 该渠道是否正被深检占用。
   *
   * ⚠️ **按渠道**问这个问题（INV-4b）：发布侧的互斥闸就用它，跨渠道必须答 `false`。
   */
  async isRunning(id: RuntimeChannelId): Promise<boolean> {
    const { check } = await this.deps.store.read();
    if (!check) return false;
    const normalized = this.normalizeStale(check);
    return normalized.status === "running" && normalized.id === id;
  }

  /** 等当前任务收尾（路由的取消路径与用例都需要）。 */
  async settle(): Promise<void> {
    await this.inflight;
    this.inflight = null;
  }

  async start(id: RuntimeChannelId): Promise<RuntimeCheckSummary> {
    const now = this.now();
    const { check, verified } = await this.deps.store.read();
    const current = check ? this.normalizeStale(check) : null;

    if (current?.status === "running") {
      throw new RuntimeCheckError(
        409,
        "runtime_check_in_progress",
        `正在检测「${RUNTIME_CHANNEL_LABELS[current.id]}」的登录态。全局同时只允许一个检测（通常 10–30 秒，最坏 5 分钟）。`,
        this.probeOf(current.id)?.guidance,
      );
    }

    const probe = this.probeOf(id);
    if (!probe) {
      throw new RuntimeCheckError(422, "runtime_check_unsupported", `「${RUNTIME_CHANNEL_LABELS[id]}」没有可用的深检通路。`);
    }

    if (await this.deps.publishBusy?.(id)) {
      throw new RuntimeCheckError(
        409,
        "runtime_check_blocked_by_publish",
        `「${RUNTIME_CHANNEL_LABELS[id]}」正在发布，检测会与它抢同一个会话目录。请等发布结束后再检测。`,
        probe.guidance,
      );
    }

    const record: RuntimeCheckRecord = {
      checkId: this.deps.createId?.() ?? randomUUID(),
      id,
      status: "running",
      startedAt: now.toISOString(),
      detail: "检测中。",
    };
    await this.deps.store.write({ verified, check: record });

    const summary = toSummary(record, now);
    this.inflight = this.run(record, verified).finally(() => {
      this.inflight = null;
    });
    return summary;
  }

  /**
   * 回写一条登录判据。
   *
   * 供**发布链路与登录动作**调用（INV-2 ②③④⑤）：那些路径里已经产生了判定，顺手记下来
   * 就有了「发一次 = 验一次」。与深检**共用同一个 store 与同一份文件格式**，但**不动
   * `check` 段** —— 那是深检任务的记录，不该被一次发布擦掉。
   */
  async recordVerified(id: RuntimeChannelId, state: "valid" | "invalid"): Promise<void> {
    const { verified, check } = await this.deps.store.read();
    await this.deps.store.write({
      verified: { ...verified, [id]: { state, at: this.now().toISOString() } },
      check,
    });
  }

  async cancel(checkId: string): Promise<RuntimeCheckSummary> {
    const now = this.now();
    const { check, verified } = await this.deps.store.read();
    if (!check || check.checkId !== checkId || check.status !== "running") {
      throw new RuntimeCheckError(409, "runtime_check_not_running", "这次检测已经结束了，无需取消。");
    }

    const record: RuntimeCheckRecord = {
      ...check,
      status: "cancelled",
      finishedAt: now.toISOString(),
      /*
       * ⚠️ 我们**杀不掉已经开出去的浏览器**（runner 的 `checkLogin()` 没有中止接口），
       * 所以不许假装干净：如实说明可能需要重新验证一次。
       */
      detail: "检测已取消。强杀浏览器可能留下会话锁，如需确认登录态，请稍后重新验证一次。",
      guidance: this.probeOf(check.id)?.guidance,
    };
    await this.deps.store.write({ verified, check: record });
    return toSummary(record, now);
  }

  /* ──────────────────────────── 后台任务 ──────────────────────────── */

  private async run(record: RuntimeCheckRecord, verifiedAtStart: Record<string, RuntimeVerifiedRecord>): Promise<void> {
    const probe = this.probeOf(record.id);
    if (!probe) return;

    let outcome: RuntimeCheckRecord;
    try {
      const result = await withTimeout(probe.check(), probe.timeoutMs);
      if (result.verdict === "inconclusive") {
        // 「说不准」不是失败于执行，而是**没有结论** —— 一样不许写 verified（INV-2）
        outcome = { ...record, status: "failed", detail: `没能判定登录态：${result.detail}`, guidance: probe.guidance };
      } else {
        outcome = {
          ...record,
          status: "succeeded",
          detail: result.detail,
          verdict: result.verdict,
          guidance: probe.guidance,
        };
      }
    } catch (error) {
      const timedOut = error instanceof RuntimeCheckTimeout;
      outcome = {
        ...record,
        status: "failed",
        detail: timedOut
          ? `检测超时（${Math.round(probe.timeoutMs / 1000)} 秒）。`
          : `检测没能完成：${describeError(error)}`,
        guidance: probe.guidance,
      };
    }
    outcome.finishedAt = this.now().toISOString();

    // 落盘前**重新读一次**：用户可能已经取消，或者有新的检测接上了 —— 晚到的结果一律丢弃
    const latest = await this.deps.store.read();
    if (!latest.check || latest.check.checkId !== record.checkId || latest.check.status !== "running") return;

    const verified = { ...verifiedAtStart };
    if (outcome.verdict) verified[record.id] = { state: outcome.verdict, at: outcome.finishedAt };
    await this.deps.store.write({ verified, check: outcome });
  }

  private probeOf(id: RuntimeChannelId): RuntimeChannelProbe | undefined {
    return this.deps.probes[id];
  }

  /**
   * 僵死记录规范化。
   *
   * 只有**读**才判僵死（不在读路径上写盘），因此 `status()` 是零副作用的。
   */
  private normalizeStale(record: RuntimeCheckRecord): RuntimeCheckRecord {
    if (record.status !== "running") return record;
    const startedAt = Date.parse(record.startedAt);
    if (!Number.isFinite(startedAt)) return record;
    if (this.now().getTime() - startedAt <= RUNTIME_CHECK_STALE_MS) return record;
    return {
      ...record,
      status: "failed",
      finishedAt: new Date(startedAt + RUNTIME_CHECK_STALE_MS).toISOString(),
      detail: "上一次检测没有正常结束（进程可能已被杀），已视为中断，可以重新检测。",
      guidance: this.probeOf(record.id)?.guidance,
    };
  }
}

/* ──────────────────────────── 文件存档 ──────────────────────────── */

/**
 * 把深检结论与任务状态存进 `<storage>/cache/runtime-checks.json`。
 *
 * 免费层（`runtime-status.ts`）只读它的 `verified` 段，且**共用同一个解析函数** ——
 * 文件格式的真源只有一处。
 */
export function createFileRuntimeChecksStore(storage: LocalStorage): RuntimeChecksStore {
  return {
    async read() {
      try {
        const parsed: unknown = await storage.readJson(RUNTIME_CHECKS_RELATIVE_PATH);
        return { verified: readVerifiedRecordsFrom(parsed), check: readCheckRecord(parsed) };
      } catch {
        // 文件不存在 / 损坏都只是「还没有记录」，不是错误
        return { verified: {}, check: null };
      }
    },
    async write(value) {
      await storage.writeJsonAtomic(RUNTIME_CHECKS_RELATIVE_PATH, {
        version: 1,
        verified: value.verified,
        check: value.check,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}

function readCheckRecord(value: unknown): RuntimeCheckRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const check = (value as { check?: unknown }).check;
  if (typeof check !== "object" || check === null) return null;
  const candidate = check as Record<string, unknown>;
  const statuses: RuntimeCheckStatus[] = ["running", "succeeded", "failed", "cancelled"];
  const status = candidate.status as RuntimeCheckStatus;
  if (typeof candidate.checkId !== "string" || typeof candidate.id !== "string") return null;
  if (!statuses.includes(status) || typeof candidate.startedAt !== "string" || typeof candidate.detail !== "string") {
    return null;
  }
  return {
    checkId: candidate.checkId,
    id: candidate.id as RuntimeChannelId,
    status,
    startedAt: candidate.startedAt,
    ...(typeof candidate.finishedAt === "string" ? { finishedAt: candidate.finishedAt } : {}),
    detail: candidate.detail,
    ...(Array.isArray(candidate.guidance) ? { guidance: candidate.guidance.filter((line): line is string => typeof line === "string") } : {}),
    ...(candidate.verdict === "valid" || candidate.verdict === "invalid" ? { verdict: candidate.verdict } : {}),
  };
}

/* ──────────────────────────── 小工具 ──────────────────────────── */

class RuntimeCheckTimeout extends Error {
  constructor() {
    super("runtime check timeout");
    this.name = "RuntimeCheckTimeout";
  }
}

/**
 * 外层兜底超时。
 *
 * ⚠️ 超时**不会**终止底层探测（runner 没有中止接口）：它会自己跑完并在自己的
 * `finally` 里关掉浏览器。我们只是不再等它 —— 这也是取消路径那句「可能留下会话锁」
 * 的由来。
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RuntimeCheckTimeout()), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toSummary(record: RuntimeCheckRecord, now: Date): RuntimeCheckSummary {
  const startedAt = Date.parse(record.startedAt);
  const finishedAt = record.finishedAt ? Date.parse(record.finishedAt) : Number.NaN;
  const end = Number.isFinite(finishedAt) ? finishedAt : now.getTime();
  return {
    checkId: record.checkId,
    id: record.id,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    // 已运行毫秒数**服务端算**，前端不自己拿时钟做差
    elapsedMs: Number.isFinite(startedAt) ? Math.max(0, end - startedAt) : 0,
    detail: record.detail,
    ...(record.guidance ? { guidance: record.guidance } : {}),
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
