import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ActorSnapshot,
  CreatePublishingPackageInput,
  DeliveryPackage,
  DueNotification,
  JobRecord,
  PlatformCopy,
  PublishCopySource,
  PublishPlatform,
  PublishingAssetInspection,
  PublishingPackageDetail,
  PublishingPreview,
  PublishTask,
  ScriptAsset,
} from "../types.js";
import type { PublishingCopyService } from "./publishing-copy.js";
import {
  type BoundSourceVideo,
  type PublishingRecoveryReport,
  PublishingAssetError,
  PublishingAssetService,
} from "./publishing-assets.js";
import {
  normalizePlatformCopy,
  PUBLISH_PLATFORMS,
  validatePlatformCopy,
} from "./publishing-platforms.js";
import {
  PublishingError,
  PublishingStore,
  type RestorePackageResult,
} from "./publishing-store.js";
import { SYSTEM_ACTOR } from "./local-users.js";
import { resolveJobVideo, VideoOutputError } from "./video-output.js";

const CLEANED_DIRECTORY = path.join("processed", "cleaned");
const SCRIPT_DIRECTORY = path.join("processed", "scripts");
const SUPPORTED_PLATFORMS = new Set<PublishPlatform>(
  Object.keys(PUBLISH_PLATFORMS) as PublishPlatform[],
);

export interface CreateVersionPlatformInput {
  platform: PublishPlatform;
  copy?: PlatformCopy;
  scheduledAt?: string | null;
}

export interface CreateVersionInput {
  title?: string;
  platforms?: PublishPlatform[] | CreateVersionPlatformInput[];
  schedules?: Partial<Record<PublishPlatform, string | null>>;
}

export interface UpdatePublishContentInput extends PlatformCopy {
  expectedRevision: number;
}

type JobReader = {
  get(jobId: string): Promise<JobRecord | null>;
};

type CopyService = Pick<PublishingCopyService, "previewAll">;
type Store = Pick<PublishingStore,
  | "cancel"
  | "commitPackage"
  | "getPackage"
  | "getTask"
  | "markPublished"
  | "markPurged"
  | "processDue"
  | "recordActionError"
  | "recordFailure"
  | "recordPurgeFailure"
  | "reserveVersion"
  | "restorePackage"
  | "restoreTask"
  | "setAssetHealth"
  | "snapshot"
  | "trashPackage"
  | "updateContent"
  | "updateSchedule"
  | "withdraw"
>;
type Assets = Pick<PublishingAssetService,
  | "createPackageAssets"
  | "purgeAssets"
  | "readPackageCover"
  | "scanAndRepair"
  | "stageTextProjection"
  | "verifyPackageVideo"
>;

export interface PublishingServiceDependencies {
  storageRoot: string;
  jobs: JobReader;
  store: Store;
  assets: Assets;
  copy: CopyService;
  now?: () => Date;
  createId?: () => string;
  resolveVideo?: typeof resolveJobVideo;
}

type ServiceErrorCode =
  | "publish_asset_broken"
  | "publish_cleaned_missing"
  | "publish_consistency_failed"
  | "publish_index_corrupt"
  | "publish_index_write_failed"
  | "publish_invalid_transition"
  | "publish_job_not_found"
  | "publish_package_not_found"
  | "publish_permission_denied"
  | "publish_projection_write_failed"
  | "publish_revision_conflict"
  | "publish_task_not_found"
  | "publish_validation_failed";

