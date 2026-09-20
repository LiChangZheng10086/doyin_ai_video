import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  ActorSnapshot,
  DeliveryPackage,
  DueNotification,
  PackageContentType,
  PackageVideoMethod,
  PlatformCopy,
  PublishAssetHealth,
  PublishingIndex,
  PublishingPackageDetail,
  PublishTask,
  WechatArticleCopy,
} from "../types.js";
import { buildPublishText } from "./publishing-platforms.js";

/**
 * 允许进入交付包的平台清单。
 *
 * **导出**是为了让「平台清单一致性守卫」用例（`publishing-platforms.test.ts`）能直接断言它 ——
 * 这个 `new Set([...])` 字面量是编译器兜不住的静默点之一。
 */
export const APPROVED_PLATFORMS = new Set([
  "douyin",
  "xiaohongshu",
  "wechat_channels",
  "bilibili",
  "wechat_mp",
  "toutiao",
]);
const TEMP_STALE_MS = 60 * 60 * 1000;
const MAX_COVER_BYTES = 20 * 1024 * 1024;
/** 抖音图文单次图片上限（spec §4：images 非空且 ≤35 张）。导出给服务层与预览共用同一份数字。 */
export const MAX_NOTE_IMAGES = 35;
/** 文章 HTML 的大小上限（我们自己的渲染产物，正常只有几十 KB；超过必然是异常文件）。 */
const MAX_ARTICLE_HTML_BYTES = 2 * 1024 * 1024;
/** 单张图文素材上限，与素材库图片口径一致。 */
const MAX_NOTE_IMAGE_BYTES = 20 * 1024 * 1024;
const NOTE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
/** 场景静帧文件名：`frame-<场景号>-at-<秒>s.png`（场景号是排序依据）。 */
const SCENE_SNAPSHOT_PATTERN = /^frame-(\d+)(?:-.*)?\.(?:png|jpe?g|webp)$/iu;
const ASSET_LOCKS = new Map<string, Promise<void>>();
const PROJECTION_GENERATIONS = new Map<string, number>();
const LIVE_TEMP_PATHS = new Set<string>();

export type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface PackageAssetInput {
  packageId: string;
  sourceJobId: string;
  version: number;
  sourceVideoPath: string;
  sourceVideo?: BoundSourceVideo;
  sourceCoverPath?: string;
  title: string;
  tasks: PublishTask[];
  actor: ActorSnapshot;
}

export interface BoundSourceVideo {
  path: string;
  handle: FileHandle;
  size: number;
  identity: FileIdentity;
}

export interface PackageAssetResult {
  packagePath: string;
  videoPath: string;
  coverPath?: string;
  videoSha256: string;
  videoSize: number;
  videoMethod: PackageVideoMethod;
  assetHealth: PublishAssetHealth;
  /** 视频入口固定产出 `video`；图文包走 `createNotePackageAssets`。 */
  contentType: "video";
  rollback(): Promise<void>;
}

/** 打包过程中「不致命但必须明确告知」的问题，形状与 `PublishingAssetInspection.warnings` 一致。 */
export interface PackageAssetWarning {
  code: string;
  message: string;
}

export interface NotePackageAssetInput {
  packageId: string;
  sourceJobId: string;
  version: number;
  /**
   * 图文素材的绝对路径，**按传入顺序**进包（素材库多选即按选择顺序）。
   * 省略时按场景序自动收集该任务 `hyperframes/snapshots/frame-*.png`。
   */
  sourceImagePaths?: string[];
  noteCopy: PlatformCopy;
  title: string;
  tasks: PublishTask[];
  actor: ActorSnapshot;
}

export interface NotePackageAssetResult {
  packagePath: string;
  contentType: "note";
  /** 包内相对路径，按场景序（或素材选择顺序），如 `images/01.png`。 */
  imagePaths: string[];
  /** 各图 sha256 有序拼接后再哈希；note 包的完整性凭据（video* 字段对图文包不适用）。 */
  imageManifestSha256: string;
  imageCount: number;
  imageSize: number;
  assetHealth: PublishAssetHealth;
  warnings: PackageAssetWarning[];
  rollback(): Promise<void>;
}

/**
 * 文章包（微信公众号）打包输入。
 *
 * 与 note 包的关键差别：
 * - **正文是一整份渲染好的 HTML**（含图片占位符 `{{wechat-image-N}}`），落进包内 `article.html`；
 * - **配图是正文插图而不是内容主体**，所以「一张图都没有」是合法状态；
 * - 图片必须是**已经被 `wechat-media` 处理过**的产物（jpg、<1MB）：`uploadimg` 只收 jpg/png 且 <1MB，
 *   打包层只负责复制与哈希，**不负责转码**（转码不该出现在这个安全加固过的复制事务里）。
 */
export interface ArticlePackageAssetInput {
  packageId: string;
  sourceJobId: string;
  version: number;
  /** 已渲染的微信兼容 HTML；图片用 `{{wechat-image-N}}` 占位，提交时替换成 mmbiz URL。 */
  articleHtml: string;
  /** 正文配图源文件绝对路径，**按传入顺序**（下标 + 1 = 占位符序号）。 */
  sourceImagePaths?: string[];
  /** 封面源文件绝对路径（2.35:1 由 `wechat-media` 裁好）。缺省 → `missing_cover`。 */
  sourceCoverPath?: string;
  /** 文章文案（不含 `htmlSha256`，那个由打包算出）。 */
  articleCopy: Omit<WechatArticleCopy, "htmlSha256">;
  title: string;
  tasks: PublishTask[];
  actor: ActorSnapshot;
}

export interface ArticlePackageAssetResult {
  packagePath: string;
  contentType: "article";
  /** 包内相对路径，按传入顺序，如 `images/01.jpg`。 */
  imagePaths: string[];
  imageManifestSha256: string;
  imageCount: number;
  imageSize: number;
  /** 包内 `article.html` 的绝对路径。 */
  articlePath: string;
  /** `article.html` 的 sha256。 */
  htmlSha256: string;
  /** 已复制进包的封面绝对路径（`cover.jpg`）；未提供封面时为 undefined。 */
  coverPath?: string;
  assetHealth: PublishAssetHealth;
  warnings: PackageAssetWarning[];
  rollback(): Promise<void>;
}

type StagingTarget = {
  tempPath: string;
  tempIdentity: FileIdentity;
};

type StagedPackage<T> = {
  packagePath: string;
  payload: T;
  rollback(): Promise<void>;
};

type StagedVideoContent = {
  videoSha256: string;
  videoSize: number;
  videoMethod: PackageVideoMethod;
  stagedCoverPath?: string;
  assetHealth: PublishAssetHealth;
};

type StagedNoteContent = {
  imagePaths: string[];
  imageManifestSha256: string;
  imageCount: number;
  imageSize: number;
  assetHealth: PublishAssetHealth;
};

type StagedArticleContent = {
  imagePaths: string[];
  imageManifestSha256: string;
  imageCount: number;
  imageSize: number;
  articlePath: string;
  htmlSha256: string;
  /** 暂存目录里的封面路径；对外要换成**提升后的**包路径（与视频封面同一口径）。 */
  stagedCoverPath?: string;
  assetHealth: PublishAssetHealth;
};

export interface ProjectionTransaction {
  commit(): Promise<void>;
  finalize(): Promise<void>;
  rollback(): Promise<void>;
}

export interface PublishingRecoveryFailure {
  packageId?: string;
  path?: string;
  code: string;
  message: string;
}

export interface PublishingRecoveryReport {
  removedTempPaths: string[];
  orphanPaths: string[];
  repairedPackageIds: string[];
  brokenPackageIds: string[];
  repairFailures: PublishingRecoveryFailure[];
  scanFailures: PublishingRecoveryFailure[];
  notifications: DueNotification[];
  purgedPackageIds: string[];
  purgeFailures: Array<{ packageId: string; message: string }>;
}

type PublishingAssetErrorCode =
  | "publish_clone_failed"
  | "publish_revision_conflict"
  | "publish_storage_full"
  | "publish_video_missing"
  | "publish_video_unreadable"
  | "publish_images_missing"
  | "publish_image_unreadable"
  | "publish_too_many_images";

const ERROR_MESSAGES: Record<PublishingAssetErrorCode, string> = {
  publish_clone_failed: "成片复制失败，请检查磁盘空间和文件权限",
  publish_revision_conflict: "发布投影已被其他操作修改，请刷新后重试",
  publish_storage_full: "存储空间不足，无法创建发布包",
  publish_video_missing: "未找到可用成片，请重新生成视频",
  publish_video_unreadable: "成片文件不可读取，请检查文件权限后重试",
  publish_images_missing: "未找到可用的图文素材，请先生成视频静帧或从素材库选择图片",
  publish_image_unreadable: "图文素材不可读取，请检查文件权限后重试",
  publish_too_many_images: "图文素材超过 35 张上限，请减少图片后重试",
};

export class PublishingAssetError extends Error {
  readonly status = 422;

  constructor(readonly code: PublishingAssetErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PublishingAssetError";
  }
}

type AssetDependencies = {
  storageRoot: string;
  copyFile?: typeof copyFile;
  rename?: typeof rename;
  rm?: typeof rm;
  runCommand?: CommandRunner;
  now?: () => Date;
};

export type FileIdentity = Pick<Stats, "dev" | "ino">;

type DirectorySnapshot = {
  directories: string[];
  files: Map<string, Buffer>;
};

type RootContext = {
  storageRoot: string;
  publishingRoot: string;
  publishingIdentity: FileIdentity;
};

type OpenSourceVideo = {
  path: string;
  handle: FileHandle;
  initialStats: Stats;
  initialSha256: string;
  ownsHandle: boolean;
  requirePathIdentity: boolean;
};

export class PublishingAssetService {
  private readonly copyFile: typeof copyFile;
  private readonly rename: typeof rename;
  private readonly rm: typeof rm;
  private readonly runCommand: CommandRunner;
  private readonly now: () => Date;

  constructor(private readonly deps: AssetDependencies) {
    this.copyFile = deps.copyFile ?? copyFile;
    this.rename = deps.rename ?? rename;
    this.rm = deps.rm ?? rm;
    this.runCommand = deps.runCommand ?? runCommand;
    this.now = deps.now ?? (() => new Date());
  }

