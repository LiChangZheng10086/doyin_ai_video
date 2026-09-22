/**
 * 运行环境状态一览（渠道 / 引擎）的服务端聚合。
 *
 * 设计规格：`docs/superpowers/specs/2026-09-22-runtime-status-panel-design.md`
 * 实施计划：`docs/superpowers/plans/2026-09-22-runtime-status-panel.md`（Task 1）
 *
 * 三条不可动摇的纪律：
 * - **INV-1** 免费层**永不下发有效性语义**。「已登录 / 登录态有效」只能来自 `verified`
 *   （深检或发布链路留下的**带时间戳**记录）；免费层最多说「凭据已存在，有效性未知」。
 * - **INV-3** 免费层**不改变任何状态**：不开浏览器、不写文件、不触碰平台。端口 `fs`
 *   故意**只有读能力**，所以「没写」是结构保证，而不是靠用例去断言「应该没写」。
 * - **INV-7** 四态判定**只有这一处**。界面只读 `state`，绝不自己复算红灯。
 *
 * 顺带一条容易踩的：**渠道只有在「真的验证过且没过期」时才可能是 `ready`**。
 * 配置齐备、凭据存在都不够 —— 那只能得到 `degraded`（见 `resolveChannelState`）。
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command.js";
import { getCookiePath, hasAuthCookie, hasCookie } from "./douyin-cookie.js";
import { ffmpegProbeCommand } from "./media.js";
import { SAU_INSTALL_GUIDANCE_LINES } from "./sau-runner.js";
import {
  TOUTIAO_BROWSER_GUIDANCE_LINES,
  ToutiaoBrowserError,
  filesystemBrowserProbe,
  resolveToutiaoBrowser,
  resolveToutiaoProfileDir,
  type ToutiaoBrowserAttempt,
  type ToutiaoBrowserProbe,
} from "./toutiao-browser.js";
import {
  XHS_BROWSER_GUIDANCE_LINES,
  XhsBrowserError,
  resolveXhsBrowser,
  resolveXhsProfileDir,
  type XhsBrowserAttempt as XhsBrowserAttemptType,
} from "./xhs-browser.js";

export type RuntimeItemId = "douyin" | "toutiao" | "xiaohongshu" | "ffmpeg" | "storage";
export type RuntimeChannelId = Extract<RuntimeItemId, "douyin" | "toutiao" | "xiaohongshu">;

/**
 * 只有四个状态。**刻意不含 "valid"** —— 有效性属于 `verified` 字段，
 * 混进 `state` 就会让「配置就绪」被误读成「服务端认这个登录态」。
 */
export type RuntimeState = "ready" | "degraded" | "blocked" | "unknown";

export type RuntimeVerifiedState = "valid" | "invalid";

/** 一条**带时间戳**的登录态结论。唯一有资格谈有效性的东西。 */
export interface RuntimeVerifiedRecord {
  state: RuntimeVerifiedState;
  /** ISO 时间戳：结论是在**那个时刻**成立的。 */
  at: string;
}

export interface RuntimeEvidence {
  paths?: Array<{ label: string; value: string }>;
  attempts?: Array<{ layer: string; ok: boolean; detail: string }>;
  errno?: string;
  /** 补充说明（如「目录尚未创建（首次使用时创建）」）。界面据此解释判决。 */
  notes?: string[];
}

export interface RuntimeItem {
  id: RuntimeItemId;
  label: string;
  state: RuntimeState;
  detail: string;
  evidence?: RuntimeEvidence;
  /** 可照抄的动作；内容直接取自既有的 `*_GUIDANCE_LINES`，不另写一份。 */
  guidance?: string[];
  action?: { kind: "login"; target: RuntimeChannelId };
  verified?: RuntimeVerifiedRecord;
}

/** 深检任务摘要（Task 2 才产出；Task 1 恒为 `null`，但字段必须先存在于契约里）。 */
export interface RuntimeCheckSummary {
  checkId: string;
  id: RuntimeItemId;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  /** 已运行毫秒数 —— **服务端算**，前端不自己拿时钟做差。 */
  elapsedMs?: number;
  detail: string;
  guidance?: string[];
}

export interface RuntimeStatusResponse {
  checkedAt: string;
  channels: RuntimeItem[];
  dependencies: RuntimeItem[];
  check: RuntimeCheckSummary | null;
  buildTag?: {
    backend?: { path: string; mtime: string };
    electron?: { path: string; mtime: string };
  };
}