const SERVICE_ERROR_MESSAGES: Record<ServiceErrorCode, string> = {
  publish_asset_broken: "发布包视频资产异常，无法执行此操作",
  publish_cleaned_missing: "未找到可用洗稿内容，请先完成 AI 洗稿",
  publish_consistency_failed: "发布索引写入失败，且发布包资产回滚失败，请重启应用执行修复",
  publish_index_corrupt: "发布索引已损坏，当前处于只读保护状态",
  publish_index_write_failed: "发布索引写入失败，未保存本次修改",
  publish_invalid_transition: "当前发布状态不允许执行此操作",
  publish_job_not_found: "未找到源任务",
  publish_package_not_found: "未找到发布包",
  publish_permission_denied: "当前操作者无权执行此操作",
  publish_projection_write_failed: "发布文案文件写入失败，未保存本次修改",
  publish_revision_conflict: "源内容自预览后发生变化，请重新预览后创建",
  publish_task_not_found: "未找到发布任务",
  publish_validation_failed: "发布数据校验失败",
};

export class PublishingServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: ServiceErrorCode,
    message = SERVICE_ERROR_MESSAGES[code],
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PublishingServiceError";
  }
}

type SourceContext = {
  cleaned: ScriptAsset;
  cleanedMtimeMs: number;
  video: Awaited<ReturnType<typeof resolveJobVideo>> & { mtimeMs: number };
  width: number;
  height: number;
  duration: number;
  sourceCoverPath?: string;
};

type ValidatedDraft = {
  platform: PublishPlatform;
  copy: PlatformCopy;
  copySource: PublishCopySource;
  scheduledAt?: string;
};