  async createPackageAssets(input: PackageAssetInput): Promise<PackageAssetResult> {
    validateSegment(input.packageId);
    validateSegment(input.sourceJobId);
    validateVersion(input.version);
    validateProjectionTasks(input.packageId, input.tasks);

    return this.withAssetLock(async (context) => {
      const source = await this.openSourceVideo(input.sourceVideoPath, context.storageRoot, input.sourceVideo);
      try {
        const staged = await this.withStagedPackage(
          context,
          { sourceJobId: input.sourceJobId, packageId: input.packageId, version: input.version },
          ({ tempPath, tempIdentity }) => this.stageVideoContent(input, source, tempPath, tempIdentity, context),
        );

        return {
          packagePath: staged.packagePath,
          videoPath: path.join(staged.packagePath, "video.mp4"),
          coverPath: staged.payload.stagedCoverPath ? path.join(staged.packagePath, "cover.jpg") : undefined,
          videoSha256: staged.payload.videoSha256,
          videoSize: staged.payload.videoSize,
          videoMethod: staged.payload.videoMethod,
          assetHealth: staged.payload.assetHealth,
          contentType: "video",
          rollback: staged.rollback,
        };
      } finally {
        if (source.ownsHandle) await source.handle.close().catch(() => undefined);
      }
    });
  }

  /**
   * 图文（抖音图文）打包入口。
   *
   * 与视频入口**并列**而不是在 `createPackageAssets` 里分支：两者的资产校验、
   * 错误码与必需字段都不同，混在一起会让两套规则互相纠缠。
   * 共同的部分（锁、临时目录、目录身份校验、原子提升、回滚）只有一份实现 —— `withStagedPackage`。
   */
  async createNotePackageAssets(input: NotePackageAssetInput): Promise<NotePackageAssetResult> {
    validateSegment(input.packageId);
    validateSegment(input.sourceJobId);
    validateVersion(input.version);
    validateProjectionTasks(input.packageId, input.tasks);

    return this.withAssetLock(async (context) => {
      const sourceImagePaths = input.sourceImagePaths
        ?? await collectSceneSnapshots(context.storageRoot, input.sourceJobId);
      // 平台硬限制（≤35 张）在写盘前就拦掉，不产生任何包目录。
      if (sourceImagePaths.length > MAX_NOTE_IMAGES) {
        throw new PublishingAssetError("publish_too_many_images");
      }

      const staged = await this.withStagedPackage(
        context,
        { sourceJobId: input.sourceJobId, packageId: input.packageId, version: input.version },
        ({ tempPath, tempIdentity }) => this.stageNoteContent(
          input,
          sourceImagePaths,
          tempPath,
          tempIdentity,
          context,
        ),
      );

      return {
        packagePath: staged.packagePath,
        contentType: "note",
        imagePaths: staged.payload.imagePaths,
        imageManifestSha256: staged.payload.imageManifestSha256,
        imageCount: staged.payload.imageCount,
        imageSize: staged.payload.imageSize,
        assetHealth: staged.payload.assetHealth,
        // 一张图都没有时不抛错（包仍自包含地建出来，与 missing_cover 同一口径），
        // 但必须把「为什么发不出去」明确报出来。
        warnings: staged.payload.imageCount > 0
          ? []
          : [{ code: "publish_images_missing", message: ERROR_MESSAGES.publish_images_missing }],
        rollback: staged.rollback,
      };
    });
  }

  /**
   * 微信公众号文章包打包入口。
   *
   * 与视频/图文入口并列，理由同 `createNotePackageAssets`：三条通路的资产校验与必需字段
   * 各不相同，混进一个函数会让规则互相纠缠；而共同的部分（锁、临时目录、目录身份校验、
   * 原子提升、回滚）仍然只有 `withStagedPackage` 一份实现。
   */
  async createArticlePackageAssets(
    input: ArticlePackageAssetInput,
  ): Promise<ArticlePackageAssetResult> {
    validateSegment(input.packageId);
    validateSegment(input.sourceJobId);
    validateVersion(input.version);
    validateProjectionTasks(input.packageId, input.tasks);

    const sourceImagePaths = input.sourceImagePaths ?? [];
    // 正文里要 N 张图却只给了 M<N 张，这个包**永远提交不了** —— 在写盘前就拦掉。
    assertArticleImageCoverage(input.articleHtml, sourceImagePaths.length);

    return this.withAssetLock(async (context) => {
      const staged = await this.withStagedPackage(
        context,
        { sourceJobId: input.sourceJobId, packageId: input.packageId, version: input.version },
        ({ tempPath, tempIdentity }) => this.stageArticleContent(
          input,
          sourceImagePaths,
          tempPath,
          tempIdentity,
          context,
        ),
      );

      return {
        packagePath: staged.packagePath,
        contentType: "article",
        imagePaths: staged.payload.imagePaths,
        imageManifestSha256: staged.payload.imageManifestSha256,
        imageCount: staged.payload.imageCount,
        imageSize: staged.payload.imageSize,
        articlePath: path.join(staged.packagePath, "article.html"),
        htmlSha256: staged.payload.htmlSha256,
        // 暂存目录里的路径不能对外暴露：提升之后它已经不存在了（与视频封面同一处理）。
        coverPath: staged.payload.stagedCoverPath
          ? path.join(staged.packagePath, "cover.jpg")
          : undefined,
        assetHealth: staged.payload.assetHealth,
        // 文章包没有需要「明确告知」的降级：缺正文图是合法选择，缺封面已体现在 assetHealth 里。
        warnings: [],
        rollback: staged.rollback,
      };
    });
  }

  /**
   * 包裹「暂存目录事务」：临时目录 → 写内容 → 原子提升 → 回滚闭包。
   *
   * 视频与图文两条入口共用这一份实现：安全校验（根目录/目录身份/直接子项断言）
   * 只允许有一个真源，各写一份等于把加固措施拆散。
   */
  private async withStagedPackage<T>(
    context: RootContext,
    ids: { sourceJobId: string; packageId: string; version: number },
    writeContent: (staging: StagingTarget) => Promise<T>,
  ): Promise<StagedPackage<T>> {
    const sourceDirectory = path.join(context.publishingRoot, ids.sourceJobId);
    const tempPath = path.join(sourceDirectory, `.next-${ids.packageId}`);
    const packagePath = expectedPackagePath(context.publishingRoot, ids.sourceJobId, ids.version, ids.packageId);
    let tempIdentity: FileIdentity | undefined;
    let promotionIdentity: FileIdentity | undefined;
    LIVE_TEMP_PATHS.add(tempPath);

    try {
      const sourceIdentity = await ensureDirectDirectory(
        context.publishingRoot,
        context.publishingIdentity,
        ids.sourceJobId,
      );
      await this.safeRemoveDirect(context, sourceDirectory, sourceIdentity, tempPath);
      await this.assertRootAndDirectory(context, sourceDirectory, sourceIdentity);
      await mkdir(tempPath);
      const stagingIdentity = await requireDirectoryIdentity(tempPath);
      tempIdentity = stagingIdentity;
      await this.assertRootAndDirectory(context, sourceDirectory, sourceIdentity);

      const payload = await writeContent({ tempPath, tempIdentity: stagingIdentity });

      await this.assertRootAndDirectory(context, tempPath, stagingIdentity);
      if (await pathExistsNoFollow(packagePath)) {
        throw new PublishingAssetError("publish_clone_failed");
      }
      promotionIdentity = stagingIdentity;
      await this.safeRenameDirect(context, sourceDirectory, sourceIdentity, tempPath, packagePath, promotionIdentity);
      LIVE_TEMP_PATHS.delete(tempPath);

      let rolledBack = false;
      const promotedIdentity = promotionIdentity;

      return {
        packagePath,
        payload,
        rollback: async () => {
          if (rolledBack) return;
          await this.withAssetLock(async (currentContext) => {
            const expected = expectedPackagePath(
              currentContext.publishingRoot,
              ids.sourceJobId,
              ids.version,
              ids.packageId,
            );
            if (expected !== packagePath) throw new PublishingAssetError("publish_revision_conflict");
            const currentSourceIdentity = await requireDirectDirectory(
              currentContext.publishingRoot,
              currentContext.publishingIdentity,
              ids.sourceJobId,
            );
            if (!await pathExistsNoFollow(packagePath)) {
              rolledBack = true;
              return;
            }
            await requireMatchingDirectory(packagePath, promotedIdentity);
            await this.safeRemoveDirect(currentContext, sourceDirectory, currentSourceIdentity, packagePath, promotedIdentity);
            rolledBack = true;
          });
        },
      };
    } catch (error) {
      const formalStats = await optionalLstat(packagePath).catch(() => undefined);
      if (promotionIdentity && formalStats && sameIdentity(formalStats, promotionIdentity)) {
        await this.safeRemoveDirect(context, sourceDirectory, undefined, packagePath, promotionIdentity).catch(() => undefined);
      } else if (tempIdentity) {
        await this.safeRemoveDirect(context, sourceDirectory, undefined, tempPath, tempIdentity).catch(() => undefined);
      }
      throw normalizeAssetError(error);
    } finally {
      LIVE_TEMP_PATHS.delete(tempPath);
    }
  }

  /** 视频分支的内容阶段：与重构前逐字一致（含 manifest 的字段顺序）。 */
  private async stageVideoContent(
    input: PackageAssetInput,
    source: OpenSourceVideo,
    tempPath: string,
    tempIdentity: FileIdentity,
    context: RootContext,
  ): Promise<StagedVideoContent> {
    const stagedVideoPath = path.join(tempPath, "video.mp4");
    const videoMethod = await this.copyVerified(source, stagedVideoPath, context, tempIdentity);
    const videoStats = await stat(stagedVideoPath);
    const videoSha256 = await hashFilePath(stagedVideoPath);
    const stagedCoverPath = await this.prepareCover(
      input.sourceCoverPath,
      stagedVideoPath,
      tempPath,
      context,
      tempIdentity,
    );
    const assetHealth: PublishAssetHealth = stagedCoverPath ? "healthy" : "missing_cover";

    await this.assertRootAndDirectory(context, tempPath, tempIdentity);
    await writePlatformProjection(path.join(tempPath, "platforms"), input.tasks);
    await this.assertRootAndDirectory(context, tempPath, tempIdentity);
    await writeFile(path.join(tempPath, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      package: {
        id: input.packageId,
        sourceJobId: input.sourceJobId,
        version: input.version,
        title: input.title,
        createdBy: {
          userId: input.actor.userId,
          displayName: input.actor.displayName,
          role: input.actor.role,
        },
        createdAt: this.now().toISOString(),
      },
      video: {
        path: "video.mp4",
        sha256: videoSha256,
        size: videoStats.size,
        method: videoMethod,
      },
      cover: stagedCoverPath ? { path: "cover.jpg" } : null,
      assetHealth,
      tasks: input.tasks.map((task) => ({
        id: task.id,
        platform: task.platform,
        videoPath: "video.mp4",
        title: task.title,
        description: task.description,
        hashtags: [...task.hashtags],
        copySource: task.copySource,
        status: task.status,
        scheduledAt: task.scheduledAt,
        contentRevision: task.contentRevision,
      })),
    }, null, 2), "utf8");

