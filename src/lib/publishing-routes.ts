import { Router, type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type {
  CreatePublishingPackageInput,
  PublishPlatform,
  PublishingListFilters,
  PublishingPackageDetail,
} from "../types.js";
import { getActor, LocalAuthError, LocalSessionStore, requireActor } from "./local-auth.js";
import { PublishingAssetError } from "./publishing-assets.js";
import { PublishingCopyError } from "./publishing-copy.js";
import {
  type CreateVersionInput,
  PublishingService,
  PublishingServiceError,
  type UpdatePublishContentInput,
} from "./publishing-service.js";
import { PublishingError } from "./publishing-store.js";
import { VideoOutputError } from "./video-output.js";

const PLATFORMS = new Set<PublishPlatform>(["douyin", "xiaohongshu", "wechat_channels", "bilibili"]);
const LIST_STATUSES = new Set(["action", "all", "scheduled", "ready", "published", "failed", "cancelled", "broken", "trash"]);
const SERVER_FIELDS = new Set(["actor", "role", "createdBy", "status", "publishedAt", "videoPath", "packagePath"]);

export type PublishingRouteService = PublishingService & {
  list(filters: PublishingListFilters): Promise<PublishingPackageDetail[]>;
  getPackage(packageId: string): Promise<PublishingPackageDetail | null>;
};

type PublishingRouteDeps = {
  publishing: PublishingRouteService;
  sessions: LocalSessionStore;
};

class PublishingRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PublishingRouteError";
  }
}

export function registerPublishingRoutes(app: Express, deps: PublishingRouteDeps): void {
  const router = Router();
  const authenticated = requireActor(deps.sessions);
  const admin = requireActor(deps.sessions, ["admin"]);
  const writable: RequestHandler = (_req, _res, next) => {
    const health = app.locals.publishingHealth as { readOnly?: boolean; message?: string } | undefined;
    if (health?.readOnly) {
      next(new PublishingRouteError(
        500,
        "publish_index_corrupt",
        health.message ?? "发布中心处于只读保护状态",
      ));
      return;
    }
    next();
  };

  router.post("/jobs/:id/publishing/preview", authenticated, route(async (req, res) => {
    const input = requestBody(req);
    const preview = await deps.publishing.preview(requiredId(req.params.id), platforms(input.platforms));
    res.json({ preview });
  }));

  router.get("/jobs/:id/publishing/assets", authenticated, route(async (req, res) => {
    res.json({ assets: await deps.publishing.inspectAssets(requiredId(req.params.id)) });
  }));

  router.post("/publishing/packages", authenticated, writable, route(async (req, res) => {
    const detail = await deps.publishing.create(createPackageInput(requestBody(req)), getActor(req));
    res.status(201).json({ package: detail });
  }));

  router.get("/publishing/packages", authenticated, route(async (req, res) => {
    const packages = await deps.publishing.list(listFilters(req));
    res.json({ packages });
  }));

  router.get("/publishing/packages/:id", authenticated, route(async (req, res) => {
    const detail = await deps.publishing.getPackage(requiredId(req.params.id));
    if (!detail) throw new PublishingRouteError(404, "publish_package_not_found", "未找到发布包");
    res.json({ package: detail });
  }));

  router.get("/publishing/packages/:id/cover", authenticated, route(async (req, res) => {
    const cover = await deps.publishing.readPackageCover(requiredId(req.params.id));
    if (!cover) throw new PublishingRouteError(404, "publish_cover_missing", "发布包没有可用封面");
    res.setHeader("Cache-Control", "private, no-store");
    res.type("jpg").send(cover);
  }));

  router.post("/publishing/due/check", writable, route(async (req, res) => {
    const input = requestBody(req);
    if (Object.keys(input).length > 0) invalid("到期检查不接受操作者或状态参数");
    res.json({ notifications: await deps.publishing.checkDue() });
  }));

  router.post("/publishing/packages/:id/versions", authenticated, writable, route(async (req, res) => {
    const detail = await deps.publishing.createVersion(
      requiredId(req.params.id),
      createVersionInput(requestBody(req)),
      getActor(req),
    );
    res.status(201).json({ package: detail });
  }));

  router.patch("/publishing/tasks/:id/content", authenticated, writable, route(async (req, res) => {
    const task = await deps.publishing.updateContent(
      requiredId(req.params.id),
      contentInput(requestBody(req)),
      getActor(req),
    );
    res.json({ task });
  }));

  router.patch("/publishing/tasks/:id/schedule", authenticated, writable, route(async (req, res) => {
    const input = requestBody(req);
    const task = await deps.publishing.updateSchedule(
      requiredId(req.params.id),
      nullableString(input.scheduledAt),
      getActor(req),
    );
    res.json({ task });
  }));

  router.post("/publishing/tasks/:id/cancel", authenticated, writable, route(async (req, res) => {
    requireConfirmation(requestBody(req));
    res.json({ task: await deps.publishing.cancel(requiredId(req.params.id), getActor(req)) });
  }));

  router.post("/publishing/tasks/:id/restore", authenticated, writable, route(async (req, res) => {
    const input = requestBody(req);
    res.json({
      task: await deps.publishing.restoreTask(
        requiredId(req.params.id),
        nullableString(input.scheduledAt),
        getActor(req),
      ),
    });
  }));

  router.post("/publishing/tasks/:id/mark-published", authenticated, writable, route(async (req, res) => {
    requireConfirmation(requestBody(req));
    res.json({ task: await deps.publishing.markPublished(requiredId(req.params.id), getActor(req)) });
  }));

  router.post("/publishing/tasks/:id/withdraw", admin, writable, route(async (req, res) => {
    const input = requestBody(req);
    requireConfirmation(input);
    res.json({
      task: await deps.publishing.withdraw(
        requiredId(req.params.id),
        requiredNonEmptyString(input.reason, "撤回原因不能为空"),
        getActor(req),
      ),
    });
  }));

  router.post("/publishing/tasks/:id/record-failure", authenticated, writable, route(async (req, res) => {
    const input = requestBody(req);
    res.json({
      task: await deps.publishing.recordFailure(
        requiredId(req.params.id),
        requiredNonEmptyString(input.reason, "失败原因不能为空"),
        getActor(req),
      ),
    });
  }));

  router.post("/publishing/tasks/:id/action-error", authenticated, writable, route(async (req, res) => {
    const input = requestBody(req);
    const action = input.action;
    if (action !== "open_platform" && action !== "show_in_finder") invalid("发布动作类型无效");
    await deps.publishing.recordActionError(
      requiredId(req.params.id),
      action,
      requiredNonEmptyString(input.message, "错误摘要不能为空"),
      getActor(req),
    );
    res.status(204).end();
  }));

  router.delete("/publishing/packages/:id", admin, writable, route(async (req, res) => {
    requireConfirmation(requestBody(req));
    res.json({ package: await deps.publishing.trashPackage(requiredId(req.params.id), getActor(req)) });
  }));

  router.post("/publishing/packages/:id/restore", admin, writable, route(async (req, res) => {
    requestBody(req);
    const result = await deps.publishing.restorePackage(requiredId(req.params.id), getActor(req));
    res.json(result);
  }));

  app.use("/api", router);
  app.use(publishingErrorMapper);
}

