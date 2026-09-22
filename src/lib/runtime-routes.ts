/**
 * 运行环境状态一览的路由。
 *
 * 设计规格 §3.1 / §5.6。四个端点：
 * - `GET  /api/runtime/status`               五项**免费**检查（零副作用）
 * - `POST /api/runtime/checks`               发起深检（后台任务，立刻返回 202）
 * - `GET  /api/runtime/checks/:checkId`      轮询深检
 * - `POST /api/runtime/checks/:checkId/cancel` 取消（spec §5.3 的出口）
 *
 * ⚠️ 两处实现时对 spec 的修正（已回填 spec）：
 * ① §3.1 只列了三个端点，**漏了取消** —— 而界面有「取消检测」出口，没有路由就点不动。
 * ② §5.6 要求把三族 runner/browser 错误登记到本边界；实现下来它们**到不了这里**：
 *    探测内部的任何异常都被深检任务收敛成带指引的 `failed` 记录（比抛到边界更好，
 *    因为那次失败本来就该留在记录里给界面看）。所以这里只登记真正会逃逸的两类。
 */

import { Router, type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { LocalAuthError, requireActor, type LocalSessionStore } from "./local-auth.js";
import { RuntimeCheckError, type RuntimeChecks } from "./runtime-checks.js";
import {
  collectRuntimeStatus,
  type RuntimeChannelId,
  type RuntimeStatusConfig,
  type RuntimeStatusDeps,
} from "./runtime-status.js";

export class RuntimeRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeRouteError";
  }
}

export interface RuntimeRouteDeps {
  sessions: LocalSessionStore;
  /** 五项检查要看的配置（storage 根、sau / 浏览器 / ffmpeg 的路径与覆盖项）。 */
  config: RuntimeStatusConfig;
  deps: RuntimeStatusDeps;
  /** 深检任务。 */
  checks: RuntimeChecks;
}

export function registerRuntimeRoutes(app: Express, deps: RuntimeRouteDeps): void {
  const router = Router();
  const authenticated: RequestHandler = requireActor(deps.sessions);

  router.get(
    "/runtime/status",
    authenticated,
    route(async (_req, res) => {
      /*
       * 聚合层只管**免费**检查（零副作用、不 import 任务层）；当前深检任务由**路由**
       * 合进来 —— 这样 `collectRuntimeStatus()` 保持纯净，深检没装上时也只是 `check: null`。
       */
      const [status, check] = await Promise.all([collectRuntimeStatus(deps.config, deps.deps), deps.checks.status()]);
      res.json({ ...status, check });
    }),
  );

  router.post(
    "/runtime/checks",
    authenticated,
    route(async (req, res) => {
      const id = requiredChannel(req.body);
      // 202：这是**后台任务**，不是同步结果 —— 抖音那条最坏 5 分钟，同步等会卡死界面
      res.status(202).json({ check: await deps.checks.start(id) });
    }),
  );

  router.get(
    "/runtime/checks/:checkId",
    authenticated,
    route(async (req, res) => {
      const summary = await deps.checks.status();
      const checkId = requiredParam(req.params.checkId, "checkId");
      if (!summary || summary.checkId !== checkId) {
        throw new RuntimeRouteError(404, "runtime_check_not_found", "没有这次检测的记录（可能已被更新的一次覆盖）。");
      }
      res.json({ check: summary });
    }),
  );

  router.post(
    "/runtime/checks/:checkId/cancel",
    authenticated,
    route(async (req, res) => {
      res.json({ check: await deps.checks.cancel(requiredParam(req.params.checkId, "checkId")) });
    }),
  );

  app.use("/api", router);
  app.use(runtimeErrorMapper);
}

function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);
}

function requiredParam(value: string | string[] | undefined, name: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new RuntimeRouteError(400, "runtime_check_invalid_request", `${name} 无效。`);
}

function requiredChannel(body: unknown): RuntimeChannelId {
  const id = typeof body === "object" && body !== null ? (body as { id?: unknown }).id : undefined;
  if (id === "douyin" || id === "toutiao" || id === "xiaohongshu") return id;
  throw new RuntimeRouteError(400, "runtime_check_invalid_channel", "只支持 douyin / toutiao / xiaohongshu 三个渠道。");
}

function isRuntimeRequest(req: Request): boolean {
  return req.path.startsWith("/api/runtime");
}

function runtimeErrorMapper(error: unknown, req: Request, res: Response, next: NextFunction): void {
  // 只管自己这一族路径：否则会把别的路由的异常也吞掉
  if (!isRuntimeRequest(req)) {
    next(error);
    return;
  }

  if (error instanceof LocalAuthError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }

  /*
   * 深检自己的错误类：**必须原样带上 `guidance`**。
   * AGENTS.md 记着那次事故：错误类漏登记的表现不是状态码不准，而是**指引整条丢掉**，
   * 全落进兜底 500 且不留日志。
   */
  if (error instanceof RuntimeCheckError || error instanceof RuntimeRouteError) {
    res.status(error.status).json({
      code: error.code,
      message: error.message,
      ...(error instanceof RuntimeCheckError && error.guidance ? { guidance: error.guidance } : {}),
    });
    return;
  }

  // 真正意外的异常：至少留一条痕迹（发布中心那里原先什么都不打，于是 500 查不到原因）
  console.error("[runtime] 未预期的错误:", error);
  res.status(500).json({ code: "runtime_status_unavailable", message: "运行环境状态暂时取不到，请稍后重试" });
}