    return { videoSha256, videoSize: videoStats.size, videoMethod, stagedCoverPath, assetHealth };
  }

  /** 图文分支的内容阶段：按序复制静帧 + 平台投影 + 图文 manifest。 */
  private async stageNoteContent(
    input: NotePackageAssetInput,
    sourceImagePaths: string[],
    tempPath: string,
    tempIdentity: FileIdentity,
    context: RootContext,
  ): Promise<StagedNoteContent> {
    const images = await this.copyOrderedImages(sourceImagePaths, tempPath, tempIdentity, context);
    const assetHealth: PublishAssetHealth = images.paths.length > 0 ? "healthy" : "missing_images";

    await this.assertRootAndDirectory(context, tempPath, tempIdentity);
    await writePlatformProjection(path.join(tempPath, "platforms"), input.tasks);
    await this.assertRootAndDirectory(context, tempPath, tempIdentity);
    await writeFile(path.join(tempPath, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      package: {
        id: input.packageId,
        sourceJobId: input.sourceJobId,
        version: input.version,
        title: input.title,
        createdBy: {
          userId: input.actor.userId,
          displayName: input.actor.displayName,
          role: input.actor.role,
        },
        createdAt: this.now().toISOString(),
      },
      contentType: "note",
      images: {
        paths: [...images.paths],
        count: images.paths.length,
        size: images.size,
        manifestSha256: images.manifestSha256,
      },
      note: {
        title: input.noteCopy.title,
        description: input.noteCopy.description,
        hashtags: [...input.noteCopy.hashtags],
      },
      assetHealth,
      tasks: input.tasks.map((task) => ({
        id: task.id,
        platform: task.platform,
        imagePaths: [...images.paths],
        title: task.title,
        description: task.description,
        hashtags: [...task.hashtags],
        copySource: task.copySource,
        status: task.status,
        scheduledAt: task.scheduledAt,
        contentRevision: task.contentRevision,
      })),
    }, null, 2), "utf8");

    return {
      imagePaths: images.paths,
      imageManifestSha256: images.manifestSha256,
      imageCount: images.paths.length,
      imageSize: images.size,
      assetHealth,
    };
  }

  /**
   * 微信公众号文章包的暂存内容。
   *
   * 与 `stageNoteContent` 的差别只有三处：多了 `article.html`、多了封面复制、
   * `assetHealth` 的判定不同（缺封面 → `missing_cover`；**缺正文图不算问题**，
   * 因为文章的内容是文字，配图是可选的）。
   */
  private async stageArticleContent(
    input: ArticlePackageAssetInput,
    sourceImagePaths: string[],
    tempPath: string,
    tempIdentity: FileIdentity,
    context: RootContext,
  ): Promise<StagedArticleContent> {
    const images = await this.copyOrderedImages(sourceImagePaths, tempPath, tempIdentity, context);
    const stagedCoverPath = input.sourceCoverPath
      ? await this.copyArticleCover(input.sourceCoverPath, tempPath, tempIdentity, context)
      : undefined;
    const assetHealth: PublishAssetHealth = stagedCoverPath ? "healthy" : "missing_cover";

    await this.assertRootAndDirectory(context, tempPath, tempIdentity);
    const articlePath = path.join(tempPath, "article.html");
    const htmlBytes = Buffer.from(input.articleHtml ?? "", "utf8");
    await writeFile(articlePath, htmlBytes);
    const htmlSha256 = createHash("sha256").update(htmlBytes).digest("hex");

    await this.assertRootAndDirectory(context, tempPath, tempIdentity);
    await writePlatformProjection(path.join(tempPath, "platforms"), input.tasks);
    await this.assertRootAndDirectory(context, tempPath, tempIdentity);
    await writeFile(path.join(tempPath, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      package: {
        id: input.packageId,
        sourceJobId: input.sourceJobId,
        version: input.version,
        title: input.title,
        createdBy: {
          userId: input.actor.userId,
          displayName: input.actor.displayName,
          role: input.actor.role,
        },
        createdAt: this.now().toISOString(),
      },
      contentType: "article",
      images: {
        paths: [...images.paths],
        count: images.paths.length,
        size: images.size,
        manifestSha256: images.manifestSha256,
      },
      article: {
        path: "article.html",
        title: input.articleCopy.title,
        digest: input.articleCopy.digest ?? null,
        author: input.articleCopy.author ?? null,
        htmlSha256,
      },
      cover: stagedCoverPath ? "cover.jpg" : null,
      assetHealth,
      tasks: input.tasks.map((task) => ({
        id: task.id,
        platform: task.platform,
        imagePaths: [...images.paths],
        title: task.title,
        description: task.description,
        hashtags: [...task.hashtags],
        copySource: task.copySource,
        status: task.status,
        scheduledAt: task.scheduledAt,
        contentRevision: task.contentRevision,
      })),
    }, null, 2), "utf8");

    return {
      imagePaths: images.paths,
      imageManifestSha256: images.manifestSha256,
      imageCount: images.paths.length,
      imageSize: images.size,
      articlePath,
      htmlSha256,
      stagedCoverPath,
      assetHealth,
    };
  }

  /** 把封面复制进包根 `cover.jpg`（内容与源逐字节一致，复制后立即校验）。 */
  private async copyArticleCover(
    sourceCoverPath: string,
    tempPath: string,
    tempIdentity: FileIdentity,
    context: RootContext,
  ): Promise<string | undefined> {
    const source = await resolveReadableFile(context.storageRoot, sourceCoverPath, {
      extensions: NOTE_IMAGE_EXTENSIONS,
      maxBytes: MAX_COVER_BYTES,
      code: "publish_image_unreadable",
    });
    const destination = path.join(tempPath, "cover.jpg");
    assertDirectChild(tempPath, destination);
    const sourceSha256 = await hashImageFile(source);
    await this.assertRootAndDirectory(context, tempPath, tempIdentity);
    await this.copyFile(source, destination, constants.COPYFILE_EXCL);
    await this.assertRootAndDirectory(context, tempPath, tempIdentity);
    if (await hashImageFile(destination) !== sourceSha256) {
      throw new PublishingAssetError("publish_image_unreadable");
    }
    return destination;
  }

  /**
   * 按传入顺序把图片复制进 `images/NN.ext`，并算出图片清单哈希。
   *
   * **图文包与文章包共用这一份实现**：两者的复制、逐张 sha256 校验与顺序敏感哈希
   * 完全一致，各写一份等于把「复制后必须校验」这条纪律拆成两处。
   */
  private async copyOrderedImages(
    sourceImagePaths: string[],
    tempPath: string,
    tempIdentity: FileIdentity,
    context: RootContext,
  ): Promise<{ paths: string[]; manifestSha256: string; size: number }> {
    if (sourceImagePaths.length === 0) {
      return { paths: [], manifestSha256: imageManifestHash([]), size: 0 };
    }

    const imagesDirectory = path.join(tempPath, "images");
    await this.assertRootAndDirectory(context, tempPath, tempIdentity);
    await mkdir(imagesDirectory);
    const imagesIdentity = await requireDirectoryIdentity(imagesDirectory);

    const paths: string[] = [];
    const hashes: string[] = [];
    let size = 0;
    for (const [index, sourceImagePath] of sourceImagePaths.entries()) {
      const source = await resolveReadableFile(context.storageRoot, sourceImagePath, {
        extensions: NOTE_IMAGE_EXTENSIONS,
        maxBytes: MAX_NOTE_IMAGE_BYTES,
        code: "publish_image_unreadable",
      });
      const fileName = `${String(index + 1).padStart(2, "0")}${path.extname(source).toLowerCase()}`;
      const destination = path.join(imagesDirectory, fileName);
      assertDirectChild(imagesDirectory, destination);

      const sourceSha256 = await hashImageFile(source);
      await this.assertRootAndDirectory(context, imagesDirectory, imagesIdentity);
      await this.copyFile(source, destination, constants.COPYFILE_EXCL);
      await this.assertRootAndDirectory(context, imagesDirectory, imagesIdentity);
      if (await hashImageFile(destination) !== sourceSha256) {
        throw new PublishingAssetError("publish_image_unreadable");
      }

      paths.push(path.posix.join("images", fileName));
      hashes.push(sourceSha256);
      size += (await stat(destination)).size;
    }

    return { paths, manifestSha256: imageManifestHash(hashes), size };
  }

  async stageTextProjection(detail: PublishingPackageDetail): Promise<ProjectionTransaction> {
    validateProjectionTasks(detail.package.id, detail.tasks);

    return this.withAssetLock(async (context) => {
      const packageBinding = await requireExpectedPackage(context, detail.package, true);
      const packagePath = packageBinding.path;
      const targetPath = path.join(packagePath, "platforms");
      const transactionId = randomUUID();
      const tempPath = path.join(packagePath, `.next-platforms-${transactionId}`);
      const backupPath = path.join(packagePath, `.previous-platforms-${transactionId}`);
      const previousSnapshot = await snapshotManagedDirectory(packagePath, packageBinding.identity, targetPath);
      const stagedFingerprint = fingerprintSnapshot(previousSnapshot);
      const stagedGeneration = PROJECTION_GENERATIONS.get(packagePath) ?? 0;

      await this.safeRemoveDirect(context, packagePath, packageBinding.identity, tempPath);
      await this.assertRootAndDirectory(context, packagePath, packageBinding.identity);
      await mkdir(tempPath);
      const tempIdentity = await requireDirectoryIdentity(tempPath);
      LIVE_TEMP_PATHS.add(tempPath);
      try {
        await writePlatformProjection(tempPath, detail.tasks);
        await this.assertRootAndDirectory(context, tempPath, tempIdentity);
      } catch (error) {
        await this.safeRemoveDirect(context, packagePath, packageBinding.identity, tempPath, tempIdentity).catch(() => undefined);
        LIVE_TEMP_PATHS.delete(tempPath);
        throw normalizeAssetError(error);
      }

      let state: "staged" | "committed" | "finalized" | "rolled_back" = "staged";
      let backupIdentity: FileIdentity | undefined;
      let committedGeneration: number | undefined;
      let committedFingerprint: string | undefined;
      const hadPrevious = previousSnapshot !== undefined;

      return {
        commit: async () => {
          await this.withAssetLock(async (currentContext) => {
            if (state === "committed") return;
            if (state !== "staged") throw new PublishingAssetError("publish_revision_conflict");
            const currentPackage = await requireExpectedPackage(currentContext, detail.package, true);
            await requireMatchingDirectory(packagePath, packageBinding.identity);
            const currentGeneration = PROJECTION_GENERATIONS.get(packagePath) ?? 0;
            const currentSnapshot = await snapshotManagedDirectory(packagePath, currentPackage.identity, targetPath);
            if (currentGeneration !== stagedGeneration || fingerprintSnapshot(currentSnapshot) !== stagedFingerprint) {
              await this.safeRemoveDirect(currentContext, packagePath, currentPackage.identity, tempPath, tempIdentity).catch(() => undefined);
              LIVE_TEMP_PATHS.delete(tempPath);
              state = "rolled_back";
              throw new PublishingAssetError("publish_revision_conflict");
            }

            let targetIdentity: FileIdentity | undefined;
            if (currentSnapshot) targetIdentity = await requireDirectoryIdentity(targetPath);
            let phase: "staged" | "old_backed_up" | "new_promoted" | "committed" = "staged";
            try {
              if (targetIdentity) {
                backupIdentity = targetIdentity;
                await this.safeRenameDirect(
                  currentContext,
                  packagePath,
                  currentPackage.identity,
                  targetPath,
                  backupPath,
                  targetIdentity,
                );
                phase = "old_backed_up";
              }
              await this.safeRenameDirect(
                currentContext,
                packagePath,
                currentPackage.identity,
                tempPath,
                targetPath,
                tempIdentity,
              );
              phase = "new_promoted";
              LIVE_TEMP_PATHS.delete(tempPath);
              committedGeneration = stagedGeneration + 1;
              PROJECTION_GENERATIONS.set(packagePath, committedGeneration);
              committedFingerprint = fingerprintSnapshot(
                await snapshotManagedDirectory(packagePath, currentPackage.identity, targetPath),
              );
              state = "committed";
              phase = "committed";
            } catch (error) {
              const currentTarget = await optionalLstat(targetPath);
              if (currentTarget && sameIdentity(currentTarget, tempIdentity)) {
                phase = "new_promoted";
                await this.safeRemoveDirect(
                  currentContext,
                  packagePath,
                  currentPackage.identity,
                  targetPath,
                  tempIdentity,
                );
              }
              const currentBackup = await optionalLstat(backupPath);
              if (
                backupIdentity
                && currentBackup
                && sameIdentity(currentBackup, backupIdentity)
                && !await pathExistsNoFollow(targetPath)
              ) {
                await this.safeRenameDirect(
                  currentContext,
                  packagePath,
                  currentPackage.identity,
                  backupPath,
                  targetPath,
                  backupIdentity,
                );
              }
              const remainingTemp = await optionalLstat(tempPath);
              if (remainingTemp && sameIdentity(remainingTemp, tempIdentity)) {
                await this.safeRemoveDirect(
                  currentContext,
                  packagePath,
                  currentPackage.identity,
                  tempPath,
                  tempIdentity,
                );
              }
              if (phase !== "committed") PROJECTION_GENERATIONS.set(packagePath, stagedGeneration);
              LIVE_TEMP_PATHS.delete(tempPath);
              state = "rolled_back";
              throw normalizeAssetError(error);
            }
          });
        },
        finalize: async () => {
          await this.withAssetLock(async (currentContext) => {
            if (state === "finalized") return;
            if (state !== "committed") throw new PublishingAssetError("publish_revision_conflict");
            const currentPackage = await requireExpectedPackage(currentContext, detail.package, true);
            if (backupIdentity && await pathExistsNoFollow(backupPath)) {
              await this.safeRemoveDirect(
                currentContext,
                packagePath,
                currentPackage.identity,
                backupPath,
                backupIdentity,
              );
            }
            state = "finalized";
          });
        },
        rollback: async () => {
          await this.withAssetLock(async (currentContext) => {
            if (state === "rolled_back") return;
            const currentPackage = await requireExpectedPackage(currentContext, detail.package, true);
            if (state === "staged") {
              await this.safeRemoveDirect(
                currentContext,
                packagePath,
                currentPackage.identity,
                tempPath,
                tempIdentity,
              );
              LIVE_TEMP_PATHS.delete(tempPath);
              state = "rolled_back";
              return;
            }
            if (state !== "committed") throw new PublishingAssetError("publish_revision_conflict");

            const currentGeneration = PROJECTION_GENERATIONS.get(packagePath) ?? 0;
            const currentFingerprint = fingerprintSnapshot(
              await snapshotManagedDirectory(packagePath, currentPackage.identity, targetPath),
            );
            if (currentGeneration !== committedGeneration || currentFingerprint !== committedFingerprint) {
              throw new PublishingAssetError("publish_revision_conflict");
            }

            const targetIdentity = await requireDirectoryIdentity(targetPath);
            const displacedPath = path.join(packagePath, `.previous-platforms-rollback-${transactionId}`);
            await this.safeRenameDirect(
              currentContext,
              packagePath,
              currentPackage.identity,
              targetPath,
              displacedPath,
              targetIdentity,
            );
            try {
              if (hadPrevious && backupIdentity) {
                await this.safeRenameDirect(
                  currentContext,
                  packagePath,
                  currentPackage.identity,
                  backupPath,
                  targetPath,
                  backupIdentity,
                );
              }
              await this.safeRemoveDirect(
                currentContext,
                packagePath,
                currentPackage.identity,
                displacedPath,
                targetIdentity,
              );
              PROJECTION_GENERATIONS.set(packagePath, currentGeneration + 1);
              state = "rolled_back";
            } catch (error) {
              if (!await pathExistsNoFollow(targetPath) && await pathExistsNoFollow(displacedPath)) {
                await this.safeRenameDirect(
                  currentContext,
                  packagePath,
                  currentPackage.identity,
                  displacedPath,
                  targetPath,
                  targetIdentity,
                ).catch(() => undefined);
              }
              throw normalizeAssetError(error);
            }
          });
        },
      };
    });
  }

  /**
   * **按内容类型分派**的资产体检（article 包没有 `video.mp4`，走视频分支会一律判成 `broken_video`）。
   *
   * 服务层与启动恢复都该用这个入口；`verifyPackageVideo` / `verifyPackageImages` 是
   * 「只按那一种口径查」的专用入口（名字是历史遗留，图文通路仍在用 `verifyPackageImages`）。
   */
  async verifyPackageHealth(pkg: DeliveryPackage): Promise<PublishAssetHealth> {
    return this.withAssetLock((context) => this.verifyPackageHealthUnlocked(context, pkg));
  }

  async verifyPackageVideo(pkg: DeliveryPackage): Promise<PublishAssetHealth> {
    return this.withAssetLock((context) => this.verifyPackageVideoUnlocked(context, pkg));
  }

  /** 图文包的资产体检：包内图片是否齐全、有序、且与记录的清单哈希一致。 */
  async verifyPackageImages(pkg: DeliveryPackage): Promise<PublishAssetHealth> {
    return this.withAssetLock((context) => this.verifyPackageImagesUnlocked(context, pkg));
  }

  /**
   * 读取图文包里第 `index` 张图（0 基，对应 `imagePaths` 的顺序）。
   *
   * 越界、声明越界、文件缺失或不可读一律返回 `null`，由路由决定 404，
   * 路径归属校验复用 `resolveDeclaredImage` 这一份真源。
   */
  async readPackageImage(
    pkg: DeliveryPackage,
    index: number,
  ): Promise<{ bytes: Buffer; extension: string } | null> {
    if (!Number.isSafeInteger(index) || index < 0) return null;
    return this.withAssetLock(async (context) => {
      const binding = await requireExpectedPackage(context, pkg, true, "note");
      const relativePath = (pkg.imagePaths ?? [])[index];
      if (relativePath === undefined) return null;
      const absolutePath = resolveDeclaredImage(binding.path, relativePath);
      const imagesDirectory = path.join(binding.path, "images");
      const imagesIdentity = await requireDirectDirectory(binding.path, binding.identity, "images");
      if (!await isReadableDirectFile(imagesDirectory, imagesIdentity, absolutePath)) return null;
      const stats = await lstat(absolutePath);
      if (stats.size > MAX_NOTE_IMAGE_BYTES) return null;
      const bytes = await readFile(absolutePath);
      return bytes.length === stats.size
        ? { bytes, extension: path.extname(absolutePath).toLowerCase() }
        : null;
    });
  }

  /**
   * 把图文包声明的 `imagePaths`（包内相对路径）解析成**校验过的**绝对路径。
   *
   * 校验与 `verifyPackageImages` 共用 `resolveDeclaredImage` 这一份真源：调用方拿到的是
   * 确定落在本包 `images/` 内的路径，可以直接交给外部 CLI，不需要自己再拼一遍。
   */
  async resolvePackageImages(pkg: DeliveryPackage): Promise<string[]> {
    return this.withAssetLock(async (context) => {
      const binding = await requireExpectedPackage(context, pkg, true, "note");
      const declared = pkg.imagePaths ?? [];
      if (declared.length === 0) throw new PublishingAssetError("publish_images_missing");
      return declared.map((relativePath) => resolveDeclaredImage(binding.path, relativePath));
    });
  }

  /**
   * 读取文章包的 `article.html`（降级通路：把 HTML 交给用户，粘贴进头条编辑器）。
   *
   * 与封面同一套纪律：包路径必须与记录一致、用 `O_NOFOLLOW` 打开、打开后校验 inode 一致，
   * 并限制大小 —— 包目录是磁盘上的普通目录，任何「按记录里的路径直接读」的写法都等于开放
   * 任意文件读取。
   */
  async readPackageArticle(pkg: DeliveryPackage): Promise<Buffer | null> {
    return this.withAssetLock(async (context) => {
      const binding = await requireExpectedPackage(context, pkg, true);
      const articlePath = path.join(binding.path, "article.html");
      let handle: FileHandle | undefined;
      try {
        handle = await open(articlePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = await handle.stat();
        const current = await lstat(articlePath);
        if (
          !opened.isFile()
          || opened.size === 0
          || opened.size > MAX_ARTICLE_HTML_BYTES
          || !sameIdentity(opened, current)
        ) {
          return null;
        }
        const bytes = await handle.readFile();
        return bytes.length === opened.size ? bytes : null;
      } catch {
        return null;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    });
  }

  /**
   * 按包内容类型分派资产体检（图文包没有 `video.mp4`，不能走视频分支；文章包同理）。
   *
   * 文章包（article）的体检口径：正文图清单（有图才查）→ 封面（**头条必填**）→ healthy。
   * 正文 HTML 的完整性不在这里查：它是「提交那一刻」的事，由服务层比对
   * `articleCopy.htmlSha256`（那里失败还能给出可执行的原因，这里只会变成一个健康值）。
   */
  private async verifyPackageHealthUnlocked(
    context: RootContext,
    pkg: DeliveryPackage,
  ): Promise<PublishAssetHealth> {
    if (pkg.contentType === "note") return this.verifyPackageImagesUnlocked(context, pkg);
    if (pkg.contentType === "article") {
      if ((pkg.imagePaths?.length ?? 0) > 0) {
        const images = await this.verifyPackageImagesUnlocked(context, pkg);
        if (images !== "healthy") return images;
      }
      return (await this.readPackageCoverUnlocked(context, pkg)) ? "healthy" : "missing_cover";
    }
    return this.verifyPackageVideoUnlocked(context, pkg);
  }

  async readPackageCover(pkg: DeliveryPackage): Promise<Buffer | null> {
    return this.withAssetLock((context) => this.readPackageCoverUnlocked(context, pkg));
  }

  /**
   * 已持有资产锁时的封面读取。
   *
   * **必须与公开入口分开**：`withAssetLock` 用的是进程锁，**不可重入** ——
   * 在 `verifyPackageHealthUnlocked` 里直接调 `readPackageCover` 会自己等自己，
   * 表现是整个请求/用例**挂住**（不是报错），本项目已实测踩到过一次。
   */
  private async readPackageCoverUnlocked(context: RootContext, pkg: DeliveryPackage): Promise<Buffer | null> {
    if (!pkg.coverPath) return null;
    const binding = await requireExpectedPackage(context, pkg, true);
    const coverPath = path.join(binding.path, "cover.jpg");
    if (path.resolve(pkg.coverPath!) !== coverPath) return null;
    let handle: FileHandle | undefined;
    try {
      handle = await open(coverPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      const current = await lstat(coverPath);
      if (!opened.isFile() || opened.size === 0 || opened.size > MAX_COVER_BYTES || !sameIdentity(opened, current)) {
        return null;
      }
      const bytes = await handle.readFile();
      return bytes.length === opened.size ? bytes : null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async purgeAssets(pkg: DeliveryPackage): Promise<void> {
    await this.withAssetLock(async (context) => {
      const expected = expectedPackagePathFromRecord(context.publishingRoot, pkg);
      assertDeclaredPackagePaths(expected, pkg, pkg.contentType ?? "video");
      if (!await pathExistsNoFollow(expected)) return;
      const binding = await requireExpectedPackage(context, pkg, true);
      const sourceDirectory = path.dirname(expected);
      const sourceIdentity = await requireDirectoryIdentity(sourceDirectory);
      await this.safeRemoveDirect(context, sourceDirectory, sourceIdentity, expected, binding.identity);
      PROJECTION_GENERATIONS.delete(expected);
    });
  }

  async scanAndRepair(index: PublishingIndex): Promise<PublishingRecoveryReport> {
    return this.withAssetLock(async (context) => {
      const report: PublishingRecoveryReport = {
        removedTempPaths: [],
        orphanPaths: [],
        repairedPackageIds: [],
        brokenPackageIds: [],
        repairFailures: [],
        scanFailures: [],
        notifications: [],
        purgedPackageIds: [],
        purgeFailures: [],
      };

      try {
        report.removedTempPaths = await this.removeStaleTemporaryPaths(context, report.scanFailures);
      } catch (error) {
        report.scanFailures.push(recoveryFailure(error, { path: context.publishingRoot }));
      }

      try {
        report.orphanPaths = await findOrphanPackages(context, index, report.scanFailures);
      } catch (error) {
        report.scanFailures.push(recoveryFailure(error, { path: context.publishingRoot }));
      }

      const packageIds = Object.keys(index.packages).sort();
      for (const packageId of packageIds) {
        const pkg = index.packages[packageId];
        if (pkg.state !== "active") continue;
        try {
          const health = await this.verifyPackageHealthUnlocked(context, pkg);
          pkg.assetHealth = health;
          if (health === "broken_video") report.brokenPackageIds.push(packageId);
        } catch (error) {
          pkg.assetHealth = pkg.contentType === "note" ? "missing_images" : "broken_video";
          report.brokenPackageIds.push(packageId);
          report.scanFailures.push(recoveryFailure(error, { packageId }));
        }
      }

      for (const packageId of packageIds) {
        const pkg = index.packages[packageId];
        if (pkg.state !== "active") continue;
        const tasks = Object.values(index.tasks)
          .filter((task) => task.packageId === packageId)
          .sort((a, b) => a.platform.localeCompare(b.platform));
        try {
          const repaired = await this.repairProjectionUnlocked(context, pkg, tasks);
          if (repaired) report.repairedPackageIds.push(packageId);
          await this.removeProjectionBackupsUnlocked(context, pkg, tasks);
        } catch (error) {
          report.repairFailures.push(recoveryFailure(error, { packageId }));
        }
      }

      report.removedTempPaths.sort();
      report.orphanPaths.sort();
      report.repairedPackageIds.sort();
      report.brokenPackageIds = [...new Set(report.brokenPackageIds)].sort();
      return report;
    });
  }

  private async verifyPackageVideoUnlocked(context: RootContext, pkg: DeliveryPackage): Promise<PublishAssetHealth> {
    try {
      const binding = await requireExpectedPackage(context, pkg, true);
      const expectedVideoPath = path.join(binding.path, "video.mp4");
      const videoStats = await lstat(expectedVideoPath);
      if (videoStats.isSymbolicLink() || !videoStats.isFile() || videoStats.size === 0 || videoStats.size !== pkg.videoSize) {
        return "broken_video";
      }
      const canonicalVideoPath = await realpath(expectedVideoPath);
      if (canonicalVideoPath !== expectedVideoPath || await hashFilePath(expectedVideoPath) !== pkg.videoSha256) {
        return "broken_video";
      }
      if (!pkg.coverPath) return "missing_cover";
      const expectedCoverPath = path.join(binding.path, "cover.jpg");
      if (path.resolve(pkg.coverPath) !== expectedCoverPath) return "missing_cover";
      return await isReadableDirectFile(binding.path, binding.identity, expectedCoverPath) ? "healthy" : "missing_cover";
    } catch {
      return "broken_video";
    }
  }

  private async verifyPackageImagesUnlocked(context: RootContext, pkg: DeliveryPackage): Promise<PublishAssetHealth> {
    try {
      // 这里同时完成路径归属校验：声明的 imagePaths 必须逐个落在本包 `images/` 内。
      const binding = await requireExpectedPackage(context, pkg, true, "note");
      const declared = pkg.imagePaths ?? [];
      if (declared.length === 0) return "missing_images";
      const imagesDirectory = path.join(binding.path, "images");
      const imagesIdentity = await requireDirectDirectory(binding.path, binding.identity, "images");

      const hashes: string[] = [];
      for (const relativePath of declared) {
        const absolutePath = resolveDeclaredImage(binding.path, relativePath);
        if (!await isReadableDirectFile(imagesDirectory, imagesIdentity, absolutePath)) return "missing_images";
        hashes.push(await hashFilePath(absolutePath));
      }
      return declaredManifestMatches(pkg, hashes) ? "healthy" : "missing_images";
    } catch {
      return "missing_images";
    }
  }

  private async repairProjectionUnlocked(
    context: RootContext,
    pkg: DeliveryPackage,
    tasks: PublishTask[],
  ): Promise<boolean> {
    validateProjectionTasks(pkg.id, tasks);
    const binding = await requireExpectedPackage(context, pkg, true);
    const targetPath = path.join(binding.path, "platforms");
    const current = await snapshotManagedDirectory(binding.path, binding.identity, targetPath);
    if (projectionMatchesSnapshot(current, tasks)) return false;

    const transactionId = randomUUID();
    const tempPath = path.join(binding.path, `.next-platforms-scan-${transactionId}`);
    const backupPath = path.join(binding.path, `.previous-platforms-scan-${transactionId}`);
    await mkdir(tempPath);
    const tempIdentity = await requireDirectoryIdentity(tempPath);
    LIVE_TEMP_PATHS.add(tempPath);
    let backupIdentity: FileIdentity | undefined;
    try {
      await writePlatformProjection(tempPath, tasks);
      if (current) {
        const targetIdentity = await requireDirectoryIdentity(targetPath);
        await this.safeRenameDirect(context, binding.path, binding.identity, targetPath, backupPath, targetIdentity);
        backupIdentity = targetIdentity;
      }
      await this.safeRenameDirect(context, binding.path, binding.identity, tempPath, targetPath, tempIdentity);
      LIVE_TEMP_PATHS.delete(tempPath);
      if (backupIdentity) {
        await this.safeRemoveDirect(context, binding.path, binding.identity, backupPath, backupIdentity);
      }
      PROJECTION_GENERATIONS.set(binding.path, (PROJECTION_GENERATIONS.get(binding.path) ?? 0) + 1);
      return true;
    } catch (error) {
      if (backupIdentity && await pathExistsNoFollow(backupPath) && !await pathExistsNoFollow(targetPath)) {
        await this.safeRenameDirect(context, binding.path, binding.identity, backupPath, targetPath, backupIdentity).catch(() => undefined);
      }
      await this.safeRemoveDirect(context, binding.path, binding.identity, tempPath, tempIdentity).catch(() => undefined);
      LIVE_TEMP_PATHS.delete(tempPath);
      throw error;
    }
  }

  private async removeProjectionBackupsUnlocked(
    context: RootContext,
    pkg: DeliveryPackage,
    tasks: PublishTask[],
  ): Promise<void> {
    const binding = await requireExpectedPackage(context, pkg, true);
    const targetPath = path.join(binding.path, "platforms");
    const current = await snapshotManagedDirectory(binding.path, binding.identity, targetPath);
    if (!projectionMatchesSnapshot(current, tasks)) return;

    for (const entry of await readdir(binding.path, { withFileTypes: true })) {
      if (!entry.name.startsWith(".previous-platforms-")) continue;
      const backupPath = path.join(binding.path, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new PublishingAssetError("publish_video_unreadable");
      }
      const backupIdentity = await requireDirectoryIdentity(backupPath);
      await this.safeRemoveDirect(context, binding.path, binding.identity, backupPath, backupIdentity);
    }
  }

  private async openSourceVideo(
    candidate: string,
    storageRoot: string,
    bound?: BoundSourceVideo,
  ): Promise<OpenSourceVideo> {
    if (typeof candidate !== "string" || path.extname(candidate).toLowerCase() !== ".mp4") {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    const candidatePath = path.resolve(candidate);

    if (bound) {
      const boundPath = path.resolve(bound.path);
      if (boundPath !== candidatePath || !isInside(storageRoot, boundPath, false)) {
        throw new PublishingAssetError("publish_video_unreadable");
      }
      try {
        const initialStats = await bound.handle.stat();
        if (
          !initialStats.isFile()
          || initialStats.size === 0
          || initialStats.size !== bound.size
          || !sameIdentity(initialStats, bound.identity)
        ) {
          throw new PublishingAssetError(initialStats.size === 0 ? "publish_video_missing" : "publish_video_unreadable");
        }
        return {
          path: boundPath,
          handle: bound.handle,
          initialStats,
          initialSha256: await hashFileHandle(bound.handle, initialStats.size),
          ownsHandle: false,
          requirePathIdentity: false,
        };
      } catch (error) {
        if (error instanceof PublishingAssetError) throw error;
        throw new PublishingAssetError("publish_video_unreadable");
      }
    }

    let handle: FileHandle | undefined;
    try {
      const canonicalPath = await realpath(candidatePath);
      if (!isInside(storageRoot, canonicalPath, false)) throw new PublishingAssetError("publish_video_unreadable");
      handle = await open(canonicalPath, "r");
      const initialStats = await handle.stat();
      const pathStats = await lstat(canonicalPath);
      if (
        pathStats.isSymbolicLink()
        || !initialStats.isFile()
        || initialStats.size === 0
        || !sameIdentity(initialStats, pathStats)
      ) {
        throw new PublishingAssetError(initialStats.size === 0 ? "publish_video_missing" : "publish_video_unreadable");
      }
      return {
        path: canonicalPath,
        handle,
        initialStats,
        initialSha256: await hashFileHandle(handle, initialStats.size),
        ownsHandle: true,
        requirePathIdentity: true,
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof PublishingAssetError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PublishingAssetError("publish_video_missing");
      }
      throw new PublishingAssetError("publish_video_unreadable");
    }
  }

  private async copyVerified(
    source: OpenSourceVideo,
    destination: string,
    context: RootContext,
    destinationParentIdentity: FileIdentity,
  ): Promise<PackageVideoMethod> {
    await this.assertRootAndDirectory(context, path.dirname(destination), destinationParentIdentity);
    const pathMatches = await lstat(source.path)
      .then((current) => sameIdentity(source.initialStats, current))
      .catch(() => false);
    if (!pathMatches) {
      if (source.requirePathIdentity) throw new PublishingAssetError("publish_video_unreadable");
      return this.copyFromHandle(source, destination, context, destinationParentIdentity);
    }

    let lastError: unknown;
    for (const attempt of [
      { method: "clone" as const, mode: constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL },
      { method: "copy" as const, mode: constants.COPYFILE_EXCL },
    ]) {
      let target: FileHandle | undefined;
      try {
        await this.assertRootAndDirectory(context, path.dirname(destination), destinationParentIdentity);
        await this.copyFile(source.path, destination, attempt.mode);
        target = await open(destination, constants.O_RDWR | constants.O_NOFOLLOW);
        const targetIdentity = await target.stat();
        if (!targetIdentity.isFile()) throw new PublishingAssetError("publish_clone_failed");
        await this.verifyCopiedVideo(source, target, targetIdentity, destination, context, destinationParentIdentity);
        return attempt.method;
      } catch (error) {
        lastError = error;
        await target?.close().catch(() => undefined);
        target = undefined;
        const targetIdentity = await optionalLstat(destination);
        if (targetIdentity && !targetIdentity.isSymbolicLink()) {
          await this.safeRemoveDirect(
            context,
            path.dirname(destination),
            destinationParentIdentity,
            destination,
            targetIdentity,
          ).catch(() => undefined);
        }
        const stillMatches = await lstat(source.path)
          .then((current) => sameIdentity(source.initialStats, current))
          .catch(() => false);
        if (!stillMatches) {
          if (source.requirePathIdentity) throw new PublishingAssetError("publish_video_unreadable");
          return this.copyFromHandle(source, destination, context, destinationParentIdentity);
        }
      } finally {
        await target?.close().catch(() => undefined);
      }
    }
    throw normalizeAssetError(lastError, "publish_clone_failed");
  }

  private async copyFromHandle(
    source: OpenSourceVideo,
    destination: string,
    context: RootContext,
    destinationParentIdentity: FileIdentity,
  ): Promise<PackageVideoMethod> {
    let target: FileHandle | undefined;
    try {
      target = await open(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR,
        0o600,
      );
      const targetIdentity = await target.stat();
      if (!targetIdentity.isFile()) throw new PublishingAssetError("publish_clone_failed");
      await copyFileHandle(source.handle, target, source.initialStats.size);
      await this.verifyCopiedVideo(source, target, targetIdentity, destination, context, destinationParentIdentity);
      return "copy";
    } catch (error) {
      throw normalizeAssetError(error, "publish_clone_failed");
    } finally {
      await target?.close().catch(() => undefined);
    }
  }

  private async verifyCopiedVideo(
    source: OpenSourceVideo,
    destinationHandle: FileHandle,
    destinationIdentity: FileIdentity,
    destination: string,
    context: RootContext,
    destinationParentIdentity: FileIdentity,
  ): Promise<void> {
    await this.assertRootAndDirectory(context, path.dirname(destination), destinationParentIdentity);
    const currentSourceStats = await source.handle.stat();
    if (
      !sameIdentity(source.initialStats, currentSourceStats)
      || sourceMetadataChanged(source.initialStats, currentSourceStats)
    ) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    if (source.requirePathIdentity && !sameIdentity(source.initialStats, await lstat(source.path))) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    const currentSourceHash = await hashFileHandle(source.handle, currentSourceStats.size);
    const destinationStats = await destinationHandle.stat();
    const destinationHash = await hashFileHandle(destinationHandle, destinationStats.size);
    if (currentSourceHash !== source.initialSha256 || destinationHash !== source.initialSha256) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    await this.assertRootAndDirectory(context, path.dirname(destination), destinationParentIdentity);
    if (!sameIdentity(destinationIdentity, await lstat(destination))) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
  }

  private async prepareCover(
    sourceCoverPath: string | undefined,
    sourceVideoPath: string,
    tempPath: string,
    context: RootContext,
    tempIdentity: FileIdentity,
  ): Promise<string | undefined> {
    const coverPath = path.join(tempPath, "cover.jpg");
    if (sourceCoverPath) {
      try {
        const source = await resolveReadableFile(context.storageRoot, sourceCoverPath);
        await this.assertRootAndDirectory(context, tempPath, tempIdentity);
        await this.copyFile(source, coverPath);
        await this.assertRootAndDirectory(context, tempPath, tempIdentity);
        return coverPath;
      } catch {
        await this.safeRemoveDirect(context, tempPath, tempIdentity, coverPath).catch(() => undefined);
      }
    }

    try {
      await this.assertRootAndDirectory(context, tempPath, tempIdentity);
      await this.runCommand("ffmpeg", [
        "-y", "-ss", "1", "-i", sourceVideoPath,
        "-frames:v", "1", "-q:v", "2", coverPath,
      ], { timeoutMs: 30_000 });
      await this.assertRootAndDirectory(context, tempPath, tempIdentity);
      const coverStats = await lstat(coverPath);
      await access(coverPath, constants.R_OK);
      if (coverStats.isSymbolicLink() || !coverStats.isFile() || coverStats.size === 0) throw new Error("empty cover");
      return coverPath;
    } catch {
      await this.safeRemoveDirect(context, tempPath, tempIdentity, coverPath).catch(() => undefined);
      return undefined;
    }
  }

  private async removeStaleTemporaryPaths(
    context: RootContext,
    failures: PublishingRecoveryFailure[],
  ): Promise<string[]> {
    const candidates: Array<{ path: string; identity: FileIdentity; parent: string; parentIdentity: FileIdentity }> = [];
    await walkManagedDirectories(context.publishingRoot, async (directory, entry, parentIdentity) => {
      if (!entry.name.startsWith(".next-")) return;
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        failures.push(recoveryFailure(new PublishingAssetError("publish_video_unreadable"), { path: candidate }));
        return;
      }
      if (!entry.isDirectory() || LIVE_TEMP_PATHS.has(candidate)) return;
      const candidateStats = await lstat(candidate);
      if (this.now().getTime() - candidateStats.mtimeMs < TEMP_STALE_MS) return;
      candidates.push({ path: candidate, identity: candidateStats, parent: directory, parentIdentity });
    });

    candidates.sort((a, b) => b.path.length - a.path.length);
    const removed: string[] = [];
    for (const candidate of candidates) {
      try {
        await this.safeRemoveDirect(
          context,
          candidate.parent,
          candidate.parentIdentity,
          candidate.path,
          candidate.identity,
        );
        removed.push(candidate.path);
      } catch (error) {
        failures.push(recoveryFailure(error, { path: candidate.path }));
      }
    }
    return removed;
  }

  private async withAssetLock<T>(operation: (context: RootContext) => Promise<T>): Promise<T> {
    const storageRoot = await realpath(this.deps.storageRoot);
    return withProcessLock(storageRoot, async () => {
      const context = await prepareRootContext(storageRoot);
      return operation(context);
    });
  }

  private async assertRootAndDirectory(
    context: RootContext,
    directory: string,
    identity: FileIdentity,
  ): Promise<void> {
    await requireMatchingDirectory(context.publishingRoot, context.publishingIdentity);
    await requireSafeDirectoryChain(context.publishingRoot, directory);
    await requireMatchingDirectory(directory, identity);
  }

  private async safeRenameDirect(
    context: RootContext,
    parent: string,
    parentIdentity: FileIdentity,
    source: string,
    destination: string,
    sourceIdentity: FileIdentity,
  ): Promise<void> {
    assertDirectChild(parent, source);
    assertDirectChild(parent, destination);
    await this.assertRootAndDirectory(context, parent, parentIdentity);
    await requireMatchingDirectory(source, sourceIdentity);
    if (await pathExistsNoFollow(destination)) throw new PublishingAssetError("publish_revision_conflict");
    await this.rename(source, destination);
    await this.assertRootAndDirectory(context, parent, parentIdentity);
    await requireMatchingDirectory(destination, sourceIdentity);
  }

  private async safeRemoveDirect(
    context: RootContext,
    parent: string,
    parentIdentity: FileIdentity | undefined,
    target: string,
    targetIdentity?: FileIdentity,
  ): Promise<void> {
    assertDirectChild(parent, target);
    await requireMatchingDirectory(context.publishingRoot, context.publishingIdentity);
    await requireSafeDirectoryChain(context.publishingRoot, parent);
    const currentParentIdentity = parentIdentity ?? await requireDirectoryIdentity(parent);
    await requireMatchingDirectory(parent, currentParentIdentity);
    const targetStats = await optionalLstat(target);
    if (targetStats?.isSymbolicLink()) throw new PublishingAssetError("publish_video_unreadable");
    if (targetStats && targetIdentity && !sameIdentity(targetStats, targetIdentity)) {
      throw new PublishingAssetError("publish_revision_conflict");
    }
    await this.rm(target, { recursive: true, force: true });
    await requireMatchingDirectory(context.publishingRoot, context.publishingIdentity);
    await requireMatchingDirectory(parent, currentParentIdentity);
  }
}

async function prepareRootContext(storageRoot: string): Promise<RootContext> {
  const storageStats = await lstat(storageRoot);
  if (storageStats.isSymbolicLink() || !storageStats.isDirectory()) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  const output = await ensureDirectDirectory(storageRoot, storageStats, "output");
  const outputPath = path.join(storageRoot, "output");
  const publishingIdentity = await ensureDirectDirectory(outputPath, output, "publishing");
  return {
    storageRoot,
    publishingRoot: path.join(outputPath, "publishing"),
    publishingIdentity,
  };
}

async function ensureDirectDirectory(
  parent: string,
  parentIdentity: FileIdentity,
  name: string,
): Promise<FileIdentity> {
  validateSegment(name);
  await requireMatchingDirectory(parent, parentIdentity);
  const target = path.join(parent, name);
  let targetStats = await optionalLstat(target);
  if (!targetStats) {
    await mkdir(target);
    targetStats = await lstat(target);
  }
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory() || await realpath(target) !== target) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  await requireMatchingDirectory(parent, parentIdentity);
  return targetStats;
}

async function requireDirectDirectory(
  parent: string,
  parentIdentity: FileIdentity,
  name: string,
): Promise<FileIdentity> {
  validateSegment(name);
  await requireMatchingDirectory(parent, parentIdentity);
  const target = path.join(parent, name);
  const targetStats = await lstat(target);
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory() || await realpath(target) !== target) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  return targetStats;
}

async function requireExpectedPackage(
  context: RootContext,
  pkg: DeliveryPackage,
  mustExist: boolean,
  contentType: PackageContentType = pkg.contentType ?? "video",
): Promise<{ path: string; identity: FileIdentity }> {
  const expected = expectedPackagePathFromRecord(context.publishingRoot, pkg);
  assertDeclaredPackagePaths(expected, pkg, contentType);
  if (!mustExist && !await pathExistsNoFollow(expected)) {
    return { path: expected, identity: { dev: -1, ino: -1 } };
  }
  const sourceIdentity = await requireDirectDirectory(
    context.publishingRoot,
    context.publishingIdentity,
    pkg.sourceJobId,
  );
  await requireMatchingDirectory(context.publishingRoot, context.publishingIdentity);
  const packageStats = await lstat(expected);
  if (packageStats.isSymbolicLink() || !packageStats.isDirectory() || await realpath(expected) !== expected) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  await requireMatchingDirectory(path.dirname(expected), sourceIdentity);
  if (path.resolve(pkg.packagePath) !== expected && await realpath(pkg.packagePath) !== expected) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  if (contentType === "video") {
    const expectedVideo = path.join(expected, "video.mp4");
    if (!pkg.videoPath || path.resolve(pkg.videoPath) !== expectedVideo) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
  }
  return { path: expected, identity: packageStats };
}

function expectedPackagePathFromRecord(publishingRoot: string, pkg: DeliveryPackage): string {
  validateSegment(pkg.sourceJobId);
  validateSegment(pkg.id);
  validateVersion(pkg.version);
  return expectedPackagePath(publishingRoot, pkg.sourceJobId, pkg.version, pkg.id);
}

function expectedPackagePath(
  publishingRoot: string,
  sourceJobId: string,
  version: number,
  packageId: string,
): string {
  return path.join(publishingRoot, sourceJobId, `v${version}-${packageId}`);
}

function assertDeclaredPackagePaths(
  expected: string,
  pkg: DeliveryPackage,
  contentType: PackageContentType,
): void {
  const declaredPackage = path.resolve(pkg.packagePath);
  if (declaredPackage !== expected) throw new PublishingAssetError("publish_video_unreadable");
  if (contentType === "video") {
    const declaredVideo = pkg.videoPath ? path.resolve(pkg.videoPath) : "";
    if (declaredVideo !== path.join(expected, "video.mp4")) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    return;
  }
  // 图文包：声明的每张图都必须落在本包 `images/` 内，否则视为不可读。
  for (const relativePath of pkg.imagePaths ?? []) {
    resolveDeclaredImage(expected, relativePath);
  }
}

/**
 * 把包内相对路径 `images/NN.ext` 解析成绝对路径，并确认它严格落在包目录的 `images/` 子目录里。
 *
 * 打包与复检共用这一份归属校验 —— 与 `video-output.ts` 的 `resolveContainedMp4` 同理，
 * 各写一份等于开放任意文件读取。
 */
function resolveDeclaredImage(packagePath: string, relativePath: string): string {
  const unreadable = (): never => { throw new PublishingAssetError("publish_image_unreadable"); };
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    return unreadable();
  }
  const normalized = path.posix.normalize(relativePath);
  if (normalized !== relativePath || !normalized.startsWith("images/")) return unreadable();
  const fileName = normalized.slice("images/".length);
  if (fileName.length === 0 || fileName === "." || fileName === ".." || /[/\\]/u.test(fileName)) {
    return unreadable();
  }
  const imagesDirectory = path.join(packagePath, "images");
  const absolute = path.join(imagesDirectory, fileName);
  if (path.dirname(absolute) !== imagesDirectory || !isInside(packagePath, absolute, false)) return unreadable();
  return absolute;
}

/** 各图 sha256 有序拼接后再哈希。顺序参与哈希，因此调换顺序必然改变结果。 */
function imageManifestHash(hashes: string[]): string {
  return createHash("sha256").update(hashes.join("\n")).digest("hex");
}

/** 正文里的图片占位符（与 `wechat-article.ts` 的 `WECHAT_IMAGE_SLOT_PREFIX` 同一约定）。 */
const ARTICLE_IMAGE_SLOT_PATTERN = /\{\{wechat-image-(\d+)\}\}/gu;

/**
 * 正文里每一张占位图都必须有对应的图片，否则这个包**永远提交不了**。
 *
 * 提交时要把每个占位符换成 mmbiz URL，缺一张就会在提交那一刻才报错 —— 与其那时才失败，
 * 不如不让这种包产生。**注意「一张图都没有」本身是合法的**（文章的内容是文字），
 * 这里拦的是「正文要图但图不够」这种自相矛盾的状态。
 */
function assertArticleImageCoverage(articleHtml: string, imageCount: number): void {
  let maxSlot = 0;
  for (const match of (articleHtml ?? "").matchAll(ARTICLE_IMAGE_SLOT_PATTERN)) {
    const slot = Number(match[1]);
    if (Number.isFinite(slot) && slot > maxSlot) maxSlot = slot;
  }
  if (maxSlot > imageCount) {
    throw new PublishingAssetError("publish_images_missing");
  }
}

/**
 * note 包的 `videoSha256` 字段「不适用」，记录层用它承载图片清单哈希（spec §5 的等价完整性凭据）。
 * 旧记录里可能不是 64 位十六进制，此时只做「齐全且可读」判定。
 */
function declaredManifestMatches(pkg: DeliveryPackage, hashes: string[]): boolean {
  if (!/^[0-9a-f]{64}$/u.test(pkg.videoSha256)) return true;
  return imageManifestHash(hashes) === pkg.videoSha256;
}

/**
 * 收集某个任务已生成的场景静帧，返回**按场景序**的绝对路径。
 *
 * 静帧由 `hyperframes snapshot --at <各场景中点>` 产出（`hyperframes-video.ts`），
 * 文件名里的 `frame-NN` 即场景序号。同目录下的 `contact-sheet-*.jpg` 不是场景静帧，
 * 必须排除 —— 它们的字典序排在 `frame-*` 之前，直接 `readdir().sort()` 会错位。
 */
export async function collectSceneSnapshots(storageRoot: string, sourceJobId: string): Promise<string[]> {
  validateSegment(sourceJobId);
  const root = await realpath(storageRoot);
  const snapshotsDirectory = path.join(root, "output", "videos", sourceJobId, "hyperframes", "snapshots");
  if (!isInside(root, snapshotsDirectory, false)) throw new PublishingAssetError("publish_image_unreadable");
  const entries = await readdir(snapshotsDirectory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });

  const scenes: Array<{ sceneIndex: number; name: string; path: string }> = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const matched = SCENE_SNAPSHOT_PATTERN.exec(entry.name);
    if (!matched) continue;
    scenes.push({
      sceneIndex: Number(matched[1]),
      name: entry.name,
      path: path.join(snapshotsDirectory, entry.name),
    });
  }

  return scenes
    .sort((left, right) => left.sceneIndex - right.sceneIndex || left.name.localeCompare(right.name))
    .map((scene) => scene.path);
}