function route(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);
}

function requestBody(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) invalid();
  rejectServerFields(req.body);
  return req.body as Record<string, unknown>;
}

function rejectServerFields(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectServerFields(item);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SERVER_FIELDS.has(key)) invalid(`字段 ${key} 由服务端维护`);
    rejectServerFields(item);
  }
}

function createPackageInput(input: Record<string, unknown>): CreatePublishingPackageInput {
  if (!Array.isArray(input.platforms)) invalid("发布平台不能为空");
  return {
    sourceJobId: requiredNonEmptyString(input.sourceJobId),
    previewRevision: requiredNonEmptyString(input.previewRevision),
    title: requiredNonEmptyString(input.title),
    platforms: input.platforms.map((item) => {
      const record = object(item);
      const copy = object(record.copy);
      return {
        platform: platform(record.platform),
        copy: platformCopy(copy),
        ...(record.scheduledAt === undefined ? {} : { scheduledAt: requiredString(record.scheduledAt) }),
      };
    }),
  };
}

function createVersionInput(input: Record<string, unknown>): CreateVersionInput {
  const result: CreateVersionInput = {};
  if (input.title !== undefined) result.title = requiredString(input.title);
  if (input.platforms !== undefined) {
    if (!Array.isArray(input.platforms)) invalid("发布平台格式无效");
    if (input.platforms.every((item) => typeof item === "string")) {
      result.platforms = input.platforms.map(platform);
    } else if (input.platforms.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      result.platforms = input.platforms.map((item) => {
        const record = object(item);
        return {
          platform: platform(record.platform),
          ...(record.copy === undefined ? {} : { copy: platformCopy(object(record.copy)) }),
          ...(record.scheduledAt === undefined ? {} : { scheduledAt: nullableString(record.scheduledAt) }),
        };
      });
    } else {
      invalid("发布平台格式无效");
    }
  }
  if (input.schedules !== undefined) {
    const schedules = object(input.schedules);
    result.schedules = {};
    for (const [key, value] of Object.entries(schedules)) {
      result.schedules[platform(key)] = nullableString(value);
    }
  }
  return result;
}