export class PublishingService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly resolveVideo: NonNullable<PublishingServiceDependencies["resolveVideo"]>;
  private readonly storageRoot: string;
  private readonly copyAttestations = new Map<string, PublishCopySource>();

  constructor(private readonly deps: PublishingServiceDependencies) {
    this.storageRoot = path.resolve(deps.storageRoot);
    this.now = deps.now ?? (() => new Date());
    this.createId = deps.createId ?? randomUUID;
    this.resolveVideo = deps.resolveVideo ?? resolveJobVideo;
  }

  async inspectAssets(jobId: string): Promise<PublishingAssetInspection> {
    const context = await this.readSourceContext(jobId);
    try {
      return {
        filename: path.basename(context.video.path),
        size: context.video.size,
        width: context.width,
        height: context.height,
        duration: context.duration,
        coverAvailable: Boolean(context.sourceCoverPath),
        estimatedAdditionalBytes: context.video.size,
        warnings: context.sourceCoverPath ? [] : [{
          code: "publish_cover_missing",
          message: "未发现本地封面，创建时将尝试从视频第 1 秒抽取",
        }],
      };
    } finally {
      await context.video.close().catch(() => undefined);
    }
  }

  async preview(jobId: string, platforms: PublishPlatform[]): Promise<PublishingPreview> {
    const selected = validatePlatformSelection(platforms);
    const context = await this.readSourceContext(jobId);
    try {
      const index = await this.deps.store.snapshot();
      const nextVersion = index.nextVersionBySource[jobId] ?? 1;
      const copyPreview = await this.deps.copy.previewAll(context.cleaned, selected);
      const sourceKey = sourceContextRevision(jobId, context);
      for (const platform of selected) {
        const copy = copyPreview.copies[platform];
        if (copy) this.rememberCopy(sourceKey, platform, copy, copy.copySource);
      }

      return {
        sourceJobId: jobId,
        nextVersion,
        previewRevision: sourceRevision(jobId, context, selected),
        video: {
          filename: path.basename(context.video.path),
          size: context.video.size,
          width: context.width,
          height: context.height,
          duration: context.duration,
          coverAvailable: Boolean(context.sourceCoverPath),
        },
        copies: copyPreview.copies,
        ...(copyPreview.warning ? { warning: copyPreview.warning } : {}),
        expectedPackagePath: path.join(
          this.storageRoot,
          "output",
          "publishing",
          jobId,
          `v${nextVersion}-preview`,
        ),
      };
    } finally {
      await context.video.close().catch(() => undefined);
    }
  }

  async create(
    input: CreatePublishingPackageInput,
    actor: ActorSnapshot,
  ): Promise<PublishingPackageDetail> {
    const selected = validatePlatformSelection(input.platforms.map((item) => item.platform));
    const context = await this.readSourceContext(input.sourceJobId);
    try {
      const currentRevision = sourceRevision(input.sourceJobId, context, selected);
      if (currentRevision !== input.previewRevision) {
        throw new PublishingServiceError(409, "publish_revision_conflict", undefined, {
          expectedRevision: input.previewRevision,
          currentRevision,
        });
      }

      const sourceKey = sourceContextRevision(input.sourceJobId, context);
      const drafts = validateDrafts(input.platforms, this.now(), (platform, copy) => (
        this.copyAttestations.get(copyAttestationKey(sourceKey, platform, copy)) ?? "user_edited"
      ));
      const title = requireTitle(input.title);
      return await this.createPackage({
        sourceJobId: input.sourceJobId,
        sourceVideoPath: context.video.path,
        sourceVideo: {
          path: context.video.path,
          handle: context.video.handle,
          size: context.video.size,
          identity: context.video.identity,
        },
        sourceCoverPath: context.sourceCoverPath,
        title,
        drafts,
        actor,
      });
    } finally {
      await context.video.close().catch(() => undefined);
    }
  }

  async createVersion(
    packageId: string,
    input: CreateVersionInput,
    actor: ActorSnapshot,
  ): Promise<PublishingPackageDetail> {
    const previous = await this.requirePackage(packageId);
    if (previous.package.state !== "active") {
      throw new PublishingServiceError(409, "publish_validation_failed", "垃圾桶中的发布包不能创建新版本");
    }
    const sourceVideo = await this.bindPackageVideo(previous.package);
    try {
      const health = await this.deps.assets.verifyPackageVideo(previous.package);
      const currentStats = await stat(sourceVideo.path).catch(() => undefined);
      if (
        health === "broken_video"
        || !currentStats
        || currentStats.dev !== sourceVideo.identity.dev
        || currentStats.ino !== sourceVideo.identity.ino
      ) {
        throw new PublishingServiceError(422, "publish_asset_broken");
      }

      const versionDrafts = buildVersionDrafts(previous, input);
      const drafts = validateDrafts(versionDrafts, this.now());
      return await this.createPackage({
        sourceJobId: previous.package.sourceJobId,
        sourceVideoPath: sourceVideo.path,
        sourceVideo,
        sourceCoverPath: previous.package.coverPath,
        title: requireTitle(input.title ?? previous.package.title),
        drafts,
        actor,
      });
    } finally {
      await sourceVideo.handle.close().catch(() => undefined);
    }
  }

  async updateContent(
    taskId: string,
    input: UpdatePublishContentInput,
    actor: ActorSnapshot,
  ): Promise<PublishTask> {
    const task = await this.requireTask(taskId);
    const detail = await this.requirePackage(task.packageId);
    assertActivePackage(detail.package);
    if (task.status === "published") {
      throw new PublishingServiceError(409, "publish_validation_failed", "已发布平台内容已锁定，请创建新版本后修改");
    }
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== task.contentRevision) {
      throw new PublishingServiceError(409, "publish_revision_conflict", "发布内容已被修改，请刷新后重试", {
        expectedRevision: input.expectedRevision,
        currentRevision: task.contentRevision,
      });
    }

    const copy = validateCopy(task.platform, input);
    const nextTask: PublishTask = {
      ...task,
      ...copy,
      copySource: "user_edited",
      contentRevision: task.contentRevision + 1,
      updatedAt: this.now().toISOString(),
    };
    const nextDetail: PublishingPackageDetail = {
      ...detail,
      tasks: detail.tasks.map((item) => item.id === taskId ? nextTask : item),
    };

    let projection;
    try {
      projection = await this.deps.assets.stageTextProjection(nextDetail);
      await projection.commit();
    } catch (error) {
      await projection?.rollback().catch(() => undefined);
      throw normalizeOperationError(error, "projection");
    }

    let updated: PublishTask;
    try {
      updated = await this.deps.store.updateContent(taskId, {
        ...copy,
        expectedRevision: input.expectedRevision,
      }, actor);
    } catch (error) {
      try {
        await projection.rollback();
      } catch {
        throw new PublishingServiceError(
          500,
          "publish_projection_write_failed",
          "发布索引写入失败，且旧文案文件恢复失败，请重启应用执行修复",
        );
      }
      throw normalizeOperationError(error, "index");
    }
    await projection.finalize().catch(() => undefined);
    return updated;
  }

  async updateSchedule(taskId: string, scheduledAt: string | null, actor: ActorSnapshot): Promise<PublishTask> {
    validateSchedule(scheduledAt);
    return this.storeCall(() => this.deps.store.updateSchedule(taskId, scheduledAt, actor));
  }

  async cancel(taskId: string, actor: ActorSnapshot): Promise<PublishTask> {
    return this.storeCall(() => this.deps.store.cancel(taskId, actor));
  }

  async restoreTask(taskId: string, scheduledAt: string | null, actor: ActorSnapshot): Promise<PublishTask> {
    validateSchedule(scheduledAt);
    return this.storeCall(() => this.deps.store.restoreTask(taskId, scheduledAt, actor));
  }

  async markPublished(taskId: string, actor: ActorSnapshot): Promise<PublishTask> {
    const task = await this.requireTask(taskId);
    const detail = await this.requirePackage(task.packageId);
    if (await this.deps.assets.verifyPackageVideo(detail.package) === "broken_video") {
      await this.storeCall(() => this.deps.store.setAssetHealth(detail.package.id, "broken_video", actor));
      throw new PublishingServiceError(422, "publish_asset_broken");
    }
    return this.storeCall(() => this.deps.store.markPublished(taskId, actor));
  }

  async withdraw(taskId: string, reason: string, actor: ActorSnapshot): Promise<PublishTask> {
    return this.storeCall(() => this.deps.store.withdraw(taskId, requireReason(reason), actor));
  }

  async recordFailure(taskId: string, reason: string, actor: ActorSnapshot): Promise<PublishTask> {
    return this.storeCall(() => this.deps.store.recordFailure(taskId, requireReason(reason), actor));
  }

  async recordActionError(
    taskId: string,
    action: "open_platform" | "show_in_finder",
    message: string,
    actor: ActorSnapshot,
  ): Promise<void> {
    if (action !== "open_platform" && action !== "show_in_finder") {
      throw new PublishingServiceError(400, "publish_validation_failed", "发布动作类型无效");
    }
    await this.storeCall(() => this.deps.store.recordActionError(taskId, action, requireReason(message), actor));
  }

  async trashPackage(packageId: string, actor: ActorSnapshot): Promise<DeliveryPackage> {
    requireAdmin(actor);
    return this.storeCall(() => this.deps.store.trashPackage(packageId, actor));
  }

  async restorePackage(packageId: string, actor: ActorSnapshot): Promise<RestorePackageResult> {
    requireAdmin(actor);
    return this.storeCall(() => this.deps.store.restorePackage(packageId, actor));
  }

  async readPackageCover(packageId: string): Promise<Buffer | null> {
    const detail = await this.requirePackage(packageId);
    return this.deps.assets.readPackageCover(detail.package);
  }

  async checkDue(): Promise<DueNotification[]> {
    return this.storeCall(() => this.deps.store.processDue(this.now()));
  }

  async recoverOnStartup(): Promise<PublishingRecoveryReport> {
    const before = await this.deps.store.snapshot();
    const scanIndex = structuredClone(before);
    const report = await this.deps.assets.scanAndRepair(scanIndex);

    for (const packageId of Object.keys(scanIndex.packages).sort()) {
      const previous = before.packages[packageId];
      const scanned = scanIndex.packages[packageId];
      if (
        previous?.state === "active"
        && scanned?.state === "active"
        && previous.assetHealth !== scanned.assetHealth
      ) {
        await this.storeCall(() => this.deps.store.setAssetHealth(packageId, scanned.assetHealth, SYSTEM_ACTOR));
      }
    }

    report.notifications = await this.storeCall(() => this.deps.store.processDue(this.now()));
    const afterDue = await this.deps.store.snapshot();
    const expired = Object.values(afterDue.packages)
      .filter((pkg) => pkg.state === "trashed" && isDue(pkg.purgeAt, this.now()))
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const pkg of expired) {
      try {
        await this.deps.assets.purgeAssets(pkg);
        await this.storeCall(() => this.deps.store.markPurged(pkg.id, SYSTEM_ACTOR));
        report.purgedPackageIds.push(pkg.id);
      } catch {
        const message = "发布包资产清理失败，请检查文件权限后重试";
        report.purgeFailures.push({ packageId: pkg.id, message });
        await this.deps.store.recordPurgeFailure(pkg.id, message, SYSTEM_ACTOR).catch(() => undefined);
      }
    }

    return report;
  }

  async verifyPackage(packageId: string): Promise<DeliveryPackage["assetHealth"]> {
    const detail = await this.requirePackage(packageId);
    return this.deps.assets.verifyPackageVideo(detail.package);
  }

  async getFinderVideoPath(packageId: string): Promise<string> {
    const detail = await this.requirePackage(packageId);
    assertActivePackage(detail.package);
    if (await this.deps.assets.verifyPackageVideo(detail.package) === "broken_video" || !detail.package.videoPath) {
      throw new PublishingServiceError(422, "publish_asset_broken");
    }
    return detail.package.videoPath;
  }

  private async createPackage(input: {
    sourceJobId: string;
    sourceVideoPath: string;
    sourceVideo: BoundSourceVideo;
    sourceCoverPath?: string;
    title: string;
    drafts: ValidatedDraft[];
    actor: ActorSnapshot;
  }): Promise<PublishingPackageDetail> {
    const version = await this.storeCall(() => this.deps.store.reserveVersion(input.sourceJobId, input.actor));
    const packageId = this.createId();
    const timestamp = this.now().toISOString();
    const tasks = input.drafts.map((draft): PublishTask => ({
      id: this.createId(),
      packageId,
      platform: draft.platform,
      ...draft.copy,
      copySource: draft.copySource,
      status: scheduleStatus(draft.scheduledAt, this.now()),
      ...(draft.scheduledAt ? { scheduledAt: draft.scheduledAt } : {}),
      contentRevision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));

    const assets = await this.deps.assets.createPackageAssets({
      packageId,
      sourceJobId: input.sourceJobId,
      version,
      sourceVideoPath: input.sourceVideoPath,
      sourceVideo: input.sourceVideo,
      ...(input.sourceCoverPath ? { sourceCoverPath: input.sourceCoverPath } : {}),
      title: input.title,
      tasks,
      actor: input.actor,
    });
    const packageRecord: DeliveryPackage = {
      id: packageId,
      sourceJobId: input.sourceJobId,
      version,
      state: "active",
      title: input.title,
      packagePath: assets.packagePath,
      videoPath: assets.videoPath,
      ...(assets.coverPath ? { coverPath: assets.coverPath } : {}),
      videoSha256: assets.videoSha256,
      videoSize: assets.videoSize,
      videoMethod: assets.videoMethod,
      assetHealth: assets.assetHealth,
      createdBy: structuredClone(input.actor),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      return await this.deps.store.commitPackage({ package: packageRecord, tasks }, input.actor);
    } catch (error) {
      try {
        await assets.rollback();
      } catch {
        throw new PublishingServiceError(500, "publish_consistency_failed", undefined, {
          failedStages: ["index_commit", "asset_rollback"],
          recovery: "startup_scan",
        });
      }
      throw normalizeOperationError(error, "index");
    }
  }

  private async readSourceContext(jobId: string): Promise<SourceContext> {
    validateSafeId(jobId);
    const job = await this.deps.jobs.get(jobId);
    if (!job || job.deletedAt) throw new PublishingServiceError(404, "publish_job_not_found");

    const cleanedPath = path.join(this.storageRoot, CLEANED_DIRECTORY, `${jobId}.json`);
    let cleanedAsset: { output?: ScriptAsset };
    let cleanedStats;
    try {
      const [bytes, fileStats] = await Promise.all([readFile(cleanedPath, "utf8"), stat(cleanedPath)]);
      cleanedAsset = JSON.parse(bytes) as { output?: ScriptAsset };
      cleanedStats = fileStats;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PublishingServiceError(422, "publish_cleaned_missing");
      }
      throw new PublishingServiceError(422, "publish_cleaned_missing", "洗稿内容不可读取，请重新执行 AI 洗稿");
    }
    if (!cleanedAsset.output || typeof cleanedAsset.output !== "object") {
      throw new PublishingServiceError(422, "publish_cleaned_missing");
    }

    const resolved = await this.resolveVideo(this.storageRoot, job);
    try {
      const videoStats = await resolved.handle.stat();
      const script = await readOptionalJson<ScriptAsset>(
        path.join(this.storageRoot, SCRIPT_DIRECTORY, `${jobId}.json`),
      );
      const output = script?.hyperframesVideo ?? cleanedAsset.output.hyperframesVideo;
      const sourceCoverPath = await readableCoverPath(this.storageRoot, jobId);
      return {
        cleaned: cleanedAsset.output,
        cleanedMtimeMs: cleanedStats.mtimeMs,
        video: { ...resolved, mtimeMs: videoStats.mtimeMs },
        width: positiveNumber(output?.width, 1080),
        height: positiveNumber(output?.height, 1920),
        duration: positiveNumber(output?.duration, 0),
        ...(sourceCoverPath ? { sourceCoverPath } : {}),
      };
    } catch (error) {
      await resolved.close().catch(() => undefined);
      throw error;
    }
  }

  private async bindPackageVideo(pkg: DeliveryPackage): Promise<BoundSourceVideo> {
    if (!pkg.videoPath) throw new PublishingServiceError(422, "publish_asset_broken");
    let handle: BoundSourceVideo["handle"] | undefined;
    try {
      handle = await open(pkg.videoPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size === 0) {
        throw new PublishingServiceError(422, "publish_asset_broken");
      }
      return {
        path: path.resolve(pkg.videoPath),
        handle,
        size: opened.size,
        identity: { dev: opened.dev, ino: opened.ino },
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof PublishingServiceError) throw error;
      throw new PublishingServiceError(422, "publish_asset_broken");
    }
  }

  private async requirePackage(packageId: string): Promise<PublishingPackageDetail> {
    const detail = await this.deps.store.getPackage(packageId);
    if (!detail) throw new PublishingServiceError(404, "publish_package_not_found");
    return detail;
  }

  private async requireTask(taskId: string): Promise<PublishTask> {
    const task = await this.deps.store.getTask(taskId);
    if (!task) throw new PublishingServiceError(404, "publish_task_not_found");
    return task;
  }

  private async storeCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeOperationError(error, "store");
    }
  }

  private rememberCopy(
    sourceKey: string,
    platform: PublishPlatform,
    copy: PlatformCopy,
    source: PublishCopySource,
  ): void {
    this.copyAttestations.set(copyAttestationKey(sourceKey, platform, copy), source);
    while (this.copyAttestations.size > 500) {
      const oldest = this.copyAttestations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.copyAttestations.delete(oldest);
    }
  }
}

