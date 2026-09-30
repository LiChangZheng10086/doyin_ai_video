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
  XhsNoteOptions,
} from "../types.js";
import type { AssetStore, ResolvedAssetFile } from "./assets-store.js";
import { NoteMediaService } from "./note-media.js";
import type { RuntimeChannelId } from "./runtime-status.js";
import { XHS_MAX_IMAGES } from "./xhs-page.js";
import type { XhsPublishInput, XhsPublishResult, XhsRunner } from "./xhs-runner.js";
import type { PublishingCopyService } from "./publishing-copy.js";
import {
  type BoundSourceVideo,
  type PublishingRecoveryReport,
  MAX_NOTE_IMAGES,
  PublishingAssetError,
  PublishingAssetService,
  collectSceneSnapshots,
  imageManifestHash,
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
import { WechatMpClient } from "./wechat-mp-client.js";
import { WechatMediaService } from "./wechat-media.js";
import { planWechatArticle, renderWechatArticleHtml, validateArticleDraft, substituteWechatImageSlots, WECHAT_ARTICLE_LIMITS } from "./wechat-article.js";
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
  | "hasAutoPublishInFlight"
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
  /** 小红书图文发布的自研执行器；未注入时按「未配置」明确报错。 */
  xhs?: XhsAutoPublishRunner;
  /** 图文配图裁成 3:4（方案甲：**所有**图文包都过这一步）。缺省用真 ffmpeg；测试注入假实现。 */
  noteMedia?: NoteImagePreparer;
  /**
   * ffmpeg 可执行文件（裁配图用）。打包后它在 `resources/bin`（**不在 PATH 上**），
   * 所以必须走配置里的那个 —— 直接用默认的 `"ffmpeg"` 会在安装包里失败、而开发机上是好的。
   */
  ffmpegBinary?: string;
  /** 头条封面处理（16:9 裁剪）。缺省用真 ffmpeg；测试注入假实现。 */
  toutiaoMedia?: ToutiaoCoverPreparer;
  /** AI 成文（头条文章）。缺省不可用 → 走本地兜底（不阻塞建包）。 */
  planArticle?: ArticlePlanner;
  planWechatArticle?: ArticlePlanner;
  wechat?: () => Promise<WechatMpClient>;
  wechatMedia?: Pick<WechatMediaService, "prepareCoverImage" | "prepareContentImage">;
  now?: () => Date;
  createId?: () => string;
  /**
   * 运行环境深检的互斥闸（spec §5.2 规则 2 / INV-4b）。
   *
   * 深检与发布**共用同一个浏览器 profile 目录**，同时跑会互相破坏 —— 所以该渠道正在
   * 检测时，发布必须让路。**按渠道**问，跨渠道必须答 `false`（抖音检测不该挡住头条发布）。
   * 未注入 = 没有深检功能（测试与早期装配），此时不拦。
   */
  runtimeChecks?: { isRunning(id: RuntimeChannelId): boolean | Promise<boolean> };
  /**
   * 登录判据回写（spec §3.3 第③条 / INV-2 ②③④⑤）。
   *
   * 发布或登录动作里**已经产生**的登录判定，顺手写进状态页那份存档 —— 于是「发一次 =
   * 验一次」，用户不点任何按钮也会看到状态变新。深检（INV-2 ①）不走这里，它自己写。
   * 未注入 = 没有状态页（测试与早期装配），此时什么都不做。
   */
  runtimeVerified?: { record(id: RuntimeChannelId, state: "valid" | "invalid"): Promise<void> };
  resolveVideo?: typeof resolveJobVideo;
}

type ServiceErrorCode =
  | "publish_asset_broken"
  | "publish_blocked_by_runtime_check"
  | "publish_auto_publish_code_unexpected"
  | "publish_auto_publish_in_progress"
  | "publish_auto_publish_unsupported"
  | "publish_article_platform_unsupported"
  | "publish_toutiao_not_configured"
  | "publish_article_unreadable"
  | "publish_toutiao_cover_required"
  | "publish_images_unusable"
  | "publish_note_platform_unsupported"
  | "publish_xhs_ai_declaration_required"
  | "publish_xhs_too_many_images"
  | "publish_xhs_images_required"
  | "publish_xhs_daily_limit"
  | "publish_xhs_not_configured"
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
  publish_blocked_by_runtime_check: "该渠道正在验证登录态，检测会与发布抢同一个浏览器会话。请等检测结束（通常 10–30 秒，最坏 5 分钟），或先取消检测",
  publish_auto_publish_code_unexpected: "该任务当前没有在等待短信验证码",
  publish_auto_publish_in_progress: "该任务的图文自动发布正在进行中，请等本次结束后再试",
  publish_auto_publish_unsupported: "该内容类型与平台的组合不支持自动发布，请走人工交付",
  publish_article_platform_unsupported: "文章发布目前只接入了今日头条",
  publish_toutiao_not_configured: TOUTIAO_BROWSER_GUIDANCE_FOR_SERVICE,
  publish_article_unreadable: "文章包内的 article.html 缺失或已被改动，请重新创建文章包",
  publish_toutiao_cover_required: "今日头条要求文章必须有封面，请重新创建文章包并选择封面（会自动裁成 16:9）",
  publish_images_unusable: "图文包的图片素材不完整，请重新生成或选择图片后再发布",
  publish_note_platform_unsupported: "该平台尚未接入图文发布，目前只支持抖音图文与小红书图文",
  publish_xhs_ai_declaration_required: "没有声明「笔记含AI合成内容」，已拒绝发布",
  publish_xhs_too_many_images: "小红书图文最多 18 张图片",
  publish_xhs_images_required: "小红书图文至少要有一张图片",
  // ⚠️ 文案不许说「已经发过一篇」：这条闸门把「只填到草稿」也算在一次里
  //（平台风控看的是自动化访问，不是提交与否），而草稿并没有发出去 ——
  // 用户实测就是被这句误导去小红书找内容、却找不到（2026-09-21）。
  publish_xhs_daily_limit: "今天已经用过一次小红书自动通路（本地自然日上限 1 次；只填到草稿也算），明天再试",
  publish_xhs_not_configured: "小红书执行器未配置",
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