/**
 * 注入端口。
 *
 * ⚠️ `fs` **没有写方法**，这不是疏漏：把写能力从接口上拿掉，INV-3 就成了类型层面的
 * 保证。将来若要加写操作（例如「一键修复」），必须同时改这里与本文件顶部的纪律说明。
 */
export interface RuntimeStatusDeps {
  fs: {
    access(target: string, mode?: number): Promise<void>;
    readFile(target: string, encoding: "utf8"): Promise<string>;
  };
  probe: {
    runCommand(command: string, args: string[], options?: Record<string, unknown>): Promise<{ stdout: string; stderr: string }>;
  };
  /** 与头条/小红书解析链共用的文件系统探测点（形状一致，复用同一个）。 */
  browserProbe: ToutiaoBrowserProbe;
  /** 抖音凭据文件端口：把 `douyin-cookie.ts` 的三条规则接进来，而不是在这儿重写一遍解析。 */
  cookie: { path: string; hasCookie(): boolean; hasAuthCookie(): boolean };
  now(): Date;
  /** 已验证记录读取端口。缺省从 `cache/runtime-checks.json` 读（见 `loadVerifiedRecords`）。 */
  verified?: (id: RuntimeItemId) => RuntimeVerifiedRecord | undefined;
}

export interface RuntimeStatusConfig {
  storageRoot: string;
  /** 抖音：sau 的两个配置项（env `SAU_BINARY` / `SAU_BASE_DIR`）。 */
  sauBinary?: string;
  sauBaseDir?: string;
  toutiaoBrowserBinary?: string;
  toutiaoProfileDir?: string;
  xhsBrowserBinary?: string;
  xhsProfileDir?: string;
  ffmpegBinary?: string;
  repoRoot?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** 已验证结论的有效期：超过它就回落到 `degraded`，绿点才有含金量。 */
export const RUNTIME_VERIFIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const VERIFIED_STORE_PATH = ["cache", "runtime-checks.json"] as const;
const W_OK = 2;

/* ──────────────────────────── 生产端口绑定 ──────────────────────────── */

/**
 * 生产环境的端口绑定。测试永远注入自己的假对象，**不会**走到这里。
 *
 * 浏览器探测点刻意复用解析链自己那一份（`filesystemBrowserProbe`）：状态页与解析链
 * 必须对「同一件事」给出同样的答案。
 */
export function createDefaultRuntimeStatusDeps(): RuntimeStatusDeps {
  return {
    fs: {
      access: (target, mode) => (mode === undefined ? access(target) : access(target, mode)),
      readFile: (target, encoding) => readFile(target, encoding),
    },
    probe: {
      runCommand: (command, args, options) =>
        runCommand(command, args, options as Parameters<typeof runCommand>[2]),
    },
    browserProbe: filesystemBrowserProbe,
    cookie: { path: getCookiePath(), hasCookie, hasAuthCookie },
    now: () => new Date(),
  };
}

/* ──────────────────────────── 聚合入口 ──────────────────────────── */

export async function collectRuntimeStatus(
  config: RuntimeStatusConfig,
  deps: RuntimeStatusDeps,
): Promise<RuntimeStatusResponse> {
  const now = deps.now();
  const records = deps.verified ? undefined : await loadVerifiedRecords(config, deps);
  const verifiedOf = (id: RuntimeItemId): RuntimeVerifiedRecord | undefined =>
    deps.verified ? deps.verified(id) : records?.[id];

  const channels = await Promise.all([
    guard("douyin", () => checkDouyin(config, deps, verifiedOf, now)),
    guard("toutiao", () =>
      checkBrowserChannel("toutiao", config, deps, verifiedOf, now, {
        label: "今日头条",
        resolve: (probe) =>
          resolveToutiaoBrowser({
            browserBinary: config.toutiaoBrowserBinary,
            repoRoot: config.repoRoot,
            platform: config.platform,
            env: config.env,
            probe,
          }),
        profileDir: () => resolveToutiaoProfileDir(config.storageRoot, config.toutiaoProfileDir),
        guidance: TOUTIAO_BROWSER_GUIDANCE_LINES,
        browserHint: "头条号浏览器",
        emptyChainDetail: "没有可用的浏览器，头条号发布无法进行。",
      }),
    ),
    guard("xiaohongshu", () =>
      checkBrowserChannel("xiaohongshu", config, deps, verifiedOf, now, {
        label: "小红书",
        resolve: (probe) =>
          resolveXhsBrowser({
            browserBinary: config.xhsBrowserBinary,
            repoRoot: config.repoRoot,
            platform: config.platform,
            env: config.env,
            probe,
          }),
        profileDir: () => resolveXhsProfileDir(config.storageRoot, config.xhsProfileDir),
        guidance: XHS_BROWSER_GUIDANCE_LINES,
        browserHint: "小红书浏览器",
        emptyChainDetail: "没有可用的浏览器，小红书发布无法进行。",
      }),
    ),
  ]);

  const dependencies = await Promise.all([
    guard("ffmpeg", () => checkFfmpeg(config, deps)),
    guard("storage", () => checkStorage(config, deps)),
  ]);

  return {
    checkedAt: now.toISOString(),
    channels,
    dependencies,
    check: null,
  };
}

/**
 * 把「检查本身炸了」收敛成 `unknown`。
 *
 * 各检查函数内部已经把**预期**的失败（未配置、路径不存在、不可写）变成 `blocked`，
 * 所以走到这里的都是意外 —— 此时**不许编结论**，如实说「不知道」。
 */
async function guard(id: RuntimeItemId, run: () => Promise<RuntimeItem>): Promise<RuntimeItem> {
  try {
    return await run();
  } catch (error) {
    return {
      id,
      label: LABELS[id],
      state: "unknown",
      detail: `这项检查没能完成：${describeError(error)}`,
    };
  }
}

const LABELS: Record<RuntimeItemId, string> = {
  douyin: "抖音",
  toutiao: "今日头条",
  xiaohongshu: "小红书",
  ffmpeg: "ffmpeg",
  storage: "存储目录",
};

/* ──────────────────────────── 抖音 ──────────────────────────── */

async function checkDouyin(
  config: RuntimeStatusConfig,
  deps: RuntimeStatusDeps,
  verifiedOf: (id: RuntimeItemId) => RuntimeVerifiedRecord | undefined,
  now: Date,
): Promise<RuntimeItem> {
  const base = { id: "douyin" as const, label: LABELS.douyin, action: { kind: "login" as const, target: "douyin" as const } };
  const paths = [
    { label: "sau 可执行文件", value: config.sauBinary ?? "（未配置）" },
    { label: "sau 仓库根目录", value: config.sauBaseDir ?? "（未配置）" },
    { label: "凭据文件", value: deps.cookie.path },
  ];

  if (!config.sauBinary?.trim()) {
    return { ...base, state: "blocked", detail: "未配置抖音自动发布引擎（sau），图文发不出去。", guidance: SAU_INSTALL_GUIDANCE_LINES, evidence: { paths } };
  }
  if (!config.sauBaseDir?.trim()) {
    return { ...base, state: "blocked", detail: "未配置 sau 仓库目录（SAU_BASE_DIR），图文发不出去。", guidance: SAU_INSTALL_GUIDANCE_LINES, evidence: { paths } };
  }
  for (const [target, describe] of [
    [config.sauBinary, "sau 可执行文件"],
    [config.sauBaseDir, "sau 仓库根目录"],
  ] as const) {
    try {
      await deps.fs.access(target);
    } catch {
      return {
        ...base,
        state: "blocked",
        detail: `配置的${describe}不存在：${target}。`,
        guidance: SAU_INSTALL_GUIDANCE_LINES,
        evidence: { paths },
      };
    }
  }

  // 凭据三态：全部是**文件层面**的事实，都不谈有效性（INV-1）
  const hasAuth = deps.cookie.hasAuthCookie();
  const hasAny = deps.cookie.hasCookie();
  const credentials: CredentialState = hasAuth ? "present" : hasAny ? "incomplete" : "empty";
  const credentialDetail =
    credentials === "present"
      ? "凭据已存在，有效性未知。"
      : credentials === "incomplete"
        ? "凭据缺少登录态字段。"
        : "尚未登录，凭据文件为空。";

  return {
    ...base,
    ...resolveChannelState({ credentials, verified: verifiedOf("douyin"), now }),
    detail: `${credentialDetail}（凭据文件：${deps.cookie.path}）`,
    evidence: { paths },
  };
}

/* ─────────────────────── 头条 / 小红书（同形） ─────────────────────── */

/** 两条解析链的逐层诊断形状一致（`isFile`/`listDirectories` 也是同一组探测点）。 */
type BrowserAttempt = ToutiaoBrowserAttempt | XhsBrowserAttemptType;

interface BrowserChannelSpec {
  label: string;
  resolve: (probe: ToutiaoBrowserProbe) => { target: unknown; attempts: BrowserAttempt[] };
  profileDir: () => string;
  guidance: string[];
  /** 出现在 detail 里的说法，例如「头条号浏览器」。 */
  browserHint: string;
  emptyChainDetail: string;
}

async function checkBrowserChannel(
  id: Extract<RuntimeItemId, "toutiao" | "xiaohongshu">,
  config: RuntimeStatusConfig,
  deps: RuntimeStatusDeps,
  verifiedOf: (id: RuntimeItemId) => RuntimeVerifiedRecord | undefined,
  now: Date,
  spec: BrowserChannelSpec,
): Promise<RuntimeItem> {
  const base = { id, label: spec.label, action: { kind: "login" as const, target: id } };

  /*
   * 解析链有两种失败形态，必须分开对待：
   * ① 显式配置的路径不存在 → 解析链**直接抛错**（它刻意不静默退到别的浏览器），
   *    此时没有逐层诊断可给，但错误文案本身就点名了那个路径；
   * ② 链条走完仍未命中 → 返回 `{ target: null, attempts }`，逐层诊断齐全。
   */
  let resolution: { target: unknown; attempts: BrowserAttempt[] };
  try {
    resolution = spec.resolve(deps.browserProbe);
  } catch (error) {
    if (isBrowserUnavailable(error)) {
      return {
        ...base,
        state: "blocked",
        detail: `${describeError(error)}（${spec.browserHint}没找到，发布无法进行。）`,
        guidance: spec.guidance,
      };
    }
    throw error;
  }

  const attempts = resolution.attempts;
  if (!resolution.target) {
    return {
      ...base,
      state: "blocked",
      detail: `${spec.emptyChainDetail}浏览器解析链逐层结果见证据。`,
      guidance: spec.guidance,
      evidence: { attempts: attempts.map((attempt) => ({ layer: attempt.layer, ok: attempt.ok, detail: attempt.detail })) },
    };
  }

  // 会话目录由执行器自己 mkdir，所以「还不存在」是**正常**的，不能报 blocked
  const profileDir = spec.profileDir();
  const writable = await probeWritable(deps, profileDir);
  if (!writable.ok) {
    return {
      ...base,
      state: "blocked",
      detail: `会话目录不可写：${profileDir}（${writable.errno ?? "未知错误"}）。`,
      guidance: spec.guidance,
      evidence: {
        paths: [{ label: "会话目录", value: profileDir }],
        errno: writable.errno,
        notes: writable.notes,
      },
    };
  }

  const evidence: RuntimeEvidence = {
    paths: [{ label: "会话目录", value: profileDir }],
    attempts: attempts.map((attempt) => ({ layer: attempt.layer, ok: attempt.ok, detail: attempt.detail })),
    notes: writable.notes,
  };

  return {
    ...base,
    ...resolveChannelState({ credentials: "present", verified: verifiedOf(id), now }),
    detail: "凭据已存在，有效性未知。",
    evidence,
  };
}

function isBrowserUnavailable(error: unknown): boolean {
  return (
    error instanceof ToutiaoBrowserError ||
    error instanceof XhsBrowserError ||
    (error instanceof Error && /浏览器/.test(error.message))
  );
}

/* ──────────────────── 发布链路依赖（ffmpeg / storage） ──────────────────── */

async function checkFfmpeg(config: RuntimeStatusConfig, deps: RuntimeStatusDeps): Promise<RuntimeItem> {
  const { command, args } = ffmpegProbeCommand(config.ffmpegBinary);
  const base = { id: "ffmpeg" as const, label: LABELS.ffmpeg };
  try {
    await deps.probe.runCommand(command, args, { captureStdout: true, captureStderr: true });
  } catch (error) {
    return {
      id: base.id,
      label: base.label,
      state: "blocked",
      detail: `跑不起来：${describeError(error)}`,
      guidance: [
        "未找到可用的 ffmpeg —— 图文包的配图裁 3:4 依赖它，发布会被卡住。",
        "① macOS 可运行 brew install ffmpeg；",
        "② 或设置环境变量 FFMPEG_BINARY 指向一个 ffmpeg 可执行文件，然后重启后端。",
      ],
      evidence: { paths: [{ label: "ffmpeg", value: command }] },
    };
  }
  return {
    id: base.id,
    label: base.label,
    state: "ready",
    detail: "就绪。",
    evidence: { paths: [{ label: "ffmpeg", value: command }] },
  };
}

async function checkStorage(config: RuntimeStatusConfig, deps: RuntimeStatusDeps): Promise<RuntimeItem> {
  const writable = await probeWritable(deps, config.storageRoot);
  if (!writable.ok) {
    return {
      id: "storage",
      label: LABELS.storage,
      state: "blocked",
      detail: `不可写：${config.storageRoot}（${writable.errno ?? "未知错误"}）。任何落盘都会失败。`,
      evidence: { paths: [{ label: "存储目录", value: config.storageRoot }], errno: writable.errno },
    };
  }
  return {
    id: "storage",
    label: LABELS.storage,
    state: "ready",
    detail: "可写。",
    evidence: { paths: [{ label: "存储目录", value: config.storageRoot }] },
  };
}

/* ──────────────────────────── 判定（唯一一处） ──────────────────────────── */

type CredentialState = "present" | "incomplete" | "empty";

/**
 * 条件 → 四态。**这是全仓唯一一份渠道状态判定**（INV-7），界面不许复算。
 *
 * 规则（spec §3.4）：
 * - 凭据不完整/为空 → `blocked`（明确发不出去）
 * - `verified = invalid` 且在有效期内 → `blocked`（我们**知道**它坏了）
 * - `verified = valid` 且在有效期内 → `ready`（唯一能变绿的路径）
 * - 其余（没有记录 / 记录已过期）→ `degraded`（不知道，但不拦着试）
 */
function resolveChannelState(input: {
  credentials: CredentialState;
  verified?: RuntimeVerifiedRecord;
  now: Date;
}): Pick<RuntimeItem, "state" | "verified"> {
  const { credentials, verified, now } = input;
  const fresh = verified !== undefined && isFresh(verified, now);

  if (credentials !== "present") return { state: "blocked", ...(verified ? { verified } : {}) };
  if (fresh && verified!.state === "invalid") return { state: "blocked", verified };
  if (fresh && verified!.state === "valid") return { state: "ready", verified };
  return { state: "degraded", ...(verified ? { verified } : {}) };
}

function isFresh(record: RuntimeVerifiedRecord, now: Date): boolean {
  const at = Date.parse(record.at);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at <= RUNTIME_VERIFIED_TTL_MS;
}

/* ──────────────────────────── 小工具 ──────────────────────────── */

/**
 * 目录可写性。
 *
 * ⚠️ 会话目录由执行器自己 `mkdir`（`xhs-runner.ts:728` / `toutiao-runner.ts:654`），
 * 所以**首次运行时它可能还不存在** —— 此时对目录本身 `access(W_OK)` 会得到 `ENOENT`，
 * 直接报 `blocked` 就是**假阳性**。规则：不存在就查**最近的已存在祖先目录**。
 *
 * 注意这条**只决定「要不要判 blocked」，不直接给 ready**：最终状态一律走
 * `resolveChannelState`（没有 verified 就是 degraded）。
 */
async function probeWritable(
  deps: RuntimeStatusDeps,
  target: string,
): Promise<{ ok: boolean; errno?: string; notes?: string[] }> {
  let current = path.resolve(target);
  let created = false;

  for (let depth = 0; depth < 64; depth += 1) {
    try {
      await deps.fs.access(current, W_OK);
      return created
        ? { ok: true, notes: [`目录尚未创建（首次使用时创建）：${target}`] }
        : { ok: true };
    } catch (error) {
      const code = errnoOf(error);
      if (code !== "ENOENT") return { ok: false, errno: code ?? "EACCES" };
      const parent = path.dirname(current);
      if (parent === current) return { ok: false, errno: "ENOENT" };
      current = parent;
      created = true;
    }
  }
  return { ok: false, errno: "ELOOP" };
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 读已验证记录。
 *
 * 读不到（文件不存在 / 损坏 / 没权限）**不让整条响应失败** —— 那只是「还没有已验证记录」，
 * 渠道自然回落到 `degraded`。这与 INV-1 一致：不知道就说不知道。
 */
async function loadVerifiedRecords(
  config: RuntimeStatusConfig,
  deps: RuntimeStatusDeps,
): Promise<Record<string, RuntimeVerifiedRecord>> {
  const file = path.join(config.storageRoot, ...VERIFIED_STORE_PATH);
  try {
    const raw = await deps.fs.readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const verified = (parsed as { verified?: unknown }).verified;
    if (typeof verified !== "object" || verified === null) return {};
    const out: Record<string, RuntimeVerifiedRecord> = {};
    for (const [id, value] of Object.entries(verified as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const { state, at } = value as { state?: unknown; at?: unknown };
      if ((state === "valid" || state === "invalid") && typeof at === "string") {
        out[id] = { state, at };
      }
    }
    return out;
  } catch {
    return {};
  }
}