function sourceContextRevision(jobId: string, context: SourceContext): string {
  return sourceContextHash(jobId, context).digest("hex");
}

function sourceContextHash(jobId: string, context: SourceContext) {
  return createHash("sha256")
    .update(jobId)
    .update(context.video.path)
    .update(String(context.video.size))
    .update(String(context.video.mtimeMs))
    .update(String(context.cleanedMtimeMs));
}

function copyAttestationKey(sourceKey: string, platform: PublishPlatform, copy: PlatformCopy): string {
  return createHash("sha256")
    .update(sourceKey)
    .update(platform)
    .update(JSON.stringify([copy.title, copy.description, copy.hashtags]))
    .digest("hex");
}

function sourceRevision(
  jobId: string,
  context: SourceContext,
  platforms: PublishPlatform[],
): string {
  return sourceContextHash(jobId, context)
    .update([...platforms].sort().join(","))
    .digest("hex");
}

function validatePlatformSelection(platforms: PublishPlatform[]): PublishPlatform[] {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new PublishingServiceError(400, "publish_validation_failed", "请至少选择一个发布平台");
  }
  const selected = new Set<PublishPlatform>();
  for (const platform of platforms) {
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      throw new PublishingServiceError(400, "publish_validation_failed", "包含不支持的发布平台");
    }
    if (selected.has(platform)) {
      throw new PublishingServiceError(400, "publish_validation_failed", "发布平台不能重复选择");
    }
    selected.add(platform);
  }
  return [...selected];
}

