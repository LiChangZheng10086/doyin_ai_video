import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActorSnapshot,
  CreatePublishingPackageInput,
  DeliveryPackage,
  DueNotification,
  JobRecord,
  PackageContentType,
  PlatformCopy,
  PublishCopySource,
  PublishPlatform,
  PublishingAssetInspection,
  PublishingPackageDetail,
  PublishingPackagePreview,
  PublishingPreview,
  PublishingPreviewCopyCheck,
  PublishTask,
  ScriptAsset,
} from "../types.js";
import type { PublishingCopyService } from "./publishing-copy.js";
import {
  type BoundSourceVideo,
  type PublishingRecoveryReport,
  PublishingAssetError,
  PublishingAssetService,
  collectSceneSnapshots,
} from "./publishing-assets.js";
import {
  normalizePlatformCopy,
  PUBLISH_NOTE_POLICIES,
  PUBLISH_PLATFORMS,
  type PlatformPolicy,
  validateNoteCopy,
  validatePlatformCopy,
} from "./publishing-platforms.js";
import {
  PublishingError,
  PublishingStore,
  packagePreviewRevision,
  type RestorePackageResult,
} from "./publishing-store.js";
import { SAU_INSTALL_GUIDANCE, SAU_NOTE_MAX_TITLE, SauRunner, SauRunnerError } from "./sau-runner.js";
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
  | "beginAutoPublish"
  | "cancel"
  | "commitPackage"
  | "getPackage"
  | "getTask"
  | "markPublished"
  | "markPurged"
  | "processDue"
  | "recordAutoPublishCode"
  | "recordActionError"
  | "recordFailure"
  | "recordPurgeFailure"
  | "reserveVersion"
  | "restorePackage"
  | "restoreTask"
  | "setAssetHealth"
  | "snapshot"
  | "trashPackage"
  | "updateAutoPublish"
  | "updateContent"
  | "updateSchedule"
  | "withdraw"
>;
type Assets = Pick<PublishingAssetService,
  | "createNotePackageAssets"
  | "createPackageAssets"
  | "purgeAssets"
  | "readPackageImage"
  | "readPackageCover"
  | "resolvePackageImages"
  | "scanAndRepair"
  | "stageTextProjection"
  | "verifyPackageImages"
  | "verifyPackageVideo"
>;

/**
 * 自动发布用到的那部分 `SauRunner`。单独取 Pick 而不是整类，
 * 是为了让测试能注入只实现这几步的假引擎，也让依赖面一目了然。
 */
export type AutoPublishRunner = Pick<SauRunner,
  | "assertConfigured"
  | "checkLogin"
  | "prepareAccountFile"
  | "runUploadNote"
  | "syncBackCookies"
  | "verifyCodeFilePath"
>;

export interface PublishingServiceDependencies {
  storageRoot: string;
  jobs: JobReader;
  store: Store;
  assets: Assets;
  copy: CopyService;
  /** 抖音图文自动发布的外部引擎；未注入时按「未配置」明确报错。 */
  sau?: AutoPublishRunner;
  now?: () => Date;
  createId?: () => string;
  resolveVideo?: typeof resolveJobVideo;
}