function contentInput(input: Record<string, unknown>): UpdatePublishContentInput {
  const revision = input.expectedRevision;
  if (!Number.isSafeInteger(revision)) invalid("内容版本无效");
  return { ...platformCopy(input), expectedRevision: revision as number };
}

function platformCopy(input: Record<string, unknown>) {
  if (!Array.isArray(input.hashtags)) invalid("话题标签格式无效");
  return {
    title: requiredString(input.title),
    description: requiredString(input.description),
    hashtags: input.hashtags.map(requiredString),
  };
}

function listFilters(req: Request): PublishingListFilters {
  const status = queryString(req.query.status);
  const selectedPlatform = queryString(req.query.platform);
  const versionText = queryString(req.query.version);
  if (status && !LIST_STATUSES.has(status)) invalid("发布状态筛选无效");
  if (selectedPlatform && !PLATFORMS.has(selectedPlatform as PublishPlatform)) invalid("发布平台筛选无效");
  let version: number | undefined;
  if (versionText !== undefined) {
    version = Number(versionText);
    if (!Number.isSafeInteger(version) || version < 1) invalid("发布版本筛选无效");
  }
  return {
    ...(status ? { status: status as PublishingListFilters["status"] } : {}),
    ...(selectedPlatform ? { platform: selectedPlatform as PublishPlatform } : {}),
    ...(queryString(req.query.sourceJobId) ? { sourceJobId: queryString(req.query.sourceJobId) } : {}),
    ...(version === undefined ? {} : { version }),
    ...(queryString(req.query.createdBy) ? { createdBy: queryString(req.query.createdBy) } : {}),
    ...(queryString(req.query.search) ? { search: queryString(req.query.search) } : {}),
  };
}

function platforms(value: unknown): PublishPlatform[] {
  if (!Array.isArray(value)) invalid("发布平台不能为空");
  return value.map(platform);
}

function platform(value: unknown): PublishPlatform {
  if (typeof value !== "string" || !PLATFORMS.has(value as PublishPlatform)) invalid("发布平台无效");
  return value as PublishPlatform;
}

function requireConfirmation(input: Record<string, unknown>): void {
  if (input.confirmation !== true) invalid("请确认本次操作");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function requiredId(value: unknown): string {
  const id = requiredNonEmptyString(value);
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) invalid("资源 ID 无效");
  return id;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}

function requiredNonEmptyString(value: unknown, message = "请求参数无效"): string {
  const text = requiredString(value).trim();
  if (!text) invalid(message);
  return text;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function queryString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid("查询参数格式无效");
  return value;
}

function invalid(message = "请求参数无效"): never {
  throw new PublishingRouteError(400, "publish_validation_failed", message);
}

function publishingErrorMapper(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (!isPublishingRequest(req)) {
    next(error);
    return;
  }
  if (isMalformedJson(error)) {
    res.status(400).json({ code: "publish_validation_failed", message: "请求 JSON 格式无效" });
    return;
  }
  if (error instanceof LocalAuthError) {
    const code = error.status === 403 ? "publish_permission_denied" : error.code;
    res.status(error.status).json({ code, message: error.message });
    return;
  }
  if (error instanceof PublishingRouteError || error instanceof PublishingServiceError) {
    res.status(error.status).json(error.details
      ? { code: error.code, message: error.message, details: error.details }
      : { code: error.code, message: error.message });
    return;
  }
  if (error instanceof PublishingCopyError || error instanceof PublishingAssetError || error instanceof VideoOutputError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof PublishingError) {
    res.status(publishingErrorStatus(error.code)).json({
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  res.status(500).json({ code: "publish_service_unavailable", message: "发布服务暂时不可用，请稍后重试" });
}

function publishingErrorStatus(code: PublishingError["code"]): number {
  if (code === "publish_package_not_found" || code === "publish_task_not_found") return 404;
  if (code === "publish_permission_denied") return 403;
  if (code === "publish_asset_broken") return 422;
  if (code === "publish_invalid_transition" || code === "publish_revision_conflict") return 409;
  if (code === "publish_index_corrupt") return 500;
  return 400;
}

function isMalformedJson(error: unknown): boolean {
  return error instanceof SyntaxError && "status" in error && error.status === 400;
}

function isPublishingRequest(req: Request): boolean {
  return req.path.includes("/publishing/") || req.path.startsWith("/api/publishing");
}