function validateDrafts(
  drafts: Array<{
    platform: PublishPlatform;
    copy: PlatformCopy;
    copySource?: PublishCopySource;
    scheduledAt?: string | null;
  }>,
  now: Date,
  resolveCopySource?: (platform: PublishPlatform, copy: PlatformCopy) => PublishCopySource,
): ValidatedDraft[] {
  validatePlatformSelection(drafts.map((draft) => draft.platform));
  return drafts.map((draft) => {
    const copy = validateCopy(draft.platform, draft.copy);
    const copySource = resolveCopySource?.(draft.platform, copy) ?? draft.copySource;
    if (!isCopySource(copySource)) {
      throw new PublishingServiceError(400, "publish_validation_failed", "发布文案来源无效");
    }
    const scheduledAt = normalizeSchedule(draft.scheduledAt, now);
    return {
      platform: draft.platform,
      copy,
      copySource,
      ...(scheduledAt ? { scheduledAt } : {}),
    };
  });
}

function validateCopy(platform: PublishPlatform, copy: PlatformCopy): PlatformCopy {
  if (!copy || typeof copy.title !== "string" || typeof copy.description !== "string" || !Array.isArray(copy.hashtags)) {
    throw new PublishingServiceError(400, "publish_validation_failed", "发布文案格式无效");
  }
  if (copy.hashtags.some((tag) => typeof tag !== "string")) {
    throw new PublishingServiceError(400, "publish_validation_failed", "发布标签格式无效");
  }
  const normalized = normalizePlatformCopy(copy);
  const errors = validatePlatformCopy(platform, normalized);
  if (errors.length > 0) {
    throw new PublishingServiceError(400, "publish_validation_failed", errors[0].message, {
      errors,
    });
  }
  return normalized;
}