type ServiceErrorCode =
  | "publish_asset_broken"
  | "publish_auto_publish_code_unexpected"
  | "publish_auto_publish_in_progress"
  | "publish_images_unusable"
  | "publish_note_platform_unsupported"
  | "publish_not_a_note_package"
  | "publish_sau_not_configured"
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
  publish_sau_not_configured: SAU_INSTALL_GUIDANCE,
  publish_asset_broken: "发布包视频资产异常，无法执行此操作",
  publish_auto_publish_code_unexpected: "该任务当前没有在等待短信验证码",
  publish_auto_publish_in_progress: "该任务的图文自动发布正在进行中，请等本次结束后再试",
  publish_images_unusable: "图文包的图片素材不完整，请重新生成或选择图片后再发布",
  publish_note_platform_unsupported: "该平台尚未接入图文发布，目前只支持抖音图文",
  publish_not_a_note_package: "该发布包不是图文包，无法执行抖音图文自动发布",
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

  async preview(
    jobId: string,
    platforms: PublishPlatform[],
    contentType: PackageContentType = "video",
  ): Promise<PublishingPreview> {
    const selected = validatePlatformSelection(platforms);
    if (contentType === "note") return this.previewNotePackage(jobId, selected);
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
        contentType: "video",
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
      if ((input.contentType ?? "video") === "note") {
        return await this.createNote(input, context, selected, actor);
      }

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

  /**
   * 图文包的创建前预览：列出将被打包的场景静帧，并给出压缩到图文口径的默认文案。
   *
   * 抖音图文标题上限 20 字（视频是 55），所以默认文案由视频口径的文案**压缩**而来；
   * 「是否被压缩过」要回给界面（spec §5 要求标注「已压缩，可编辑」）。
   */
  private async previewNotePackage(jobId: string, selected: PublishPlatform[]): Promise<PublishingPreview> {
    assertNotePlatforms(selected);
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

      const snapshots = await this.listSceneSnapshots(jobId);
      const videoCopy = copyPreview.copies.douyin ?? { title: "", description: "", hashtags: [] };
      const compressed = compressNoteTitle(videoCopy.title || context.cleaned.title || "", SAU_NOTE_MAX_TITLE);
      const noteCopy: PlatformCopy = {
        title: compressed.title,
        description: videoCopy.description,
        hashtags: [...videoCopy.hashtags],
      };

      return {
        sourceJobId: jobId,
        nextVersion,
        previewRevision: sourceRevision(jobId, context, selected, snapshots.map((snapshot) => snapshot.name)),
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
        expectedPackagePath: path.join(this.storageRoot, "output", "publishing", jobId, `v${nextVersion}-preview`),
        contentType: "note",
        images: snapshots.map((snapshot) => ({ name: snapshot.name, size: snapshot.size })),
        noteCopy,
        noteCopyTitleCompressed: compressed.compressed,
      };
    } finally {
      await context.video.close().catch(() => undefined);
    }
  }

  /** 场景静帧的规范化清单（场景序），供图文预览与打包共用同一份顺序。 */
  private async listSceneSnapshots(jobId: string): Promise<Array<{ name: string; size: number }>> {
    const absolutePaths = await collectSceneSnapshots(this.storageRoot, jobId);
    const snapshots: Array<{ name: string; size: number }> = [];
    for (const absolutePath of absolutePaths) {
      const stats = await stat(absolutePath).catch(() => undefined);
      if (!stats || !stats.isFile() || stats.size === 0) continue;
      snapshots.push({ name: path.basename(absolutePath), size: stats.size });
    }
    return snapshots;
  }

  /**
   * 包级预览：把「将要发出去的内容」摊开给操作者看（spec §14）。
   *
   * 文案校验在这里一次算好（图文包按**图文口径**用 `noteCopy`、视频包按各平台视频口径
   * 用任务文案），前端只渲染 `actual/limit/over` 与 `violations` —— 渲染层是独立 TS 工程、
   * 引用不到 `src/lib`，所以规则必须留在服务端，否则两边会各写一份长度规则慢慢漂移。
   */
  async packagePreview(packageId: string): Promise<PublishingPackagePreview> {
    const detail = await this.requirePackage(packageId);
    const packageRecord = detail.package;
    const contentType = packageRecord.contentType ?? "video";
    const preview: PublishingPackagePreview = {
      package: {
        id: packageRecord.id,
        sourceJobId: packageRecord.sourceJobId,
        version: packageRecord.version,
        state: packageRecord.state,
        title: packageRecord.title,
        packagePath: packageRecord.packagePath,
        contentType,
        assetHealth: packageRecord.assetHealth,
        createdBy: structuredClone(packageRecord.createdBy),
        createdAt: packageRecord.createdAt,
        updatedAt: packageRecord.updatedAt,
      },
      previewRevision: packagePreviewRevision(packageRecord, detail.tasks),
      copyChecks: [],
      tasks: detail.tasks.map((task) => ({
        id: task.id,
        platform: task.platform,
        status: task.status,
        contentRevision: task.contentRevision,
        ...(task.scheduledAt === undefined ? {} : { scheduledAt: task.scheduledAt }),
        copy: { title: task.title, description: task.description, hashtags: [...task.hashtags] },
      })),
    };

    if (contentType === "note") {
      preview.imagePaths = [...(packageRecord.imagePaths ?? [])];
      const noteCopy = packageRecord.noteCopy ?? {
        title: packageRecord.title,
        description: "",
        hashtags: [],
      };
      preview.noteCopy = { ...noteCopy, hashtags: [...noteCopy.hashtags] };
      const platform = detail.tasks[0]?.platform ?? "douyin";
      preview.copyChecks.push(copyCheck(platform, "package", preview.noteCopy, undefined, true));
    } else {
      preview.video = {
        path: packageRecord.videoPath ?? "",
        sha256: packageRecord.videoSha256,
        size: packageRecord.videoSize,
        method: packageRecord.videoMethod,
        hasCover: Boolean(packageRecord.coverPath),
      };
      for (const task of detail.tasks) {
        preview.copyChecks.push(copyCheck(
          task.platform,
          "task",
          { title: task.title, description: task.description, hashtags: [...task.hashtags] },
          task.id,
          false,
        ));
      }
    }
    return preview;
  }

  /** 读取图文包的某张图；序号对不上或图片缺失时返回 `null`（路由决定 404）。 */
  async readPackageImage(
    packageId: string,
    index: number,
  ): Promise<{ bytes: Buffer; extension: string } | null> {
    const detail = await this.requirePackage(packageId);
    if ((detail.package.contentType ?? "video") !== "note") return null;
    return this.deps.assets.readPackageImage(detail.package, index);
  }

  async verifyPackage(packageId: string): Promise<DeliveryPackage["assetHealth"]> {
    const detail = await this.requirePackage(packageId);
    return this.deps.assets.verifyPackageVideo(detail.package);
  }

  /**
   * 把一条图文任务提交给抖音（外部 `sau` CLI），记录结果。
   *
   * 关键不变式：**退出码 0 只记 `succeeded`（已提交），绝不写 `published`**。
   * 是否真的发出去了，仍由人工点「标记已发布」确认 —— 上游在等 URL 跳转时会
   * `force=True` 再点一次发布，重复发布是本功能最大的风险（spec §9）。
   *
   * 校验顺序刻意如此：所有「不该产生记录」的检查都在 `beginAutoPublish` 之前或之内完成，
   * 因此缺 previewRevision / 过期 revision / 缺配置 / 缺图这四种失败都不会留下 autoPublish 记录。
   */
  async autoPublish(
    taskId: string,
    input: { previewRevision: string },
    actor: ActorSnapshot,
  ): Promise<PublishTask> {
    const task = await this.requireTask(taskId);
    const detail = await this.requirePackage(task.packageId);

    // 先判输入类别、再判配置：视频包不是「配置问题」，无论 sau 配没配都该报同一个明确错误。
    if ((detail.package.contentType ?? "video") !== "note") {
      throw new PublishingServiceError(422, "publish_not_a_note_package");
    }
    const runner = this.requireSauRunner();

    // 图片必须在提交前是完好的：界面会禁用缺图的包，但接口仍可被直接调用。
    if (await this.deps.assets.verifyPackageImages(detail.package) !== "healthy") {
      throw new PublishingServiceError(422, "publish_images_unusable");
    }
    const imagePaths = await this.deps.assets.resolvePackageImages(detail.package);
    const noteCopy = detail.package.noteCopy;

    const attemptId = this.createId();
    await this.storeCall(() => this.deps.store.beginAutoPublish(
      taskId,
      { previewRevision: input.previewRevision, attemptId },
      actor,
    ));

    try {
      const precheck = await runner.checkLogin();
      if (!precheck.ok) {
        return await this.finishAutoPublish(taskId, {
          status: "failed",
          message: `登录态预检未通过：${summarizeCliOutput(precheck.output)}`,
        }, actor);
      }

      await runner.prepareAccountFile();
      const upload = await runner.runUploadNote({
        imagePaths,
        title: noteCopy?.title ?? task.title,
        note: noteCopy?.description ?? task.description,
        tags: noteCopy?.hashtags ?? task.hashtags,
      });

      if (upload.ok) {
        // sau 会回写刷新后的 cookie；回写失败不影响「已提交」这个事实。
        await runner.syncBackCookies().catch(() => undefined);
        return await this.finishAutoPublish(taskId, {
          status: "succeeded",
          message: `已提交：${summarizeCliOutput(upload.output)}`,
        }, actor);
      }
      if (upload.needsVerificationCode) {
        return await this.finishAutoPublish(taskId, {
          status: "awaiting_code",
          message: summarizeCliOutput(upload.output),
        }, actor);
      }
      return await this.finishAutoPublish(taskId, {
        status: "failed",
        message: summarizeCliOutput(upload.output) || `sau 以退出码 ${upload.exitCode} 结束`,
      }, actor);
    } catch (error) {
      // 引擎侧的可预期失败（Cookie 文件不可读、参数不合法……）记为该次尝试失败，
      // 绝不能把任务永远留在 running。
      if (error instanceof SauRunnerError) {
        return await this.finishAutoPublish(taskId, { status: "failed", message: error.message }, actor);
      }
      throw error;
    }
  }

  /**
   * 把短信验证码投喂给正在等待的 `sau` 进程。
   *
   * 注意（2026-09-17 从上游源码实测）：`verify_code.txt` 只有上游**视频**发布通路会读，
   * `upload-note` 通路既不读该文件、发布循环也没有次数上限。所以图文发布遇到短信挑战的
   * 实际结局是「一直循环到超时 → failed」，而不是真的在这里被喂进去。这条通路按 spec §7
   * 保留接口，等上游补齐 note 侧支持即可生效。
   */
  async submitAutoPublishCode(taskId: string, code: string, actor: ActorSnapshot): Promise<PublishTask> {
    const runner = this.requireSauRunner();
    const task = await this.requireTask(taskId);
    if (task.autoPublish?.status !== "awaiting_code") {
      throw new PublishingServiceError(409, "publish_auto_publish_code_unexpected");
    }

    const codeFile = runner.verifyCodeFilePath;
    await mkdir(path.dirname(codeFile), { recursive: true }).catch(() => undefined);
    await writeFile(codeFile, code, "utf8");
    return this.storeCall(() => this.deps.store.recordAutoPublishCode(taskId, actor));
  }

  private async finishAutoPublish(
    taskId: string,
    patch: { status: "awaiting_code" | "succeeded" | "failed"; message?: string },
    actor: ActorSnapshot,
  ): Promise<PublishTask> {
    return this.storeCall(() => this.deps.store.updateAutoPublish(taskId, patch, actor));
  }

  private requireSauRunner(): AutoPublishRunner {
    const runner = this.deps.sau;
    if (!runner) throw new PublishingServiceError(422, "publish_sau_not_configured");
    // 缺 `sauBinary` 时同样在写入任何记录之前失败。
    runner.assertConfigured();
    return runner;
  }

  async getFinderVideoPath(packageId: string): Promise<string> {
    const detail = await this.requirePackage(packageId);
    assertActivePackage(detail.package);
    if (await this.deps.assets.verifyPackageVideo(detail.package) === "broken_video" || !detail.package.videoPath) {
      throw new PublishingServiceError(422, "publish_asset_broken");
    }
    return detail.package.videoPath;
  }

  /**
   * 「预留版本 → 建任务 → 打包 → 落库 → 失败回滚」的共用骨架。
   *
   * 视频与图文只在 `build` 上不同（一个 copy 成片、一个 copy 静帧），
   * 而这段编排里的回滚与一致性错误处理很微妙（漏一次 rollback 就留下孤儿包目录），
   * 所以只留一份实现 —— 与 assets 层「安全校验只允许有一个真源」同一个原则。
   */
  private async commitNewPackage(input: {
    sourceJobId: string;
    title: string;
    drafts: ValidatedDraft[];
    actor: ActorSnapshot;
    build: (context: {
      packageId: string;
      version: number;
      tasks: PublishTask[];
      timestamp: string;
    }) => Promise<{ record: DeliveryPackage; rollback: () => Promise<void> }>;
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

    const { record, rollback } = await input.build({ packageId, version, tasks, timestamp });

    try {
      return await this.deps.store.commitPackage({ package: record, tasks }, input.actor);
    } catch (error) {
      try {
        await rollback();
      } catch {
        throw new PublishingServiceError(500, "publish_consistency_failed", undefined, {
          failedStages: ["index_commit", "asset_rollback"],
          recovery: "startup_scan",
        });
      }
      throw normalizeOperationError(error, "index");
    }
  }

  /**
   * 图文创建：先按**图文口径**校验包级文案，再核对（含图片集合的）previewRevision，
   * 最后把平台任务文案同步成 `noteCopy` —— 任务只是排期/审计载体，图文真正发出去的是包级文案。
   */
  private async createNote(
    input: CreatePublishingPackageInput,
    context: SourceContext,
    selected: PublishPlatform[],
    actor: ActorSnapshot,
  ): Promise<PublishingPackageDetail> {
    assertNotePlatforms(selected);
    if (!input.noteCopy) {
      throw new PublishingServiceError(400, "publish_validation_failed", "图文包必须提供 noteCopy 文案");
    }
    const noteCopy = normalizePlatformCopy(input.noteCopy);
    const violations = selected.flatMap((platform) => validateNoteCopy(platform, noteCopy));
    if (violations.length > 0) {
      throw new PublishingServiceError(
        422,
        "publish_validation_failed",
        violations[0].message,
        { violations },
      );
    }

    const snapshots = await this.listSceneSnapshots(input.sourceJobId);
    const currentRevision = sourceRevision(
      input.sourceJobId,
      context,
      selected,
      snapshots.map((snapshot) => snapshot.name),
    );
    if (currentRevision !== input.previewRevision) {
      throw new PublishingServiceError(409, "publish_revision_conflict", undefined, {
        expectedRevision: input.previewRevision,
        currentRevision,
      });
    }

    const sourceKey = sourceContextRevision(input.sourceJobId, context);
    const drafts = validateDrafts(
      selected.map((platform) => ({ platform, copy: noteCopy })),
      this.now(),
      (platform, copy) => this.copyAttestations.get(copyAttestationKey(sourceKey, platform, copy)) ?? "user_edited",
    );
    return this.createNotePackage({
      sourceJobId: input.sourceJobId,
      title: requireTitle(input.title),
      noteCopy,
      drafts,
      actor,
    });
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
    return this.commitNewPackage({
      sourceJobId: input.sourceJobId,
      title: input.title,
      drafts: input.drafts,
      actor: input.actor,
      build: async ({ packageId, version, tasks, timestamp }) => {
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
        return {
          record: {
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
          },
          rollback: assets.rollback,
        };
      },
    });
  }

  /**
   * 创建图文包：走 `createNotePackageAssets`（按场景序复制静帧进包）。
   *
   * note 包的 `video*` 字段「不适用」（spec §5），因此用**图片清单哈希**充当等价完整性凭据，
   * `videoMethod` 记 `copy`、`videoSize` 记图片总字节 —— 诚实反映「不是成片」而不是留空。
   */
  private async createNotePackage(input: {
    sourceJobId: string;
    title: string;
    noteCopy: PlatformCopy;
    drafts: ValidatedDraft[];
    actor: ActorSnapshot;
  }): Promise<PublishingPackageDetail> {
    return this.commitNewPackage({
      sourceJobId: input.sourceJobId,
      title: input.title,
      drafts: input.drafts,
      actor: input.actor,
      build: async ({ packageId, version, tasks, timestamp }) => {
        const assets = await this.deps.assets.createNotePackageAssets({
          packageId,
          sourceJobId: input.sourceJobId,
          version,
          noteCopy: input.noteCopy,
          title: input.title,
          tasks,
          actor: input.actor,
        });
        return {
          record: {
            id: packageId,
            sourceJobId: input.sourceJobId,
            version,
            state: "active",
            title: input.title,
            packagePath: assets.packagePath,
            videoSha256: assets.imageManifestSha256,
            videoSize: assets.imageSize,
            videoMethod: "copy",
            assetHealth: assets.assetHealth,
            contentType: "note",
            imagePaths: [...assets.imagePaths],
            noteCopy: { ...input.noteCopy, hashtags: [...input.noteCopy.hashtags] },
            createdBy: structuredClone(input.actor),
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          rollback: assets.rollback,
        };
      },
    });
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
  noteImageNames?: string[],
): string {
  const hash = sourceContextHash(jobId, context).update([...platforms].sort().join(","));
  // 图文包的素材本身也是「预览过的内容」：静帧集合或顺序变了，旧 revision 必须失效。
  // 视频路径不传这个参数，因此既有哈希逐字节不变。
  if (noteImageNames) {
    for (const name of noteImageNames) hash.update(`image:${name}\0`);
  }
  return hash.digest("hex");
}

/** 图文发布目前只接通抖音（上游只有 `sau douyin upload-note`）。 */
const NOTE_PLATFORMS = new Set<PublishPlatform>(["douyin"]);

function assertNotePlatforms(platforms: PublishPlatform[]): void {
  for (const platform of platforms) {
    if (!NOTE_PLATFORMS.has(platform)) {
      throw new PublishingServiceError(
        422,
        "publish_note_platform_unsupported",
        `平台 ${platform} 尚未接入图文发布，目前只支持抖音图文`,
      );
    }
  }
}

/** 把源标题压到图文口径（按码点截断），并告知是否真的截断过。 */
function compressNoteTitle(title: string, limit: number): { title: string; compressed: boolean } {
  const characters = [...(title ?? "").trim()];
  if (characters.length <= limit) return { title: characters.join(""), compressed: false };
  return { title: characters.slice(0, limit).join(""), compressed: true };
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

/**
 * 按口径生成一份文案检查结果。
 *
 * `noteScope` 为真时用图文口径（抖音 title ≤20），否则用视频口径（title ≤55）——
 * 校验本身仍走 Task 1 收敛后的 `validateNoteCopy` / `validatePlatformCopy`，这里不重写规则。
 */
function copyCheck(
  platform: PublishPlatform,
  scope: "package" | "task",
  copy: PlatformCopy,
  taskId: string | undefined,
  noteScope: boolean,
): PublishingPreviewCopyCheck {
  const policy: PlatformPolicy = (noteScope ? PUBLISH_NOTE_POLICIES[platform] : undefined)
    ?? PUBLISH_PLATFORMS[platform];
  const normalized = normalizePlatformCopy(copy);
  const violations = noteScope ? validateNoteCopy(platform, copy) : validatePlatformCopy(platform, copy);
  const field = (name: keyof PlatformCopy, actual: number, limit: number) => ({
    actual,
    limit,
    over: actual > limit,
  });
  return {
    platform,
    scope,
    ...(taskId === undefined ? {} : { taskId }),
    label: policy.label,
    title: field("title", [...normalized.title].length, policy.titleMax),
    description: field("description", [...normalized.description].length, policy.descriptionMax),
    hashtags: field("hashtags", normalized.hashtags.length, policy.hashtagMax),
    // 话题单个长度上限不便于用「actual/limit」表达，交给 violations 给出原文提示
    violations,
  };
}

/**
 * 把 sau 的原始输出压成适合写进审计与 `autoPublish.message` 的摘要。
 *
 * 两个细节都是实测踩出来的：
 * ① **必须去 ANSI 色码** —— 上游 loguru 给每一行上色，直接落库既难读又白占长度；
 * ② **截断必须保尾** —— `sau` 的正常进度在开头、**失败原因在末尾**。
 *    2026-09-17 真实上传失败时，只保头的实现把「标题输入框 120s 超时」这段丢掉了，
 *    导致界面上只剩一堆 INFO 进度、完全看不出为什么失败。
 */
export function summarizeCliOutput(output: string, maxLength = 500): string {
  const plain = output.replace(/\u001B\[[0-9;]*m/gu, "");
  const flattened = plain.replace(/\s+/gu, " ").trim();
  if (flattened.length <= maxLength) return flattened;
  const head = Math.floor(maxLength / 3);
  const tail = maxLength - head - 1;
  return `${flattened.slice(0, head)}…${flattened.slice(-tail)}`;
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
    case "publish_not_a_note_package":
      return new PublishingServiceError(422, error.code, error.message, error.details);
    case "publish_auto_publish_code_unexpected":
    case "publish_auto_publish_in_progress":
      return new PublishingServiceError(409, error.code, error.message, error.details);
    case "publish_index_corrupt":
      return new PublishingServiceError(500, error.code, error.message, error.details);
    case "publish_invalid_transition":
    case "publish_revision_conflict":
      return new PublishingServiceError(409, error.code, error.message, error.details);
  }
}
