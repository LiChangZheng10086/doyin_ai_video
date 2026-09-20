import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActorSnapshot,
  CreatePublishingPackageInput,
  DeliveryPackage,
  DueNotification,
  JobRecord,
  NoteImageSource,
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
  ToutiaoPublishOptions,
} from "../types.js";
import type { AssetStore, ResolvedAssetFile } from "./assets-store.js";
import type { PublishingCopyService } from "./publishing-copy.js";
import {
  type BoundSourceVideo,
  type PublishingRecoveryReport,
  MAX_NOTE_IMAGES,
  PublishingAssetError,
  PublishingAssetService,
  collectSceneSnapshots,
} from "./publishing-assets.js";
import {
  normalizePlatformCopy,
  PUBLISH_NOTE_POLICIES,
  PUBLISH_PLATFORMS,
  resolveAutoPublishEngine,
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
import {
  TOUTIAO_ARTICLE_LIMITS,
  articleBodyToDraft,
  articleDraftToBodyText,
  articleDraftToPlainParagraphs,
  articleHtmlToBodyText,
  fallbackToutiaoArticle,
  htmlToPlainText,
  renderToutiaoArticleHtml,
  validateToutiaoArticle,
  type ToutiaoArticleDraft,
} from "./toutiao-article.js";
import { ToutiaoRunner, ToutiaoRunnerError } from "./toutiao-runner.js";
import { ToutiaoMediaService } from "./toutiao-media.js";
import type { ArticlePlan, ArticleSourceContext } from "./article-draft.js";
import { SYSTEM_ACTOR } from "./local-users.js";
import { resolveJobVideo, VideoOutputError } from "./video-output.js";

/** 未注入头条执行器时的提示：与 `toutiao-browser.ts` 的解析失败指引同一份文案。 */
const TOUTIAO_BROWSER_GUIDANCE_FOR_SERVICE = [
  "未配置头条号发布执行器（服务端没有注入 ToutiaoRunner）。",
  "若这是测试环境，请注入假执行器；否则请检查 src/app.ts 的装配。",
].join("");

const CLEANED_DIRECTORY = path.join("processed", "cleaned");
const SCRIPT_DIRECTORY = path.join("processed", "scripts");
/**
 * 服务层支持的全部平台。
 *
 * **刻意从 `PUBLISH_PLATFORMS` 派生而不是写字面量**：`Record<PublishPlatform, …>` 是编译器
 * 唯一能兜住的那个真源，派生出来就永远不会漏点。**不要改成 `new Set([...])`** —— 那会把它
 * 变成又一个静默点（有用例断言它与 `PUBLISH_PLATFORMS` 的键集合完全一致）。
 */
export const SUPPORTED_PLATFORMS = new Set<PublishPlatform>(
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
  | "createArticlePackageAssets"
  | "createNotePackageAssets"
  | "createPackageAssets"
  | "purgeAssets"
  | "readPackageArticle"
  | "readPackageImage"
  | "readPackageCover"
  | "resolvePackageImages"
  | "scanAndRepair"
  | "stageTextProjection"
  | "verifyPackageHealth"
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

/**
 * 图文包选图只从素材库**读取**，所以只依赖这一个方法。
 *
 * 收窄依赖面有两个好处：测试注入的假素材库无法顺手改动真实素材；而
 * id → 路径的归属校验仍然只有 `AssetStore.resolveFile` 一个真源
 * （发布中心不自己拼 `assets/` 路径，免得开出第二份安全校验）。
 */
export type AssetLibrary = Pick<AssetStore, "resolveFile">;

/**
 * 头条自动发布用到的那部分 `ToutiaoRunner`（与 sau 同样的 Pick 写法）：
 * 测试注入只实现这几个方法的假引擎，既不启浏览器也不联网。
 */
export type ToutiaoAutoPublishRunner = Pick<
  ToutiaoRunner,
  | "assertConfigured"
  | "checkLogin"
  | "startLogin"
  | "pollLogin"
  | "cancelLogin"
  | "loginInWindow"
  | "publishArticle"
>;

/** 封面处理（测试注入假 ffmpeg）。 */
export type ToutiaoCoverPreparer = Pick<ToutiaoMediaService, "prepareCoverImage">;

/**
 * AI 成文。**注入而不是在服务里建 OpenAI 客户端**：AI 配置的解析归 `app.ts`（与
 * `PublishingCopyService` 同一处），服务层只关心「给我一篇草稿」；测试传假规划器即可。
 */
export type ArticlePlanner = (context: ArticleSourceContext) => Promise<ArticlePlan>;

export interface PublishingServiceDependencies {
  storageRoot: string;
  jobs: JobReader;
  store: Store;
  assets: Assets;
  copy: CopyService;
  /** 素材库：只用于图文包的「从素材库选图」（id → 已校验归属的绝对路径）。 */
  library: AssetLibrary;
  /** 抖音图文自动发布的外部引擎；未注入时按「未配置」明确报错。 */
  sau?: AutoPublishRunner;
  /** 今日头条发布的自研执行器；未注入时按「未配置」明确报错。 */
  toutiao?: ToutiaoAutoPublishRunner;
  /** 头条封面处理（16:9 裁剪）。缺省用真 ffmpeg；测试注入假实现。 */
  toutiaoMedia?: ToutiaoCoverPreparer;
  /** AI 成文（头条文章）。缺省不可用 → 走本地兜底（不阻塞建包）。 */
  planArticle?: ArticlePlanner;
  now?: () => Date;
  createId?: () => string;
  resolveVideo?: typeof resolveJobVideo;
}

type ServiceErrorCode =
  | "publish_asset_broken"
  | "publish_auto_publish_code_unexpected"
  | "publish_auto_publish_in_progress"
  | "publish_auto_publish_unsupported"
  | "publish_article_platform_unsupported"
  | "publish_toutiao_not_configured"
  | "publish_article_unreadable"
  | "publish_toutiao_cover_required"
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
  publish_auto_publish_unsupported: "该内容类型与平台的组合不支持自动发布，请走人工交付",
  publish_article_platform_unsupported: "文章发布目前只接入了今日头条",
  publish_toutiao_not_configured: TOUTIAO_BROWSER_GUIDANCE_FOR_SERVICE,
  publish_article_unreadable: "文章包内的 article.html 缺失或已被改动，请重新创建文章包",
  publish_toutiao_cover_required: "今日头条要求文章必须有封面，请重新创建文章包并选择封面（会自动裁成 16:9）",
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

/** 图文素材选择：来源 + 素材库选择（有序）。两个字段都可省略，省略即「自动静帧」。 */
export interface NoteImageSelection {
  imageSource?: NoteImageSource;
  imageAssetIds?: string[];
}

type NoteImagePlan = {
  source: NoteImageSource;
  /** 参与 `previewRevision` 的指纹键：静帧用文件名、素材库用 asset id，顺序参与哈希。 */
  keys: string[];
  /** 预览要摊给操作者看的图片清单，顺序即入包顺序。 */
  images: Array<{ name: string; size: number; assetId?: string }>;
  /** 仅素材库来源：按选择顺序解析好的绝对路径（静帧由打包层自行收集）。 */
  sourceImagePaths?: string[];
};

/** 缺省与存量请求一律 `frames`；取值非法直接拒绝而不是静默回退。 */
function noteImageSourceOf(selection: NoteImageSelection): NoteImageSource {
  const source = selection.imageSource ?? "frames";
  if (source !== "frames" && source !== "library") {
    throw new PublishingServiceError(400, "publish_validation_failed", "图文素材来源无效，只支持自动静帧或素材库");
  }
  return source;
}

/**
 * 图文文案的字段上限随预览一起下发。
 *
 * 表单要边打字边显示「12/20」，所以字数是**界面自己数**的；但上限必须来自服务端，
 * 否则渲染层会再写一份 20/1000/10 并与后端慢慢漂移（服务端在创建时仍会重新校验）。
 */
function noteCopyLimits(): { titleMax: number; descriptionMax: number; hashtagMax: number } {
  const policy = PUBLISH_NOTE_POLICIES.douyin;
  if (!policy) throw new PublishingServiceError(422, "publish_note_platform_unsupported");
  return { titleMax: policy.titleMax, descriptionMax: policy.descriptionMax, hashtagMax: policy.hashtagMax };
}

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
    images: NoteImageSelection = {},
  ): Promise<PublishingPreview> {
    const selected = validatePlatformSelection(platforms);
    if (contentType === "note") return this.previewNotePackage(jobId, selected, images);
    // 文章通路：**必须显式分派**。少了这一支，`contentType: "article"` 会静默按视频处理，
    // 调用方拿到的是一份视频预览（既有行为就是如此，spec §6.5 记了这个坑）。
    if (contentType === "article") return this.previewArticlePackage(jobId, selected, images);
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
      if ((input.contentType ?? "video") === "article") {
        return await this.createArticle(input, context, selected, actor);
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
      // 这与 createVersion 的输入一致性检查配套：能走到这里的包必然有可用成片
      //（文章/图文包在 `bindPackageVideo` 就已经报错），所以这里用「按类型分派」的入口是安全的。
      const health = await this.deps.assets.verifyPackageHealth(previous.package);
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
    // **按内容类型分派**：文章包没有 `video.mp4`，用视频分支会一律判 `broken_video`
    // → 人工「标记已发布」永远失败，而且写进去的健康值还会把「提交到头条号」动作一起藏起来
    //（本项目交付包健康值有单一真源：`verifyPackageHealth`）。
    if (await this.deps.assets.verifyPackageHealth(detail.package) === "broken_video") {
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
   * 文章包（今日头条）的创建前预览。
   *
   * 三步：AI 成文（失败走本地兜底并带提示）→ 渲染一次（正文长度守卫在这里）→ 解析封面候选。
   * **头条封面必填**，所以封面在预览阶段就要选好；静帧一张都没有时明确报错而不是让用户走到提交才失败。
   */
  private async previewArticlePackage(
    jobId: string,
    selected: PublishPlatform[],
    selection: NoteImageSelection,
  ): Promise<PublishingPreview> {
    assertArticlePlatforms(selected);
    const context = await this.readSourceContext(jobId);
    try {
      const index = await this.deps.store.snapshot();
      const nextVersion = index.nextVersionBySource[jobId] ?? 1;

      const plan = await this.planArticleFor(context);
      const html = renderArticleHtmlOrThrow(plan.draft);
      const body = articleDraftToBodyText(plan.draft);
      const cover = await this.planArticleCover(jobId, selection);
      const copy: PlatformCopy = { title: plan.draft.title, description: body, hashtags: [] };

      return {
        sourceJobId: jobId,
        nextVersion,
        previewRevision: articleSourceRevision(jobId, context, selected, cover.key),
        video: {
          filename: path.basename(context.video.path),
          size: context.video.size,
          width: context.width,
          height: context.height,
          duration: context.duration,
          coverAvailable: Boolean(context.sourceCoverPath),
        },
        copies: {
          toutiao: { ...copy, copySource: plan.copySource === "ai" ? "ai" : "cleaned_fallback" },
        },
        ...(plan.warning ? { warning: { code: plan.warning.code, message: plan.warning.message } } : {}),
        expectedPackagePath: path.join(
          this.storageRoot,
          "output",
          "publishing",
          jobId,
          `v${nextVersion}-preview`,
        ),
        contentType: "article",
        articleCopy: { title: plan.draft.title, body },
        articleLimits: {
          titleMin: TOUTIAO_ARTICLE_LIMITS.titleMin,
          titleMax: TOUTIAO_ARTICLE_LIMITS.titleMax,
          bodyChars: TOUTIAO_ARTICLE_LIMITS.bodyChars,
        },
        // **绝不静默**：AI 成文失败必须让操作者看见（否则会以为这就是 AI 写的）。
        ...(plan.warning ? { articleFallback: { code: plan.warning.code, message: plan.warning.message } } : {}),
        articleCover: cover.preview,
        imageSource: cover.source,
        toutiaoOptions: defaultToutiaoOptions(),
      };
    } finally {
      await context.video.close().catch(() => undefined);
    }
  }

  /** AI 成文；未注入规划器（无 AI 配置）时走本地兜底，不阻塞建包。 */
  private async planArticleFor(context: SourceContext): Promise<ArticlePlan> {
    const planner = this.deps.planArticle;
    if (!planner) return buildArticleFallbackPlan(articleSourceContextOf(context));
    return planner(articleSourceContextOf(context));
  }

  /**
   * 封面候选：**恰好一张**。
   *
   * 与图文包的两点不同：① 头条封面必填，所以「一张都没有」是**错误**（不像 `frames` 图文包那样
   * 允许缺图）；② 只取一张 —— 头条单图封面，多选会让「发出去的是哪张」变得不可预测。
   */
  private async planArticleCover(jobId: string, selection: NoteImageSelection): Promise<ArticleCoverPlan> {
    const source = noteImageSourceOf(selection);
    if (source === "frames") {
      if ((selection.imageAssetIds?.length ?? 0) > 0) {
        throw new PublishingServiceError(
          400,
          "publish_validation_failed",
          "自动静帧来源不接受素材 id，请清空 imageAssetIds 或改用素材库",
        );
      }
      const snapshots = await this.listSceneSnapshots(jobId);
      if (snapshots.length === 0) {
        throw new PublishingServiceError(
          400,
          "publish_validation_failed",
          "这个作品还没有场景静帧，无法作为头条封面（头条要求必须有封面）：请先生成视频，或改用素材库图片作为封面。",
        );
      }
      const first = snapshots[0]!;
      return {
        source,
        key: first.name,
        preview: { name: first.name, size: first.size },
        // 静帧由打包层按同一套场景序自行收集，这里只给出「第一张」的指纹键。
        absolutePath: await this.firstSnapshotPath(jobId),
      };
    }

    const assetIds = selection.imageAssetIds ?? [];
    if (assetIds.length === 0) {
      throw new PublishingServiceError(
        400,
        "publish_validation_failed",
        "请选择一张素材库图片作为封面，或改用自动静帧",
      );
    }
    if (assetIds.length > 1) {
      throw new PublishingServiceError(
        400,
        "publish_validation_failed",
        "头条封面只支持单图，请只选择一张图片",
      );
    }
    const resolved = await this.resolveLibraryImage(assetIds[0]!);
    return {
      source,
      key: `asset:${resolved.record.id}`,
      preview: { name: resolved.record.originalName, size: resolved.size, assetId: resolved.record.id },
      absolutePath: resolved.path,
    };
  }

  private async firstSnapshotPath(jobId: string): Promise<string> {
    const absolutePaths = await collectSceneSnapshots(this.storageRoot, jobId);
    const first = absolutePaths[0];
    if (!first) {
      throw new PublishingServiceError(
        400,
        "publish_validation_failed",
        "这个作品还没有场景静帧，无法作为头条封面（头条要求必须有封面）：请先生成视频，或改用素材库图片作为封面。",
      );
    }
    return first;
  }

  /**
   * 文章创建：校验标题/正文 → 渲染 HTML → 核对（含封面与正文哈希的）previewRevision →
   * 裁 16:9 封面 → 打包。平台任务文案由服务端从文章文案同步生成（客户端不许传两份）。
   */
  private async createArticle(
    input: CreatePublishingPackageInput,
    context: SourceContext,
    selected: PublishPlatform[],
    actor: ActorSnapshot,
  ): Promise<PublishingPackageDetail> {
    assertArticlePlatforms(selected);
    if (!input.articleCopy) {
      throw new PublishingServiceError(
        400,
        "publish_validation_failed",
        "文章包必须提供 articleCopy（标题与正文）",
      );
    }

    const draft = articleBodyToDraft(input.articleCopy.title, input.articleCopy.body);
    // 空正文必须在**创建**阶段拦掉：否则包建得出来，但发布时会在页面上报
    // 「正文没有填进头条编辑器」——那是错误的诊断（真正原因是文章本身没正文）。
    if (draft.sections.every((section) => section.paragraphs.length === 0)) {
      throw new PublishingServiceError(422, "publish_validation_failed", "文章正文不能为空");
    }
    const violations = validateToutiaoArticle(draft);
    if (violations.length > 0) {
      throw new PublishingServiceError(422, "publish_validation_failed", violations[0]!.message, {
        violations,
      });
    }
    const html = renderArticleHtmlOrThrow(draft);
    const cover = await this.planArticleCover(input.sourceJobId, input);

    const currentRevision = articleSourceRevision(input.sourceJobId, context, selected, cover.key);
    if (currentRevision !== input.previewRevision) {
      throw new PublishingServiceError(409, "publish_revision_conflict", undefined, {
        expectedRevision: input.previewRevision,
        currentRevision,
      });
    }

    const copy: PlatformCopy = {
      title: draft.title,
      description: articleDraftToBodyText(draft),
      hashtags: [],
    };
    const drafts = validateDrafts(
      selected.map((platform) => ({ platform, copy })),
      this.now(),
      () => "user_edited",
    );

    return this.createArticlePackage({
      sourceJobId: input.sourceJobId,
      title: requireTitle(input.title),
      draft,
      html,
      cover,
      options: normalizeToutiaoOptions(input.toutiaoOptions),
      drafts,
      actor,
    });
  }

  /**
   * 打包文章包：封面先由 `toutiao-media` 裁成 16:9 落到**临时目录**，再交给打包层复制进包。
   *
   * 临时目录必须清理（`finally`）：封面源是用户的静帧或素材库图片，中间产物不该留在磁盘上。
   * article 包的 `video*` 字段与 note 包同口径，承载**图片清单哈希**（v1 没有正文图，即空清单哈希），
   * 正文的完整性凭据在 `articleCopy.htmlSha256`。
   */
  private async createArticlePackage(input: {
    sourceJobId: string;
    title: string;
    draft: ToutiaoArticleDraft;
    html: string;
    cover: ArticleCoverPlan;
    options: ToutiaoPublishOptions;
    drafts: ValidatedDraft[];
    actor: ActorSnapshot;
  }): Promise<PublishingPackageDetail> {
    return this.commitNewPackage({
      sourceJobId: input.sourceJobId,
      title: input.title,
      drafts: input.drafts,
      actor: input.actor,
      build: async ({ packageId, version, tasks, timestamp }) => {
        const workDir = path.join(this.storageRoot, "cache", "tmp", `toutiao-cover-${packageId}`);
        try {
          const prepared = await this.requireToutiaoMedia().prepareCoverImage(input.cover.absolutePath, workDir);
          const assets = await this.deps.assets.createArticlePackageAssets({
            packageId,
            sourceJobId: input.sourceJobId,
            version,
            articleHtml: input.html,
            sourceCoverPath: prepared.path,
            articleCopy: { title: input.draft.title },
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
              ...(assets.coverPath ? { coverPath: assets.coverPath } : {}),
              videoSha256: assets.imageManifestSha256,
              videoSize: assets.imageSize,
              videoMethod: "copy",
              assetHealth: assets.assetHealth,
              contentType: "article",
              imagePaths: [...assets.imagePaths],
              articleCopy: { title: input.draft.title, htmlSha256: assets.htmlSha256 },
              toutiaoOptions: { ...input.options, declarations: [...input.options.declarations] },
              createdBy: structuredClone(input.actor),
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            rollback: assets.rollback,
          };
        } finally {
          await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    });
  }

  /** 读取文章包的 HTML（降级通路与提交前的完整性校验共用）。 */
  async readPackageArticleHtml(packageId: string): Promise<{ bytes: Buffer; htmlSha256: string } | null> {
    const detail = await this.requirePackage(packageId);
    if ((detail.package.contentType ?? "video") !== "article") return null;
    const bytes = await this.deps.assets.readPackageArticle(detail.package);
    return bytes ? { bytes, htmlSha256: sha256Hex(bytes) } : null;
  }

  /** 零副作用登录态自检（设置页「校验登录」）。 */
  async verifyToutiaoLogin(): Promise<{ loggedIn: boolean; username?: string; message: string }> {
    const runner = this.requireToutiaoRunner();
    const state = await runner.checkLogin();
    return state.loggedIn
      ? { loggedIn: true, ...(state.username ? { username: state.username } : {}), message: "头条号登录态有效" }
      : {
          loggedIn: false,
          message:
            "头条号登录态已失效：请到「设置 → 今日头条」点「扫码登录」，用今日头条 App 扫码后重试。"
            + "（重新扫码不需要重启应用。）",
        };
  }

  async startToutiaoLogin(): Promise<{ qrDataUrl: string; startedAt: string; expiresAt: string }> {
    return this.requireToutiaoRunner().startLogin();
  }

  async pollToutiaoLogin(): Promise<{ status: "idle" | "waiting" | "logged_in" | "expired"; username?: string }> {
    return this.requireToutiaoRunner().pollLogin();
  }

  async cancelToutiaoLogin(): Promise<void> {
    await this.requireToutiaoRunner().cancelLogin();
  }

  /**
   * 打开浏览器窗口扫码登录（与抖音那套同一交互）。
   *
   * 同步请求：挂着直到扫码成功或超时。要注意它与「应用内扫码」互斥 ——
   * 窗口登录期间如果用户又去点应用内扫码，会去开第二个浏览器；所以这里先取消掉内存里的会话。
   */
  async loginToutiaoInWindow(): Promise<{ loggedIn: boolean; username?: string; message: string }> {
    const runner = this.requireToutiaoRunner();
    await runner.cancelLogin().catch(() => undefined);
    return runner.loginInWindow();
  }

  /**
   * 把一篇文章提交到头条号（自研执行器），记录结果。
   *
   * 关键不变式与抖音通路一致：**点了「发布」也只记 `succeeded`（已提交），绝不写 `published`**；
   * 是否真的发出去了由人工点「标记已发布」确认。差异在于头条没有短信验证码通路，
   * 所以补偿手段是**独立的结果校验**（`verification`）：拿不到判据时如实写进消息，
   * 提醒操作者先去后台核实再重试（重复发布是本功能最大的风险）。
   *
   * 校验顺序与抖音通路一致：所有「不该产生记录」的检查都在 `beginAutoPublish` 之前或之内完成。
   */
  private async autoPublishToutiaoArticle(
    taskId: string,
    input: { previewRevision: string },
    actor: ActorSnapshot,
  ): Promise<PublishTask> {
    const task = await this.requireTask(taskId);
    const detail = await this.requirePackage(task.packageId);
    const packageRecord = detail.package;

    // 头条封面必填：缺封面在这里就拦住，而不是等平台报错。
    if (!packageRecord.coverPath || packageRecord.assetHealth === "missing_cover") {
      throw new PublishingServiceError(422, "publish_toutiao_cover_required");
    }
    const runner = this.requireToutiaoRunner();

    const article = await this.readPackageArticleHtml(packageRecord.id);
    if (!article || article.htmlSha256 !== packageRecord.articleCopy?.htmlSha256) {
      throw new PublishingServiceError(422, "publish_article_unreadable");
    }
    const coverBytes = await this.deps.assets.readPackageCover(packageRecord);
    if (!coverBytes) {
      throw new PublishingServiceError(422, "publish_toutiao_cover_required");
    }

    const attemptId = this.createId();
    // 包级 revision 的比对与并发互斥都在这一次 mutate 里完成（失败不写盘）。
    await this.storeCall(() => this.deps.store.beginAutoPublish(
      taskId,
      { previewRevision: input.previewRevision, attemptId },
      actor,
    ));

    const workDir = path.join(this.storageRoot, "cache", "tmp", `toutiao-publish-${attemptId}`);
    try {
      await mkdir(workDir, { recursive: true });
      const coverPath = path.join(workDir, "cover.jpg");
      await writeFile(coverPath, coverBytes);

      const state = await runner.checkLogin();
      if (!state.loggedIn) {
        return await this.finishAutoPublish(taskId, {
          status: "failed",
          message: "头条号登录态已失效：请到「设置 → 今日头条」重新扫码登录后再试。",
        }, actor);
      }

      const options = normalizeToutiaoOptions(packageRecord.toutiaoOptions);
      const result = await runner.publishArticle({
        title: packageRecord.articleCopy?.title ?? task.title,
        articleHtml: article.bytes.toString("utf8"),
        articleText: htmlToPlainText(article.bytes.toString("utf8")),
        coverPath,
        firstPublish: options.firstPublish,
        declarations: options.declarations,
        crossPostWeitoutiao: options.crossPostWeitoutiao,
      });

      if (!result.ok) {
        return await this.finishAutoPublish(taskId, { status: "failed", message: result.message }, actor);
      }
      return await this.finishAutoPublish(taskId, {
        status: "succeeded",
        // 未确认时**不再加前缀**：runner 的文案本身就以「已点击发布，但未能从页面确认结果…」开头，
        // 再加「已提交，但」会变成「已提交，但已点击发布，但…」（真机记录里就是这个双「但」）。
        message: result.verification === "confirmed" ? `已提交：${result.message}` : result.message,
      }, actor);
    } catch (error) {
      // **任何**异常都必须落成 `failed` 记录，不能抛出去。`publishArticle` 自己已经把页面步骤与
      // Playwright 异常收敛成 `ok:false`，但它的第一行 `openSession()` 在它的 try **之外**：
      // 「浏览器起不来 / 会话目录不可写」这类错误会直接落到这里。此前这里只认
      // `ToutiaoRunnerError`、其余原样抛出 → 路由层兜底 **500**，而 `autoPublish` 会停在
      // `running`（界面只显示「正在进行中」、按钮灰掉）直到 30 分钟僵死阈值才能重试 ——
      // 2026-09-18 应用内那个 EPERM 就是这条路径。
      return await this.finishAutoPublish(taskId, {
        status: "failed",
        message: error instanceof ToutiaoRunnerError
          ? error.message
          : `头条发布过程中出现意外错误：${error instanceof Error ? error.message : String(error)}`,
      }, actor);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private requireToutiaoRunner(): ToutiaoAutoPublishRunner {
    const runner = this.deps.toutiao;
    if (!runner) throw new PublishingServiceError(422, "publish_toutiao_not_configured");
    // 解析不到浏览器时同样在写入任何记录之前失败。
    runner.assertConfigured();
    return runner;
  }

  private requireToutiaoMedia(): ToutiaoCoverPreparer {
    if (!this.deps.toutiaoMedia) return new ToutiaoMediaService();
    return this.deps.toutiaoMedia;
  }

  /**
   * 图文包的创建前预览：列出将被打包的场景静帧，并给出压缩到图文口径的默认文案。
   *
   * 抖音图文标题上限 20 字（视频是 55），所以默认文案由视频口径的文案**压缩**而来；
   * 「是否被压缩过」要回给界面（spec §5 要求标注「已压缩，可编辑」）。
   */
  private async previewNotePackage(
    jobId: string,
    selected: PublishPlatform[],
    images: NoteImageSelection,
  ): Promise<PublishingPreview> {
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

      const plan = await this.planNoteImages(jobId, images);
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
        previewRevision: sourceRevision(jobId, context, selected, plan.keys),
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
        imageSource: plan.source,
        images: plan.images,
        imageLimit: MAX_NOTE_IMAGES,
        copyLimits: noteCopyLimits(),
        noteCopy,
        noteCopyTitleCompressed: compressed.compressed,
      };
    } finally {
      await context.video.close().catch(() => undefined);
    }
  }

  /**
   * 图文素材：把「来源 + 选择」解析成**指纹键**与**预览清单**（素材库还解析出真实路径）。
   *
   * 三条不变式：
   * - 顺序即入包顺序（静帧按场景号、素材库按用户点选顺序），并**参与 `previewRevision`** ——
   *   调换顺序或换来源会让旧 revision 失效，与「预览过的内容才允许发布」同一条约束。
   * - 静帧路径不在这里解析：打包层按同一套场景序自行收集，避免出现两份顺序真源。
   * - 素材库的「一张没选」报错，而静帧的「一张都没有」不报错 —— 后者沿用 ② 已定的口径
   *   （包仍自包含地建出来，只标 `missing_images`），前者是客户端请求不自洽。
   */
  private async planNoteImages(jobId: string, selection: NoteImageSelection): Promise<NoteImagePlan> {
    const source = noteImageSourceOf(selection);
    if (source === "frames") {
      if ((selection.imageAssetIds?.length ?? 0) > 0) {
        throw new PublishingServiceError(
          400,
          "publish_validation_failed",
          "自动静帧来源不接受素材 id，请清空 imageAssetIds 或改用素材库",
        );
      }
      const snapshots = await this.listSceneSnapshots(jobId);
      return { source, keys: snapshots.map((snapshot) => snapshot.name), images: snapshots };
    }

    const assetIds = selection.imageAssetIds ?? [];
    if (assetIds.length === 0) {
      throw new PublishingServiceError(
        400,
        "publish_validation_failed",
        "请至少选择一张素材库图片，或改用自动静帧",
      );
    }
    // 上限检查必须早于逐个解析：否则 40 个不存在的 id 会先报成「素材不存在」
    if (assetIds.length > MAX_NOTE_IMAGES) {
      throw new PublishingAssetError("publish_too_many_images");
    }

    const images: NoteImagePlan["images"] = [];
    const sourceImagePaths: string[] = [];
    for (const assetId of assetIds) {
      const resolved = await this.resolveLibraryImage(assetId);
      images.push({ name: resolved.record.originalName, size: resolved.size, assetId: resolved.record.id });
      sourceImagePaths.push(resolved.path);
    }
    return { source, keys: assetIds.map((assetId) => `asset:${assetId}`), images, sourceImagePaths };
  }

  /** 单个素材：必须存在、必须是图片，并且由 `AssetStore` 保证路径落在 `assets/` 内。 */
  private async resolveLibraryImage(assetId: string): Promise<ResolvedAssetFile> {
    const resolved = await this.deps.library.resolveFile(assetId);
    if (!resolved) {
      throw new PublishingServiceError(
        422,
        "publish_images_unusable",
        "选中的素材已不存在，请重新选择图片",
      );
    }
    if (resolved.record.kind !== "image") {
      throw new PublishingServiceError(
        400,
        "publish_validation_failed",
        "图文素材只能选择图片，音频暂不能用于图文发布",
      );
    }
    return resolved;
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
      preview.copyChecks.push(copyCheck(platform, "package", preview.noteCopy, undefined, "note"));
    } else if (contentType === "article") {
      // 文章包：正文在包内 `article.html`，这里摊成纯文本给操作者看（spec §14.1：
      // 预览的意义就是「看得见将要发出去的内容」）。封面走既有 `/cover` 路由。
      const articleCopy = packageRecord.articleCopy ?? { title: packageRecord.title, htmlSha256: "" };
      const html = await this.deps.assets.readPackageArticle(packageRecord);
      // 展示**正文文本**（带 `## ` 小标题标记），与创建向导里看到的形态一致：
      // 包记录只存 title + htmlSha256，正文只能从 `article.html` 还原。
      const body = html ? articleHtmlToBodyText(html.toString("utf8")) : "";
      preview.articleCopy = { title: articleCopy.title, body };
      preview.articleLimits = {
        titleMin: TOUTIAO_ARTICLE_LIMITS.titleMin,
        titleMax: TOUTIAO_ARTICLE_LIMITS.titleMax,
        bodyChars: TOUTIAO_ARTICLE_LIMITS.bodyChars,
      };
      preview.toutiaoOptions = normalizeToutiaoOptions(packageRecord.toutiaoOptions);
      const platform = detail.tasks[0]?.platform ?? "toutiao";
      // 用**平台政策**（`PUBLISH_PLATFORMS.toutiao` 就是文章口径：titleMax 30 / 正文 20000），
      // 不是图文政策 —— `PUBLISH_NOTE_POLICIES` 里没有 toutiao，走图文口径会直接抛错。
      preview.copyChecks.push(
        copyCheck(platform, "package", { title: articleCopy.title, description: body, hashtags: [] }, undefined, "platform"),
      );
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
          "platform",
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
    // 按内容类型分派：文章/图文包走各自的口径，否则一查就是「视频资产异常」。
    return this.deps.assets.verifyPackageHealth(detail.package);
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

    // **先判输入类别、再判配置**：视频包不是「配置问题」，无论 sau/浏览器配没配都该报同一个明确错误。
    // 分派只问那张唯一真源的路由表（`AUTO_PUBLISH_ROUTES`），两个通路各走各的。
    const contentType = detail.package.contentType ?? "video";
    const engine = resolveAutoPublishEngine(contentType, task.platform);
    if (engine === null) {
      throw new PublishingServiceError(
        422,
        // 视频包保留**既有的错误码**（既有用例逐字断言它），其余未登记组合给更准确的新码。
        contentType === "video" ? "publish_not_a_note_package" : "publish_auto_publish_unsupported",
        undefined,
        { contentType, platform: task.platform },
      );
    }
    if (engine === "toutiao") {
      return this.autoPublishToutiaoArticle(taskId, input, actor);
    }
    return this.autoPublishNoteTask(taskId, input, actor, detail);
  }

  /**
   * 抖音图文通路：外部 `sau` CLI。
   *
   * 与头条通路分开成两个方法（而不是一个方法里 if/else）：两条通路的**凭据、校验、结果形状**
   * 完全不同，混在一起会让「先判类别再判配置」这条纪律更容易被写错。
   */
  private async autoPublishNoteTask(
    taskId: string,
    input: { previewRevision: string },
    actor: ActorSnapshot,
    detail: PublishingPackageDetail,
  ): Promise<PublishTask> {
    const task = await this.requireTask(taskId);
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

    const snapshots = await this.planNoteImages(input.sourceJobId, input);
    const currentRevision = sourceRevision(input.sourceJobId, context, selected, snapshots.keys);
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
      ...(snapshots.sourceImagePaths ? { sourceImagePaths: snapshots.sourceImagePaths } : {}),
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
   * 创建图文包：走 `createNotePackageAssets`（静帧来源按场景序自动收集，素材库来源用已解析的路径）。
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
    /** 仅素材库来源：按选择顺序的绝对路径；省略即按场景序自动收集静帧。 */
    sourceImagePaths?: string[];
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
          ...(input.sourceImagePaths ? { sourceImagePaths: input.sourceImagePaths } : {}),
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

/**
 * 图文发布目前只接通抖音（上游只有 `sau douyin upload-note`）。
 *
 * **这是一道「图文口径」的闸门，不含微信公众号，也不该含**：公众号走的是 article 通路
 * （标题 32 / 摘要 120 / 正文是渲染出来的 HTML），把它塞进这里会拿图文口径去校验文章。
 * **导出**供守卫用例断言它是严格子集。
 */
export const NOTE_PLATFORMS = new Set<PublishPlatform>(["douyin"]);

/** 文章通路的封面计划：指纹键 + 预览清单 + 真实源路径。 */
interface ArticleCoverPlan {
  source: NoteImageSource;
  /** 参与 `previewRevision` 的指纹键（静帧名或 `asset:<id>`）。 */
  key: string;
  preview: { name: string; size: number; assetId?: string };
  /** 封面源文件绝对路径（打包前会被裁成 16:9）。 */
  absolutePath: string;
}

/**
 * 文章通路目前**只接入今日头条**（公众号那条通路的服务层编排尚未实现）。
 * 与 `assertNotePlatforms` 同一形状：说清「哪个平台不支持」，而不是让请求静默走错分支。
 */
function assertArticlePlatforms(platforms: PublishPlatform[]): void {
  for (const platform of platforms) {
    if (platform !== "toutiao") {
      throw new PublishingServiceError(
        422,
        "publish_article_platform_unsupported",
        `平台 ${platform} 尚未接入文章发布，目前只支持今日头条`,
      );
    }
  }
}

/** 头条发布选项的默认值：**微头条同步默认关闭**（平台默认勾选，不关就会多发一条内容）。 */
function defaultToutiaoOptions(): ToutiaoPublishOptions {
  return { firstPublish: false, declarations: [], crossPostWeitoutiao: false };
}

/** 归一发布选项：声明去重保序（指纹里按集合语义排序）。 */
function normalizeToutiaoOptions(value: ToutiaoPublishOptions | undefined): ToutiaoPublishOptions {
  if (!value) return defaultToutiaoOptions();
  const declarations: string[] = [];
  for (const item of value.declarations ?? []) {
    const text = typeof item === "string" ? item.trim() : "";
    if (text.length > 0 && !declarations.includes(text)) declarations.push(text);
  }
  return {
    firstPublish: Boolean(value.firstPublish),
    declarations,
    crossPostWeitoutiao: Boolean(value.crossPostWeitoutiao),
  };
}

/**
 * 文章包**创建阶段**的 `previewRevision`：只覆盖「源 + 封面选择」。
 *
 * ⚠️ **刻意不把 AI 草稿算进来**（2026-09-18 实测踩到）：草稿是**服务端**在预览时用 AI 生成的，
 * 而创建时正文由**用户编辑过的文本**决定 —— 一旦把草稿正文算进指纹，
 * 「界面允许编辑」就必然变成「一编辑就 409」，而且报错还会说「源内容自预览后发生变化」，
 * 把用户自己的输入说成源变了（评审实测确认过这条路径走不通）。
 *
 * 真正要防的「预览之后内容被改」由**包级**指纹把关：`packagePreviewRevision` 覆盖
 * `articleCopy.title` + `articleCopy.htmlSha256`（渲染产物哈希）+ 封面 + 头条选项，
 * 提交时缺/不一致一律 400/409（spec §6.3）。所以这里少绑一层并不削弱那道闸门。
 */
function articleSourceRevision(
  jobId: string,
  context: SourceContext,
  platforms: PublishPlatform[],
  coverKey: string,
): string {
  return sourceRevision(jobId, context, platforms, [`cover:${coverKey}`]);
}

/** 渲染并把「正文过长」翻译成服务层错误（`ToutiaoArticleError` 只在渲染模块里定义）。 */
function renderArticleHtmlOrThrow(draft: ToutiaoArticleDraft): string {
  try {
    return renderToutiaoArticleHtml(draft);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "toutiao_article_too_long") {
      throw new PublishingServiceError(422, "publish_validation_failed", error.message);
    }
    throw error;
  }
}

/** 洗稿产物 → 成文取材上下文（与 `wechat-article.ts` 的取材口径一致，字段更全）。 */
function articleSourceContextOf(context: SourceContext): ArticleSourceContext {
  const cleaned = context.cleaned;
  const source: ArticleSourceContext = { title: cleaned.title ?? cleaned.coverTitle ?? "" };
  const summary = cleaned.summary;
  if (summary) source.summary = summary;
  if (cleaned.keyPoints && cleaned.keyPoints.length > 0) source.keyPoints = [...cleaned.keyPoints];
  if (cleaned.cleanScript) source.cleanScript = cleaned.cleanScript;
  if (cleaned.voiceoverScript) source.voiceoverScript = cleaned.voiceoverScript;
  if (cleaned.videoOutline && cleaned.videoOutline.length > 0) {
    source.videoOutline = cleaned.videoOutline.map((item) => ({
      title: item.title,
      bullets: [...item.bullets],
    }));
  }
  if (cleaned.qualityNotes && cleaned.qualityNotes.length > 0) source.qualityNotes = [...cleaned.qualityNotes];
  if (cleaned.tags && cleaned.tags.length > 0) source.tags = [...cleaned.tags];
  return source;
}

function buildArticleFallbackPlan(context: ArticleSourceContext): ArticlePlan {
  return fallbackToutiaoArticle(context);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
 * `copyPolicy` 选的是**用哪份政策文档**，不是「包级还是任务级」：
 * `"note"` = 图文政策（抖音 title ≤20），`"platform"` = 平台政策
 * （抖音视频 title ≤55；**头条那份就是文章口径** —— titleMax 30 / 正文 20000，
 * 见 `PUBLISH_PLATFORMS.toutiao` 的注释）。
 *
 * 这里刻意不写成布尔值：这个参数原先叫 `noteScope`，读起来像「包级作用域」，
 * 于是文章包也照着图文包传了 `true` → `validateNoteCopy("toutiao")` 抛
 * 「平台 toutiao 尚未接入图文发布」→ 包级预览 500 → 界面上的「提交到头条号」
 * 因为拿不到 `previewRevision` 而完全不可达（2026-09-18 真机验证实测）。
 */
function copyCheck(
  platform: PublishPlatform,
  scope: "package" | "task",
  copy: PlatformCopy,
  taskId: string | undefined,
  copyPolicy: "platform" | "note",
): PublishingPreviewCopyCheck {
  const policy: PlatformPolicy = copyPolicy === "note"
    ? PUBLISH_NOTE_POLICIES[platform] ?? PUBLISH_PLATFORMS[platform]
    : PUBLISH_PLATFORMS[platform];
  const normalized = normalizePlatformCopy(copy);
  const violations = copyPolicy === "note"
    ? validateNoteCopy(platform, copy)
    : validatePlatformCopy(platform, copy);
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
    case "publish_auto_publish_unsupported":
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