function buildVersionDrafts(
  detail: PublishingPackageDetail,
  input: CreateVersionInput,
): Array<{
  platform: PublishPlatform;
  copy: PlatformCopy;
  copySource: PublishCopySource;
  scheduledAt?: string | null;
}> {
  const previousByPlatform = new Map(detail.tasks.map((task) => [task.platform, task]));
  const requested = input.platforms ?? detail.tasks.map((task) => task.platform);
  return requested.map((item) => {
    const descriptor: CreateVersionPlatformInput = typeof item === "string" ? { platform: item } : item;
    const previous = previousByPlatform.get(descriptor.platform);
    if (!previous && !descriptor.copy) {
      throw new PublishingServiceError(400, "publish_validation_failed", "新增平台必须提供发布文案");
    }
    const scheduledAt = descriptor.scheduledAt !== undefined
      ? descriptor.scheduledAt
      : input.schedules?.[descriptor.platform];
    return {
      platform: descriptor.platform,
      copy: descriptor.copy ?? {
        title: previous!.title,
        description: previous!.description,
        hashtags: [...previous!.hashtags],
      },
      copySource: descriptor.copy ? "user_edited" : previous?.copySource ?? "user_edited",
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
    };
  });
}

function normalizeSchedule(value: string | null | undefined, now: Date): string | undefined {
  if (value === undefined || value === null) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PublishingServiceError(400, "publish_validation_failed", "排期时间格式无效");
  }
  return date.getTime() > now.getTime() ? date.toISOString() : undefined;
}