async function writePlatformProjection(root: string, tasks: PublishTask[]): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const task of tasks) {
    const platformPath = path.join(root, task.platform);
    await mkdir(platformPath);
    await Promise.all([
      writeFile(path.join(platformPath, "title.txt"), task.title, "utf8"),
      writeFile(path.join(platformPath, "description.txt"), task.description, "utf8"),
      writeFile(path.join(platformPath, "hashtags.txt"), task.hashtags.map((tag) => `#${tag}`).join(" "), "utf8"),
      writeFile(path.join(platformPath, "publish.txt"), buildPublishText(task), "utf8"),
    ]);
  }
}

function projectionContents(tasks: PublishTask[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const task of tasks) {
    files.set(path.join(task.platform, "title.txt"), Buffer.from(task.title));
    files.set(path.join(task.platform, "description.txt"), Buffer.from(task.description));
    files.set(path.join(task.platform, "hashtags.txt"), Buffer.from(task.hashtags.map((tag) => `#${tag}`).join(" ")));
    files.set(path.join(task.platform, "publish.txt"), Buffer.from(buildPublishText(task)));
  }
  return files;
}

function projectionMatchesSnapshot(snapshot: DirectorySnapshot | undefined, tasks: PublishTask[]): boolean {
  if (!snapshot) return false;
  const expected = projectionContents(tasks);
  if (snapshot.files.size !== expected.size) return false;
  for (const [relativePath, expectedBytes] of expected) {
    if (!snapshot.files.get(relativePath)?.equals(expectedBytes)) return false;
  }
  return true;
}

