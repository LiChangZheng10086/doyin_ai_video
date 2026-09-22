/**
 * 运行环境状态一览的路由。
 *
 * 设计规格 §3.1 / §5.6：三个端点、**自带错误边界**。
 * Task 1 只做 `GET /api/runtime/status`（聚合五项免费检查）；
 * 深检的两个端点由 Task 2 补上，届时边界里要一并登记 `RuntimeCheckError`
 * 与三族 runner/browser 错误 —— AGENTS.md 记着那次事故：**漏登记的表现不是状态码
 * 不准，而是「指引整条丢掉」**，全落进兜底 500 且不留日志。
 */

import { Router, type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { LocalAuthError, requireActor, type LocalSessionStore } from "./local-auth.js";
import { collectRuntimeStatus, type RuntimeStatusConfig, type RuntimeStatusDeps } from "./runtime-status.js";

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
}

export function registerRuntimeRoutes(app: Express, deps: RuntimeRouteDeps): void {
  const router = Router();
  const authenticated: RequestHandler = requireActor(deps.sessions);

  router.get(
    "/runtime/status",
    authenticated,
    route(async (_req, res) => {
      res.json(await collectRuntimeStatus(deps.config, deps.deps));
    }),
  );

  app.use("/api", router);
  app.use(runtimeErrorMapper);
}

function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);
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

  if (error instanceof RuntimeRouteError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }

  // 真正意外的异常：至少留一条痕迹。此前发布中心这里**什么都不打**，
  // 于是「500 + 一句无从下手的话」在应用日志里查不到任何原因。
  console.error("[runtime] 未预期的错误:", error);
  res.status(500).json({ code: "runtime_status_unavailable", message: "运行环境状态暂时取不到，请稍后重试" });
}