function validateSchedule(value: string | null): void {
  if (value !== null && !Number.isFinite(new Date(value).getTime())) {
    throw new PublishingServiceError(400, "publish_validation_failed", "排期时间格式无效");
  }
}

function scheduleStatus(scheduledAt: string | undefined, now: Date): "scheduled" | "ready" {
  return scheduledAt && new Date(scheduledAt).getTime() > now.getTime() ? "scheduled" : "ready";
}

function requireTitle(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PublishingServiceError(400, "publish_validation_failed", "发布包标题不能为空");
  }
  return value.trim();
}

function requireReason(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PublishingServiceError(400, "publish_validation_failed", "请填写操作原因");
  }
  return value.trim();
}

function requireAdmin(actor: ActorSnapshot): void {
  if (actor.role !== "admin") {
    throw new PublishingServiceError(403, "publish_permission_denied");
  }
}

function assertActivePackage(pkg: DeliveryPackage): void {
  if (pkg.state !== "active") {
    throw new PublishingServiceError(409, "publish_validation_failed", "垃圾桶中的发布包不能执行此操作");
  }
}

function validateSafeId(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new PublishingServiceError(400, "publish_validation_failed", "任务标识无效");
  }
}

function isCopySource(value: unknown): value is PublishCopySource {
  return value === "ai" || value === "cleaned_fallback" || value === "user_edited";
}