/** 有深检通路的三个渠道。其余平台（公众号 / 视频号 / B站）永远没有深检，发布不受影响。 */
const RUNTIME_CHECK_CHANNELS = ["douyin", "toutiao", "xiaohongshu"] as const;

function isRuntimeCheckChannel(platform: PublishPlatform): platform is RuntimeChannelId {
  return (RUNTIME_CHECK_CHANNELS as readonly string[]).includes(platform);
}

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
  articleImageAssetIds?: string[];
}

type NoteImagePlan = {
  source: NoteImageSource;
  /** 参与 `previewRevision` 的指纹键：静帧用文件名、素材库用 asset id，顺序参与哈希。 */
  keys: string[];
  /** 预览要摊给操作者看的图片清单，顺序即入包顺序。 */
  images: Array<{ name: string; size: number; assetId?: string }>;
  /**
   * 按入包顺序解析好的**绝对路径**（两种来源都有）。
   *
   * ⚠️ 原先只有素材库来源给这个字段，注释写着「静帧由打包层自行收集」。
   * **方案甲（2026-09-20 拍板：打包时裁成 3:4）之后这条注释作废** ——
   * 裁切必须在**打包之前**完成，所以静帧的绝对路径也得在这里带出来，不能在打包层内部才知道。
   */
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
function noteCopyLimits(platform: PublishPlatform): { titleMax: number; descriptionMax: number; hashtagMax: number } {
  // 按平台取，**不是**硬编码 `PUBLISH_NOTE_POLICIES.douyin`（那样小红书会拿到抖音的口径）。
  // ⚠️ 返回值是**单数**的 `copyLimits`：图文通路上两个平台当前口径相同，所以成立。
  // 一旦二者分歧，这里必须改成按平台下发（`note-policy-equal` 的用例会先红，提醒改动者）。
  const policy = PUBLISH_NOTE_POLICIES[platform];
  if (!policy) throw new PublishingServiceError(422, "publish_note_platform_unsupported");
  return { titleMax: policy.titleMax, descriptionMax: policy.descriptionMax, hashtagMax: policy.hashtagMax };
}

/**
 * 小红书执行器在服务层眼里只需要这两件事。
 *
 * 定义在这里（而不是直接吃 `XhsRunner`）是为了让服务层用例能注入**假执行器** ——
 * 与 `AutoPublishRunner` / `ToutiaoAutoPublishRunner` 同一手法。
 */
/** 配图预处理的接口面（`NoteMediaService` 满足它；测试注入假实现）。 */
export interface NoteImagePreparer {
  prepareNoteImage(srcPath: string, outDir: string, index: number): Promise<{ path: string; bytes: number }>;
}

export type XhsAutoPublishRunner = Pick<
  XhsRunner,
  | "assertConfigured"
  | "checkLogin"
  | "startLogin"
  | "pollLogin"
  | "cancelLogin"
  | "loginInWindow"
  | "publishNote"
>;

/**
 * 同一账号**本地自然日**最多提交几篇小红书图文。
 *
 * 这个数字是**风险缓解**，不是安全保证：调研里明确有「1 篇即永封」的案例
 *（见 `docs/research/xhs-publish-projects-assessment.md` §4.3），所以产品文案不许承诺安全。
 * **导出**是为了让用例与界面文案引用同一个真源。
 */
export const XHS_DAILY_PUBLISH_LIMIT = 1;

/** 两个时间点是否落在**同一个本地自然日**（按运行机器的时区）。 */
function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
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
    const wechat = selected[0] === "wechat_mp";
    const context = await this.readSourceContext(jobId);
    try {
      const index = await this.deps.store.snapshot();
      const nextVersion = index.nextVersionBySource[jobId] ?? 1;

      const plan = wechat
        ? await (this.deps.planWechatArticle ?? (source => planWechatArticle(source, { resolveAiConfig: async () => null })))(articleSourceContextOf(context))
        : await this.planArticleFor(context);
      const bodyImages = await this.planArticleImages(selection, wechat);
      const html = wechat ? renderWechatArticleHtml(plan.draft, { images: bodyImages.map((_, i) => ({ slot: i + 1 })) }) : renderArticleHtmlOrThrow(plan.draft);
      const body = articleDraftToBodyText(plan.draft);
      const cover = await this.planArticleCover(jobId, selection);
      const copy: PlatformCopy = { title: plan.draft.title, description: body, hashtags: [] };

      return {
        sourceJobId: jobId,
        nextVersion,
        previewRevision: articleSourceRevision(jobId, context, selected, articleCoverKey(cover.key, bodyImages)),
        video: {
          filename: path.basename(context.video.path),
          size: context.video.size,
          width: context.width,
          height: context.height,
          duration: context.duration,
          coverAvailable: Boolean(context.sourceCoverPath),
        },
        copies: {
          [selected[0]!]: { ...copy, description: wechat ? (plan.draft.digest ?? "") : body, copySource: plan.copySource === "ai" ? "ai" : "cleaned_fallback" },
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
        articleCopy: { title: plan.draft.title, body, ...(wechat ? { author: plan.draft.author, digest: plan.draft.digest } : {}) },
        articleLimits: articleLimitsFor(wechat),
        ...(wechat ? { images: bodyImages.map(file => ({ name: file.record.originalName, size: file.size, assetId: file.record.id })) } : {}),
        // **绝不静默**：AI 成文失败必须让操作者看见（否则会以为这就是 AI 写的）。
        ...(plan.warning ? { articleFallback: { code: plan.warning.code, message: plan.warning.message } } : {}),
        articleCover: cover.preview,
        imageSource: cover.source,
        ...(wechat ? {} : { toutiaoOptions: defaultToutiaoOptions() }),
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

  private async planArticleImages(selection: NoteImageSelection, wechat: boolean): Promise<ResolvedAssetFile[]> {
    const ids = selection.articleImageAssetIds ?? [];
    if ((!wechat && ids.length) || ids.length > MAX_NOTE_IMAGES || new Set(ids).size !== ids.length) {
      throw new PublishingServiceError(422, "publish_validation_failed", "正文配图仅支持公众号，最多 35 张且不可重复");
    }
    return Promise.all(ids.map(id => this.resolveLibraryImage(id)));
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
          "这个作品还没有场景静帧，文章必须有封面：请先生成视频，或改用素材库图片作为封面。",
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
        "文章封面只支持单图，请只选择一张图片",
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
        "这个作品还没有场景静帧，文章必须有封面：请先生成视频，或改用素材库图片作为封面。",
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
    const wechat = selected[0] === "wechat_mp";
    if (!input.articleCopy) {
      throw new PublishingServiceError(
        400,
        "publish_validation_failed",
        "文章包必须提供 articleCopy（标题与正文）",
      );
    }

    const draft = articleBodyToDraft(input.articleCopy.title, input.articleCopy.body);
    if (wechat) {
      draft.author = input.articleCopy.author?.trim();
      draft.digest = input.articleCopy.digest?.trim();
    }
    // 空正文必须在**创建**阶段拦掉：否则包建得出来，但发布时会在页面上报
    // 「正文没有填进头条编辑器」——那是错误的诊断（真正原因是文章本身没正文）。
    if (draft.sections.every((section) => section.paragraphs.length === 0)) {
      throw new PublishingServiceError(422, "publish_validation_failed", "文章正文不能为空");
    }
    const violations = wechat ? validateArticleDraft(draft) : validateToutiaoArticle(draft);
    if (violations.length > 0) {
      throw new PublishingServiceError(422, "publish_validation_failed", violations[0]!.message, {
        violations,
      });
    }
    const bodyImages = await this.planArticleImages(input, wechat);
    const html = wechat ? renderWechatArticleHtml(draft, { images: bodyImages.map((_, i) => ({ slot: i + 1 })) }) : renderArticleHtmlOrThrow(draft);
    const cover = await this.planArticleCover(input.sourceJobId, input);

    const currentRevision = articleSourceRevision(input.sourceJobId, context, selected, articleCoverKey(cover.key, bodyImages));
    if (currentRevision !== input.previewRevision) {
      throw new PublishingServiceError(409, "publish_revision_conflict", undefined, {
        expectedRevision: input.previewRevision,
        currentRevision,
      });
    }

    const copy: PlatformCopy = {
      title: draft.title,
      description: wechat ? (draft.digest ?? "") : articleDraftToBodyText(draft),
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
      wechat,
      bodyImages,
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
    wechat: boolean;
    bodyImages: ResolvedAssetFile[];
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
          const wechatMedia = this.deps.wechatMedia ?? new WechatMediaService({ ffmpegBinary: this.deps.ffmpegBinary });
          const prepared = await (input.wechat ? wechatMedia : this.requireToutiaoMedia()).prepareCoverImage(input.cover.absolutePath, workDir);
          const imagePaths: string[] = [];
          for (const [index, image] of input.bodyImages.entries()) {
            imagePaths.push((await wechatMedia.prepareContentImage(image.path, workDir, index + 1)).path);
          }
          const articleCopy = { title: input.draft.title, ...(input.wechat ? { author: input.draft.author, digest: input.draft.digest } : {}) };
          const assets = await this.deps.assets.createArticlePackageAssets({
            packageId,
            sourceJobId: input.sourceJobId,
            version,
            articleHtml: input.html,
            sourceCoverPath: prepared.path,
            articleCopy,
            sourceImagePaths: imagePaths,
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
              articleCopy: { ...articleCopy, htmlSha256: assets.htmlSha256 },
              ...(input.wechat ? {} : { toutiaoOptions: { ...input.options, declarations: [...input.options.declarations] } }),
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
    // 本身就是一次零副作用的登录判定 —— 顺手回写，用户不必再点一次「验证登录态」（INV-2 ②）
    await this.recordVerified("toutiao", state.loggedIn ? "valid" : "invalid");
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
    const status = await this.requireToutiaoRunner().pollLogin();
    // 刚刚亲眼确认过的登录态 —— 这是**最强**的证据（INV-2 ③）
    if (status.status === "logged_in") await this.recordVerified("toutiao", "valid");
    return status;
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
    const result = await runner.loginInWindow();
    // 窗口扫码成功是最强证据（INV-2 ③）
    if (result.loggedIn) await this.recordVerified("toutiao", "valid");
    return result;
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
      // 发布前的这次判定顺手回写，于是「发一次 = 验一次」（INV-2 ④）
      await this.recordVerified("toutiao", state.loggedIn ? "valid" : "invalid");
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

  async verifyWechatAccount() {
    const client = await this.wechatClient();
    return client.verifyAccount();
  }

  private async wechatClient(): Promise<WechatMpClient> {
    const client = this.deps.wechat ? await this.deps.wechat() : new WechatMpClient();
    client.assertConfigured();
    return client;
  }

  private async autoPublishWechatArticle(
    taskId: string,
    input: { previewRevision: string },
    actor: ActorSnapshot,
    detail: PublishingPackageDetail,
  ): Promise<PublishTask> {
    const pkg = detail.package;
    const task = detail.tasks.find(item => item.id === taskId)!;
    if (task.status === "published" || task.status === "cancelled" || task.autoPublish?.draftMediaId
      || task.autoPublish?.outcomeUncertain || task.autoPublish?.status === "succeeded") {
      throw new PublishingServiceError(409, "publish_validation_failed", "该任务已创建草稿或结果待核实，请先到公众号后台确认。确需另建时请人工重新建包。");
    }
    const client = await this.wechatClient();
    const article = await this.readPackageArticleHtml(pkg.id);
    if (!article || article.htmlSha256 !== pkg.articleCopy?.htmlSha256) throw new PublishingServiceError(422, "publish_article_unreadable");
    if (await this.deps.assets.verifyPackageHealth(pkg) !== "healthy") throw new PublishingServiceError(422, "publish_images_unusable", "文章封面或正文图缺失/被修改，请重新建包");
    const cover = await this.deps.assets.readPackageCover(pkg);
    if (!cover) throw new PublishingServiceError(422, "publish_validation_failed", "公众号文章必须有封面");
    const images = [];
    for (let i = 0; i < (pkg.imagePaths?.length ?? 0); i++) {
      const image = await this.deps.assets.readPackageImage(pkg, i);
      if (!image) throw new PublishingServiceError(422, "publish_images_unusable");
      images.push(image);
    }
    // 所有校验完成后才占用任务；版本与并发在同一份索引事务内检查。
    await this.storeCall(() => this.deps.store.beginAutoPublish(taskId, { previewRevision: input.previewRevision, attemptId: this.createId() }, actor));
    let creating = false;
    let draftMediaId: string | undefined;
    try {
      const uploadedCover = await client.uploadCoverImage({ bytes: cover, filename: "cover.jpg", maxBytes: WECHAT_ARTICLE_LIMITS.coverBytes });
      if (!uploadedCover.ok) return this.finishAutoPublish(taskId, { status: "failed", message: uploadedCover.message }, actor);
      const urls = new Map<number, string>();
      for (const [i, image] of images.entries()) {
        const uploaded = await client.uploadContentImage({ bytes: image.bytes, filename: `${i + 1}${image.extension}`, maxBytes: WECHAT_ARTICLE_LIMITS.contentImageBytes - 1 });
        if (!uploaded.ok) return this.finishAutoPublish(taskId, { status: "failed", message: uploaded.message }, actor);
        urls.set(i + 1, uploaded.data!.url);
      }
      const content = substituteWechatImageSlots(article.bytes.toString("utf8"), urls);
      creating = true;
      const result = await client.createDraft({ title: pkg.articleCopy!.title, author: pkg.articleCopy!.author, digest: pkg.articleCopy!.digest, content, thumbMediaId: uploadedCover.data!.mediaId });
      if (!result.ok) {
        const uncertain = result.errorKind === "network" || result.errorKind === "invalid_response";
        return await this.finishAutoPublish(taskId, { status: "failed", outcomeUncertain: uncertain,
          message: `${result.message}${uncertain ? " 结果待核实：请先检查公众号草稿箱，禁止直接重发以免重复创建。" : ""}` }, actor);
      }
      draftMediaId = result.data!.mediaId;
      return await this.finishAutoPublish(taskId, { status: "succeeded", draftOnly: true, draftMediaId,
        message: `草稿已创建（${draftMediaId}），尚未发布。请到公众号后台检查封面、正文和图片，再由你手动发布。` }, actor);
    } catch {
      // 不把底层异常（可能含 secret/token）原样写入审计。已取得 ID 的结果不能改成未创建。
      return await this.finishAutoPublish(taskId, draftMediaId
        ? { status: "succeeded", draftOnly: true, draftMediaId, message: `草稿已创建（${draftMediaId}），请到公众号后台核实，勿重复提交。` }
        : { status: "failed", outcomeUncertain: creating, message: creating ? "创建草稿结果待核实，请先检查公众号后台，勿重复提交。" : "素材处理或上传未完成，草稿尚未提交，请检查图片与连接后重试。" }, actor);
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
      // ⚠️ 图文包的文案是**包级单份**（所有图文平台共用同一份 noteCopy），所以「从哪份生成稿取」
      // 必须按**实际所选平台**来。以前固定取 `copies.douyin`，而 `previewAll` 只为**所选平台**生成文案，
      // 于是「只选小红书」时那份抖音文案根本不存在 → description 与 hashtags **静默变成空**，
      // 而标题侥幸回退到作品标题所以看不出问题（用户 2026-09-21 实测：预览里「正文 (空) / 话题 (无)」，
      // 包建出来之后小红书任务也就没有正文可发）。
      // 有抖音时仍优先抖音（保持既有口径与既有用例），否则取所选平台里第一份存在的生成稿。
      const copySource = copyPreview.copies.douyin
        ?? selected.map((platform) => copyPreview.copies[platform]).find((copy) => copy !== undefined)
        ?? { title: "", description: "", hashtags: [] };
      const compressed = compressNoteTitle(copySource.title || context.cleaned.title || "", SAU_NOTE_MAX_TITLE);
      const noteCopy: PlatformCopy = {
        title: compressed.title,
        description: copySource.description,
        hashtags: [...copySource.hashtags],
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
        // 张数上限按**所选平台里最严的那个**下发：小红书 18 < 打包层 35。
        // 界面用它渲染上限提示与禁用态；服务端创建时仍会重新校验（创建按 35、提交按 18）。
        imageLimit: selected.includes("xiaohongshu") ? XHS_MAX_IMAGES : MAX_NOTE_IMAGES,
        // `selected` 里可能同时有多个图文平台；当前两者口径相同，所以取第一个即可
        //（一旦分歧，`note-policy-equal` 用例会先红，届时改成按平台下发）。
        copyLimits: noteCopyLimits(selected.find((platform) => NOTE_PLATFORMS.has(platform)) ?? "douyin"),
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
      return {
        source,
        keys: snapshots.map((snapshot) => snapshot.name),
        images: snapshots.map(({ name, size }) => ({ name, size })),
        sourceImagePaths: snapshots.map((snapshot) => snapshot.absolutePath),
      };
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
  /** 静帧清单：**同时**给出展示用的名字/大小与裁切要用的绝对路径（见 `NoteImagePlan` 的注释）。 */
  private async listSceneSnapshots(jobId: string): Promise<Array<{ name: string; size: number; absolutePath: string }>> {
    const absolutePaths = await collectSceneSnapshots(this.storageRoot, jobId);
    const snapshots: Array<{ name: string; size: number; absolutePath: string }> = [];
    for (const absolutePath of absolutePaths) {
      const stats = await stat(absolutePath).catch(() => undefined);
      if (!stats || !stats.isFile() || stats.size === 0) continue;
      snapshots.push({ name: path.basename(absolutePath), size: stats.size, absolutePath });
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
      preview.imagePaths = [...(packageRecord.imagePaths ?? [])];
      // 文章包：正文在包内 `article.html`，这里摊成纯文本给操作者看（spec §14.1：
      // 预览的意义就是「看得见将要发出去的内容」）。封面走既有 `/cover` 路由。
      const articleCopy = packageRecord.articleCopy ?? { title: packageRecord.title, htmlSha256: "" };
      const html = await this.deps.assets.readPackageArticle(packageRecord);
      // 展示**正文文本**（带 `## ` 小标题标记），与创建向导里看到的形态一致：
      // 包记录只存 title + htmlSha256，正文只能从 `article.html` 还原。
      const body = html ? articleHtmlToBodyText(html.toString("utf8")) : "";
      const platform = detail.tasks[0]?.platform ?? "toutiao";
      const wechat = platform === "wechat_mp";
      preview.articleCopy = { title: articleCopy.title, body, ...(wechat ? { author: articleCopy.author, digest: articleCopy.digest } : {}) };
      preview.articleLimits = articleLimitsFor(wechat);
      if (!wechat) preview.toutiaoOptions = normalizeToutiaoOptions(packageRecord.toutiaoOptions);
      // 用**平台政策**（`PUBLISH_PLATFORMS.toutiao` 就是文章口径：titleMax 30 / 正文 20000），
      // 不是图文政策 —— `PUBLISH_NOTE_POLICIES` 里没有 toutiao，走图文口径会直接抛错。
      preview.copyChecks.push(
        copyCheck(platform, "package", { title: articleCopy.title, description: wechat ? (articleCopy.digest ?? "") : body, hashtags: [] }, undefined, "platform"),
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
    if (detail.package.contentType !== "note" && detail.package.contentType !== "article") return null;
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
  /**
   * 把一次**已经产生**的登录判据回写（INV-2 ②③④⑤）。
   *
   * ⚠️ 这是**辅助动作**：它的失败绝不能让发布失败 —— 用户要的是把内容发出去，不是让
   * 状态页好看。所以只记一行警告，不上抛。但也**不静默**：静默失败正是状态页会悄悄
   * 变旧的原因，而那正是本功能要消灭的东西。
   */
  private async recordVerified(id: RuntimeChannelId, state: "valid" | "invalid"): Promise<void> {
    const port = this.deps.runtimeVerified;
    if (!port) return;
    try {
      await port.record(id, state);
    } catch (error) {
      console.warn(
        `[publishing] 登录判据回写失败（不影响本次操作）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 该渠道正在深检时不许发布（spec §5.2 规则 2）。
   *
   * 只对三个有深检通路的渠道生效；未注入 `runtimeChecks` 时直接放行（没有深检功能）。
   */
  private async assertNoRuntimeCheckRunning(platform: PublishPlatform): Promise<void> {
    const gate = this.deps.runtimeChecks;
    if (!gate || !isRuntimeCheckChannel(platform)) return;
    if (await gate.isRunning(platform)) {
      throw new PublishingServiceError(409, "publish_blocked_by_runtime_check");
    }
  }

  async autoPublish(
    taskId: string,
    input: { previewRevision: string; dryRun?: boolean },
    actor: ActorSnapshot,
  ): Promise<PublishTask> {
    const task = await this.requireTask(taskId);
    const detail = await this.requirePackage(task.packageId);

    // **先判输入类别、再判配置**：视频包不是「配置问题」，无论 sau/浏览器配没配都该报同一个明确错误。
    // 分派只问那张唯一真源的路由表（`AUTO_PUBLISH_ROUTES`），两个通路各走各的。
    const contentType = detail.package.contentType ?? "video";
    // `dryRun` 只对小红书有意义（「只填到草稿」）。其余通路显式拒绝而不是静默忽略 ——
    // 静默忽略会让调用方以为「只是演练」，实际却真发出去了。
    if (input.dryRun === true && resolveAutoPublishEngine(contentType, task.platform) !== "xhs") {
      throw new PublishingServiceError(400, "publish_validation_failed", "dryRun 只适用于小红书图文通路");
    }
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
    /*
     * 深检与发布**按渠道互斥**（spec §5.2 规则 2 / INV-4b）：两者共用同一个浏览器
     * profile 目录，同时跑会互相破坏。注意只拦**同一渠道** —— 抖音深检不该挡住头条发布。
     *
     * 放在这里一处，而不是三个通路各写一遍：`autoPublish` 是唯一的分派入口，
     * 三个引擎恰好都在下面的 switch 里。
     */
    await this.assertNoRuntimeCheckRunning(task.platform);

    // ⚠️ **必须是穷尽 switch，不能留 `else` 兜底**。
    // 原先是「engine 不是 toutiao 就 `return this.autoPublishNoteTask(...)`」—— 那是把兜底
    // 当成「sau 通路」。新增 `"xhs"` 之后那种写法会把小红书**静默路由给外部 CLI**，
    // 表现是「报未配置 sau」这种莫名其妙的错误（见 spec §5.1）。
    switch (engine) {
      case "wechat":
        return this.autoPublishWechatArticle(taskId, input, actor, detail);
      case "toutiao":
        return this.autoPublishToutiaoArticle(taskId, input, actor);
      case "xhs":
        return this.autoPublishXhsNote(taskId, input, actor, detail);
      case "sau":
        return this.autoPublishNoteTask(taskId, input, actor, detail);
      default: {
        // 穷尽性检查：将来再往 `AUTO_PUBLISH_ROUTES` 加引擎时，**编译器会在这里报错**，
        // 而不是让新引擎悄悄落进某个已有分支。
        const exhaustive: never = engine;
        throw new PublishingServiceError(
          500,
          "publish_auto_publish_unsupported",
          `未登记的自动发布引擎：${String(exhaustive)}`,
        );
      }
    }
  }

  /**
   * 小红书图文通路（自研执行器）。
   *
   * 与抖音通路的**根本差别**（都是实测/调研换来的，别当成风格差异）：
   *
   * 1. **没有「已提交」以外的读回**：执行器点完发布就断开，所以 `verification` 恒为 `unconfirmed`，
   *    界面文案必须是「已提交，请到小红书 App 核实」，而不是「发布成功」。
   * 2. **AI 标识是合规红线**：`aiDeclaration !== true` 直接拒（平台口径「未标识 → 限制分发」），
   *    而且这一步在**点任何页面之前**完成。
   * 3. **图片按小红书口径**：≤18 张（打包层允许 35，抖音那条路不受影响）。
   * 4. **频率闸门**：本地自然日 ≤ `XHS_DAILY_PUBLISH_LIMIT` 篇。
   * 5. ⚠️ **任何**异常都落成 `failed` 记录 —— 绝不 500、绝不让记录卡在 `running`
   *   （头条那轮的事故：服务层只认自己的错误类，其余原样抛出 → 500 + 卡 running 到 30 分钟僵死阈值）。
   */
  private async autoPublishXhsNote(
    taskId: string,
    input: { previewRevision: string; dryRun?: boolean },
    actor: ActorSnapshot,
    detail: PublishingPackageDetail,
  ): Promise<PublishTask> {
    const task = await this.requireTask(taskId);
    const runner = this.requireXhsRunner();

    // ① 合规：**在点任何页面之前**就要拒掉没声明 AI 的情况。
    const options = detail.package.xhsOptions;
    if (options?.aiDeclaration !== true) {
      throw new PublishingServiceError(422, "publish_xhs_ai_declaration_required");
    }

    // ② 图片：完好 + 张数（服务端不信界面禁用态：接口仍可被直接调用）。
    if (await this.deps.assets.verifyPackageImages(detail.package) !== "healthy") {
      throw new PublishingServiceError(422, "publish_images_unusable");
    }
    const imagePaths = await this.deps.assets.resolvePackageImages(detail.package);
    if (imagePaths.length === 0) {
      throw new PublishingServiceError(422, "publish_xhs_images_required");
    }
    if (imagePaths.length > XHS_MAX_IMAGES) {
      throw new PublishingServiceError(422, "publish_xhs_too_many_images", undefined, {
        actual: imagePaths.length,
        limit: XHS_MAX_IMAGES,
      });
    }

    // ③ 频率闸门：本地自然日 ≤ 上限。超限**不产生任何记录**（与 revision 校验同一口径）。
    if (await this.countXhsPublishesToday() >= XHS_DAILY_PUBLISH_LIMIT) {
      throw new PublishingServiceError(422, "publish_xhs_daily_limit", undefined, {
        limit: XHS_DAILY_PUBLISH_LIMIT,
      });
    }

    const attemptId = this.createId();
    await this.storeCall(() => this.deps.store.beginAutoPublish(
      taskId,
      { previewRevision: input.previewRevision, attemptId },
      actor,
    ));

    try {
      const noteCopy = detail.package.noteCopy;
      const result = await runner.publishNote({
        title: noteCopy?.title ?? task.title,
        body: noteCopy?.description ?? task.description,
        imagePaths,
        // 上面已校验过，这里恒为 true；传进去是为了让执行器也留下一层记录。
        aiDeclaration: true,
        // `dryRun`（「只填到草稿」）是**只减不增**的覆盖：它只能把「点发布」降级成「不点」，
        // 绝不会让一个声明了 submit:false 的包真的发出去。
        submit: options.submit === true,
      }, input.dryRun === true ? { dryRun: true } : {});

      // ⚠️ **不给执行器的文案加任何前缀**，也不改写「未确认」的表述：
      // 头条那轮加了个「已提交，但」，真机记录里变成「已提交，但已点击发布，但…」。
      const message = result.steps.length > 0
        ? `${result.message}\n逐步记录：${result.steps.join(" → ")}`
        : result.message;
      /*
       * 小红书**没有发布前预检**（那条通路刻意不做任何多余页面访问），所以归因用它
       * 自己的结果（spec §3.3 第③条）：
       * - 被踢到登录页 → 执行器早返回 `code: "xhs_not_logged_in"`，这是**确凿**的失效证据
       * - 走完全程（含「只填到草稿」）→ 那一刻登录态有效
       * - 其他失败 → **不写**（我们不知道登录态怎么样，不许猜）
       */
      if (result.ok) await this.recordVerified("xiaohongshu", "valid");
      else if (result.code === "xhs_not_logged_in") await this.recordVerified("xiaohongshu", "invalid");

      return await this.finishAutoPublish(taskId, {
        status: result.ok ? "succeeded" : "failed",
        message,
        // 「只填到草稿」必须**显式**落到记录里：界面据此说「已填写到草稿箱」而不是「已提交」。
        // 判据用执行器回报的 `submitted`（**程序到底点没点过发布**），而**不是** `input.dryRun` ——
        // 包自己声明 `submit:false` 时执行器同样一个提交键都不点，那条路径也属于「只填草稿」，
        // 只看 dryRun 会漏掉它、界面继续撒谎（用户 2026-09-21 实测：显示「已提交」，去小红书找不到内容）。
        ...(result.ok && result.submitted === false ? { draftOnly: true } : {}),
      }, actor);
    } catch (error) {
      // ⚠️ **所有**异常都落 failed：浏览器起不来、Playwright 超时、元素失效……
      // 一条都不能冒到路由层（那会变成 500 + 记录卡在 running）。
      const detailText = error instanceof Error ? error.message : String(error);
      return await this.finishAutoPublish(taskId, {
        status: "failed",
        message: `小红书发布过程中出现意外错误：${detailText}`,
      }, actor);
    }
  }

  /** 小红书：开始应用内扫码登录（返回二维码 data URL 与过期时间）。 */
  async startXhsLogin(): Promise<{ qrDataUrl: string; startedAt: string; expiresAt: string }> {
    return this.requireXhsRunner().startLogin();
  }

  /** 小红书：轮询扫码状态。 */
  async pollXhsLogin(): Promise<{ status: "idle" | "waiting" | "logged_in" | "expired"; username?: string; qrDataUrl?: string }> {
    const status = await this.requireXhsRunner().pollLogin();
    // 刚刚亲眼确认过（INV-2 ③）
    if (status.status === "logged_in") await this.recordVerified("xiaohongshu", "valid");
    return status;
  }

  async cancelXhsLogin(): Promise<void> {
    await this.requireXhsRunner().cancelLogin();
  }

  /**
   * 小红书：登录态**零副作用**自检（只开首页判登录态 + 读昵称，不填表、不发任何内容）。
   *
   * 注意它沿用执行器里那条**重试后才作数**的判据（`LOGIN_CHECK_ATTEMPTS = 2`）：
   * 只读一次就下结论会出现假阴性（真机实测过），代价是用户跑去重扫一个其实好好的码。
   */
  async verifyXhsLogin(): Promise<{ loggedIn: boolean; username?: string; message: string }> {
    const runner = this.requireXhsRunner();
    const state = await runner.checkLogin();
    // 同头条：这本身就是一次零副作用的登录判定，顺手回写（INV-2 ②）
    await this.recordVerified("xiaohongshu", state.loggedIn ? "valid" : "invalid");
    return state.loggedIn
      ? { loggedIn: true, ...(state.username ? { username: state.username } : {}), message: "小红书登录态有效" }
      : {
          loggedIn: false,
          message:
            "小红书登录态已失效：请到「设置 → 小红书」点「扫码登录」，用小红书 App 扫码后重试。"
            + "（重新扫码不需要重启应用。）",
        };
  }

  /** 小红书：打开**浏览器窗口**扫码登录（与抖音那套同一交互）。同步等到扫码成功或超时。 */
  async loginXhsInWindow(): Promise<{ loggedIn: boolean; username?: string; message: string }> {
    const runner = this.requireXhsRunner();
    // 与「应用内扫码」互斥：窗口登录期间若用户又点应用内扫码，会开出第二个浏览器（同样的 profile 会打架）。
    await runner.cancelLogin().catch(() => undefined);
    const result = await runner.loginInWindow();
    // 窗口扫码成功同样是最强证据（INV-2 ③）
    if (result.loggedIn) await this.recordVerified("xiaohongshu", "valid");
    return result;
  }

  /**
   * 当日（**本地自然日**）已经用过**几次**小红书自动通路的唯一真源。
   *
   * ⚠️ 口径包含「只填到草稿」（`draftOnly`）—— 这是**刻意**的：风险来自自动化本身动了账号，
   * 而不是内容有没有发出去（同一理由见 `getPublishingActionIds` 里 fill/submit 共用一个闸门）。
   * 所以**不要**把它改成只数真提交，但也**不要**再用「今天已经发过一篇」这种文案去描述它。
   */
  private async countXhsPublishesToday(): Promise<number> {
    const index = await this.deps.store.snapshot();
    const today = this.now();
    let count = 0;
    for (const task of Object.values(index.tasks)) {
      if (task.platform !== "xiaohongshu") continue;
      const record = task.autoPublish;
      if (!record || record.status !== "succeeded") continue;
      const startedAt = new Date(record.startedAt);
      if (!Number.isNaN(startedAt.getTime()) && isSameLocalDay(startedAt, today)) count += 1;
    }
    return count;
  }

  /**
   * 未注入小红书执行器时按「未配置」明确报错（照 sau/头条同一口径）。
   * 实际上打包资源里已带浏览器，所以这条正常情况下走不到；留着是为了注入缺失时不静默。
   */
  private requireXhsRunner(): XhsAutoPublishRunner {
    const runner = this.deps.xhs;
    if (!runner) {
      throw new PublishingServiceError(
        422,
        "publish_xhs_not_configured",
        "未配置小红书执行器（xhs）。请确认后端装配时传入了 XhsRunner —— 打包应用自带浏览器，通常重启后端即可。",
      );
    }
    return runner;
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
      /*
       * ⚠️ 归因边界（spec §3.3 第③条）：只有 `exitCode === 0 && ok === false` 才算
       * 「登录态失效」；`exitCode === -1` 是**超时或进程起不来**，那是「没验成」——
       * 记成 invalid 会把一次超时变成最长 7 天的假红灯（`RUNTIME_VERIFIED_TTL_MS`）。
       */
      if (precheck.ok) await this.recordVerified("douyin", "valid");
      else if (precheck.exitCode === 0) await this.recordVerified("douyin", "invalid");

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
    patch: { status: "awaiting_code" | "succeeded" | "failed"; message?: string; draftOnly?: boolean; draftMediaId?: string; outcomeUncertain?: boolean },
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
    // 方案甲（2026-09-20 拍板：**打包时**裁成 3:4）——
    // 所以所有图文包（含纯抖音包）的 `images/` 都是裁好的 3:4，预览看到的就是发出去的。
    // 裁切失败就让整个建包失败（暂存目录事务会回滚），绝不留半成品或未裁的原图。
    const prepared = await this.prepareNoteImages(snapshots.sourceImagePaths ?? []);
    try {
      return await this.createNotePackage({
        sourceJobId: input.sourceJobId,
        title: requireTitle(input.title),
        noteCopy,
        drafts,
        actor,
        ...(prepared ? { sourceImagePaths: prepared.paths } : {}),
        ...(input.xhsOptions ? { xhsOptions: input.xhsOptions } : {}),
      });
    } finally {
      if (prepared) await prepared.cleanup();
    }
  }

  /**
   * 把源图裁成 3:4，放进一个临时工作目录，返回**裁好的绝对路径**与清理闭包。
   *
   * 为什么放在服务层而不是打包层：打包层的事务只做「复制 + 逐张 sha256 校验 + 清单哈希」，
   * 不该在里面起 ffmpeg 子进程（那也是 `wechat-media` 那条「打包层不转码」的既有纪律）。
   * 传 `sourceImagePaths` 显式给打包层，等于把「裁好的图」当成唯一素材来源。
   *
   * 空清单 → 返回 `undefined`（沿用「缺图也把包建出来、只标 `missing_images`」的既有口径）。
   */
  private async prepareNoteImages(sourceImagePaths: string[]): Promise<
    { paths: string[]; cleanup: () => Promise<void> } | undefined
  > {
    if (sourceImagePaths.length === 0) return undefined;
    const media = this.deps.noteMedia ?? new NoteMediaService(
      this.deps.ffmpegBinary ? { ffmpegBinary: this.deps.ffmpegBinary } : {},
    );
    const workDir = path.join(this.storageRoot, "cache", "note-prepare", this.createId());
    await mkdir(workDir, { recursive: true });
    const cleanup = async (): Promise<void> => {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    };
    try {
      const paths: string[] = [];
      for (const [index, sourcePath] of sourceImagePaths.entries()) {
        const prepared = await media.prepareNoteImage(sourcePath, workDir, index + 1);
        paths.push(prepared.path);
      }
      return { paths, cleanup };
    } catch (error) {
      // 起步就失败也必须清干净，别在 cache 里留一堆半成品。
      await cleanup();
      throw error;
    }
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
    expectedImageHashes?: string[];
    /** 仅小红书：AI 标识声明与「是否真点发布」（进指纹，故必须原样落进包记录）。 */
    xhsOptions?: XhsNoteOptions;
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
        if (input.expectedImageHashes && assets.imageManifestSha256 !== imageManifestHash(input.expectedImageHashes)) {
          await assets.rollback();
          throw new PublishingServiceError(409, "publish_validation_failed", "图集图片已变化，请重新生成并预览");
        }
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
            // 只在给出时落库：`undefined` 与「压根没有这个字段」在指纹里必须完全等价（Task 3 的基线用例）。
            ...(input.xhsOptions
              ? { xhsOptions: { aiDeclaration: input.xhsOptions.aiDeclaration, submit: input.xhsOptions.submit } }
              : {}),
            createdBy: structuredClone(input.actor),
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          rollback: assets.rollback,
        };
      },
    });
  }

  /** Internal gallery boundary: paths are resolved and hash-checked by GalleryService, never from HTTP. */
  async createGalleryNote(input: {
    sourceJobId: string; title: string; noteCopy: PlatformCopy; sourceImagePaths: string[]; expectedImageHashes: string[];
  }, actor: ActorSnapshot): Promise<PublishingPackageDetail> {
    validateSafeId(input.sourceJobId);
    const job = await this.deps.jobs.get(input.sourceJobId);
    if (!job || job.deletedAt) throw new PublishingServiceError(404, "publish_job_not_found");
    const copy = normalizePlatformCopy(input.noteCopy);
    const violations = validateNoteCopy("douyin", copy);
    if (!copy.title.trim() || violations.length || input.sourceImagePaths.length < 1 || input.sourceImagePaths.length > MAX_NOTE_IMAGES
      || input.expectedImageHashes.length !== input.sourceImagePaths.length) {
      throw new PublishingServiceError(422, "publish_validation_failed", violations[0]?.message ?? "字幕图集需有效标题和图片");
    }
    return this.createNotePackage({ ...input, noteCopy: copy, actor,
      drafts: validateDrafts([{ platform: "douyin", copy, copySource: "user_edited" }], this.now()),
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
 * 图文发布接通的平台：抖音（外部 `sau douyin upload-note`）与小红书（自研执行器）。
 *
 * **这是一道「图文口径」的闸门，不含微信公众号、也不含头条，也不该含**：它们走的是 article 通路
 * （标题 32 / 摘要 120 / 正文是渲染出来的 HTML 或 2 万字正文），塞进这里会拿图文口径去校验文章。
 * **导出**供守卫用例断言它是严格子集。
 */
export const NOTE_PLATFORMS = new Set<PublishPlatform>(["douyin", "xiaohongshu"]);

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
  if (platforms.length !== 1) throw new PublishingServiceError(422, "publish_article_platform_unsupported", "文章包每次只选择一个平台");
  for (const platform of platforms) {
    if (platform !== "toutiao" && platform !== "wechat_mp") {
      throw new PublishingServiceError(
        422,
        "publish_article_platform_unsupported",
        `平台 ${platform} 尚未接入文章发布，目前支持今日头条与微信公众号草稿`,
      );
    }
  }
}

function articleLimitsFor(wechat: boolean) {
  return wechat ? { titleMin: 1, titleMax: WECHAT_ARTICLE_LIMITS.title, bodyChars: WECHAT_ARTICLE_LIMITS.contentChars - 1 }
    : { titleMin: TOUTIAO_ARTICLE_LIMITS.titleMin, titleMax: TOUTIAO_ARTICLE_LIMITS.titleMax, bodyChars: TOUTIAO_ARTICLE_LIMITS.bodyChars };
}

function articleCoverKey(cover: string, images: ResolvedAssetFile[]): string {
  return images.length ? JSON.stringify([cover, ...images.map(image => image.record.id)]) : cover;
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
        `平台 ${platform} 尚未接入图文发布，目前只支持抖音图文与小红书图文`,
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