async function snapshotManagedDirectory(
  parent: string,
  parentIdentity: FileIdentity,
  root: string,
): Promise<DirectorySnapshot | undefined> {
  assertDirectChild(parent, root);
  await requireMatchingDirectory(parent, parentIdentity);
  const rootStats = await optionalLstat(root);
  if (!rootStats) return undefined;
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || await realpath(root) !== root) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  const directories: string[] = [];
  const files = new Map<string, Buffer>();

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath);
      if (entry.isSymbolicLink()) throw new PublishingAssetError("publish_video_unreadable");
      if (entry.isDirectory()) {
        directories.push(relativePath);
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.set(relativePath, await readFile(fullPath));
      } else {
        throw new PublishingAssetError("publish_video_unreadable");
      }
    }
  }
  await visit(root);
  await requireMatchingDirectory(parent, parentIdentity);
  await requireMatchingDirectory(root, rootStats);
  return { directories: directories.sort(), files };
}

function fingerprintSnapshot(snapshot: DirectorySnapshot | undefined): string {
  const hash = createHash("sha256");
  if (!snapshot) return hash.update("missing").digest("hex");
  for (const directory of snapshot.directories) hash.update(`d:${directory}\0`);
  for (const [relativePath, bytes] of [...snapshot.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`f:${relativePath}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function findOrphanPackages(
  context: RootContext,
  index: PublishingIndex,
  failures: PublishingRecoveryFailure[],
): Promise<string[]> {
  const known = new Set<string>();
  for (const pkg of Object.values(index.packages)) {
    try {
      known.add(expectedPackagePathFromRecord(context.publishingRoot, pkg));
    } catch (error) {
      failures.push(recoveryFailure(error, { packageId: pkg.id }));
    }
  }
  const orphans: string[] = [];
  for (const sourceEntry of await readdir(context.publishingRoot, { withFileTypes: true })) {
    const sourcePath = path.join(context.publishingRoot, sourceEntry.name);
    if (sourceEntry.isSymbolicLink()) {
      failures.push(recoveryFailure(new PublishingAssetError("publish_video_unreadable"), { path: sourcePath }));
      continue;
    }
    if (!sourceEntry.isDirectory() || sourceEntry.name.startsWith(".")) continue;
    for (const packageEntry of await readdir(sourcePath, { withFileTypes: true })) {
      const packagePath = path.join(sourcePath, packageEntry.name);
      if (packageEntry.isSymbolicLink()) {
        failures.push(recoveryFailure(new PublishingAssetError("publish_video_unreadable"), { path: packagePath }));
        continue;
      }
      if (packageEntry.isDirectory() && /^v\d+-/u.test(packageEntry.name) && !known.has(packagePath)) {
        orphans.push(packagePath);
      }
    }
  }
  return orphans;
}

async function walkManagedDirectories(
  root: string,
  visit: (directory: string, entry: Dirent<string>, parentIdentity: FileIdentity) => Promise<void>,
): Promise<void> {
  const rootIdentity = await requireDirectoryIdentity(root);
  async function walk(directory: string, directoryIdentity: FileIdentity): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      await visit(directory, entry, directoryIdentity);
      if (!entry.isDirectory() || entry.name.startsWith(".next-")) continue;
      const child = path.join(directory, entry.name);
      const childIdentity = await requireDirectoryIdentity(child);
      await walk(child, childIdentity);
    }
    await requireMatchingDirectory(directory, directoryIdentity);
  }
  await walk(root, rootIdentity);
}

/** 把 `hashFilePath` 的成片口径错误码收敛成图文口径，避免图文失败提示成「成片不可读取」。 */
async function hashImageFile(filePath: string): Promise<string> {
  try {
    return await hashFilePath(filePath);
  } catch {
    throw new PublishingAssetError("publish_image_unreadable");
  }
}

async function resolveReadableFile(
  storageRoot: string,
  candidate: string,
  options: {
    extensions?: ReadonlySet<string>;
    maxBytes?: number;
    code?: PublishingAssetErrorCode;
  } = {},
): Promise<string> {
  const code = options.code ?? "publish_video_unreadable";
  const candidatePath = path.resolve(candidate);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidatePath);
  } catch {
    throw new PublishingAssetError(code);
  }
  if (!isInside(storageRoot, canonicalPath, false)) throw new PublishingAssetError(code);
  const fileStats = await lstat(canonicalPath);
  await access(canonicalPath, constants.R_OK);
  if (fileStats.isSymbolicLink() || !fileStats.isFile() || fileStats.size === 0) {
    throw new PublishingAssetError(code);
  }
  if (options.extensions && !options.extensions.has(path.extname(canonicalPath).toLowerCase())) {
    throw new PublishingAssetError(code);
  }
  if (options.maxBytes !== undefined && fileStats.size > options.maxBytes) {
    throw new PublishingAssetError(code);
  }
  return canonicalPath;
}

async function isReadableDirectFile(
  parent: string,
  parentIdentity: FileIdentity,
  candidate: string,
): Promise<boolean> {
  try {
    assertDirectChild(parent, candidate);
    await requireMatchingDirectory(parent, parentIdentity);
    const fileStats = await lstat(candidate);
    await access(candidate, constants.R_OK);
    return !fileStats.isSymbolicLink() && fileStats.isFile() && fileStats.size > 0 && await realpath(candidate) === candidate;
  } catch {
    return false;
  }
}

async function hashFileHandle(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (position !== size) throw new PublishingAssetError("publish_video_unreadable");
  return hash.digest("hex");
}

async function copyFileHandle(source: FileHandle, destination: FileHandle, size: number): Promise<void> {
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await source.read(buffer, 0, length, position);
    if (bytesRead === 0) throw new PublishingAssetError("publish_video_unreadable");
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, position + written);
      if (result.bytesWritten === 0) throw new PublishingAssetError("publish_clone_failed");
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  await destination.truncate(size);
  await destination.sync();
}

async function hashFilePath(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const fileStats = await handle.stat();
    const pathStats = await lstat(filePath);
    if (!fileStats.isFile() || pathStats.isSymbolicLink() || !sameIdentity(fileStats, pathStats)) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    return await hashFileHandle(handle, fileStats.size);
  } finally {
    await handle.close();
  }
}

function sourceMetadataChanged(before: Stats, after: Stats): boolean {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs;
}

function validateProjectionTasks(packageId: string, tasks: PublishTask[]): void {
  const platforms = new Set<string>();
  for (const task of tasks) {
    if (task.packageId !== packageId || !APPROVED_PLATFORMS.has(task.platform) || platforms.has(task.platform)) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
    platforms.add(task.platform);
  }
}

function validateSegment(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new PublishingAssetError("publish_video_unreadable");
}

function validateVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new PublishingAssetError("publish_video_unreadable");
}

function assertDirectChild(parent: string, candidate: string): void {
  if (path.dirname(candidate) !== parent || !isInside(parent, candidate, false)) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
}

function isInside(root: string, candidate: string, allowRoot: boolean): boolean {
  const relative = path.relative(root, candidate);
  return !(!allowRoot && relative === "")
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function requireSafeDirectoryChain(root: string, target: string): Promise<void> {
  if (target === root) return;
  if (!isInside(root, target, false)) throw new PublishingAssetError("publish_video_unreadable");
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    const currentStats = await lstat(current);
    if (currentStats.isSymbolicLink() || !currentStats.isDirectory() || await realpath(current) !== current) {
      throw new PublishingAssetError("publish_video_unreadable");
    }
  }
}

async function requireDirectoryIdentity(candidate: string): Promise<FileIdentity> {
  const candidateStats = await lstat(candidate);
  if (candidateStats.isSymbolicLink() || !candidateStats.isDirectory() || await realpath(candidate) !== candidate) {
    throw new PublishingAssetError("publish_video_unreadable");
  }
  return candidateStats;
}

async function requireMatchingDirectory(candidate: string, expected: FileIdentity): Promise<void> {
  const current = await requireDirectoryIdentity(candidate);
  if (!sameIdentity(current, expected)) throw new PublishingAssetError("publish_revision_conflict");
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function optionalLstat(candidate: string): Promise<Stats | undefined> {
  try {
    return await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function pathExistsNoFollow(candidate: string): Promise<boolean> {
  return (await optionalLstat(candidate)) !== undefined;
}

async function withProcessLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = ASSET_LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  ASSET_LOCKS.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (ASSET_LOCKS.get(key) === tail) ASSET_LOCKS.delete(key);
  }
}

function recoveryFailure(
  error: unknown,
  fields: { packageId?: string; path?: string },
): PublishingRecoveryFailure {
  const normalized = normalizeAssetError(error, "publish_video_unreadable");
  return {
    ...fields,
    code: normalized.code,
    message: normalized.message,
  };
}

function normalizeAssetError(
  error: unknown,
  fallback: PublishingAssetErrorCode = "publish_clone_failed",
): PublishingAssetError {
  if (error instanceof PublishingAssetError) return error;
  if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
    return new PublishingAssetError("publish_storage_full");
  }
  return new PublishingAssetError(fallback);
}

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}