function isDue(value: string | undefined, now: Date): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

async function readableCoverPath(storageRoot: string, jobId: string): Promise<string | undefined> {
  const candidate = path.join(storageRoot, "output", "covers", `${jobId}.jpg`);
  try {
    const fileStats = await stat(candidate);
    await access(candidate, constants.R_OK);
    return fileStats.isFile() && fileStats.size > 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeOperationError(error: unknown, operation: "index" | "projection" | "store"): Error {
  if (
    error instanceof PublishingServiceError
    || error instanceof PublishingAssetError
    || error instanceof VideoOutputError
  ) return error;
  if (error instanceof PublishingError) {
    return normalizeStoreError(error);
  }
  if (operation === "projection") {
    return new PublishingServiceError(500, "publish_projection_write_failed");
  }
  if (operation === "index") {
    return new PublishingServiceError(500, "publish_index_write_failed");
  }
  return new PublishingServiceError(500, "publish_index_write_failed", "发布数据写入失败，请检查存储权限后重试");
}

function normalizeStoreError(error: PublishingError): PublishingServiceError {
  switch (error.code) {
    case "publish_permission_denied":
      return new PublishingServiceError(403, error.code, error.message, error.details);
    case "publish_package_not_found":
    case "publish_task_not_found":
      return new PublishingServiceError(404, error.code, error.message, error.details);
    case "publish_validation_failed":
      return new PublishingServiceError(400, error.code, error.message, error.details);
    case "publish_asset_broken":
      return new PublishingServiceError(422, error.code, error.message, error.details);
    case "publish_index_corrupt":
      return new PublishingServiceError(500, error.code, error.message, error.details);
    case "publish_invalid_transition":
    case "publish_revision_conflict":
      return new PublishingServiceError(409, error.code, error.message, error.details);
  }
}
