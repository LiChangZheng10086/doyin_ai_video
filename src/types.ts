import type { PlatformCopyValidationError } from "./lib/publishing-platforms.js";

export type AiProvider = "deepseek" | "openai" | "custom";
export type JobStatus = "queued" | "processing" | "done" | "failed";

export type LocalUserRole = "admin" | "publisher";
export type ActorRole = LocalUserRole | "system";

export interface LocalUserView {
  id: string;
  displayName: string;
  role: LocalUserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActorSnapshot {
  userId: string;
  displayName: string;
  role: ActorRole;
}

export type PublishPlatform =
  | "douyin"
  | "xiaohongshu"
  | "wechat_channels"
  | "bilibili"
  | "wechat_mp"
  | "toutiao";
export type PublishTaskStatus = "scheduled" | "ready" | "published" | "failed" | "cancelled";
export type PublishPackageState = "active" | "trashed" | "purged";
export type PublishCopySource = "ai" | "cleaned_fallback" | "user_edited";
export type PackageVideoMethod = "clone" | "copy";
export type PublishAssetHealth = "healthy" | "missing_cover" | "broken_video" | "missing_images";
export type PublishingListStatus = "action" | "all" | PublishTaskStatus | "broken" | "trash";

/** 交付包内容类型；缺省（含存量包）一律按 `video` 处理。 */
export type PackageContentType = "video" | "note" | "article";

/**
 * 文章包（`article` 内容类型）的文案。**两个平台共用同一形状**：
 *
 * - 公众号：`title` ≤32、`digest` ≤120、`author` ≤16（官方 `draft/add` 硬限制）；
 * - 今日头条：只有 `title`（2~30 字，见 `TOUTIAO_ARTICLE_LIMITS`），`digest`/`author` 缺省。
 *
 * 与 `PlatformCopy` 不同：文章的 `description` 不是正文 —— 正文是一整份渲染好的 HTML
 * （落在包内 `article.html`），所以文案与正文分开存，`htmlSha256` 是正文的完整性凭据。
 */
export interface ArticleCopy {
  title: string;
  /** 摘要；可缺省（公众号缺省时官方抓正文前 54 字；头条没有摘要字段）。 */
  digest?: string;
  author?: string;
  /** 包内 `article.html` 的 sha256：与「图片清单哈希」同级的内容完整性凭据。 */
  htmlSha256: string;
}

/** 公众号侧的历史名字，保留为别名（存档校验 `isWechatArticleCopyShape` 与既有代码不受影响）。 */
export type WechatArticleCopy = ArticleCopy;

/**
 * 图文素材来源：`frames` = 该任务已生成的场景静帧（缺省，存量请求不变），
 * `library` = 素材库里手动选的图片。
 *
 * 两种来源都在打包时被**复制进包目录**，因此 `DeliveryPackage` 不记录来源 ——
 * 来源只在打包那一刻用一次，包保持自包含（素材事后被删也不影响已建好的包）。
 */
export type NoteImageSource = "frames" | "library";

/**
 * 今日头条文章包的发布选项。
 *
 * `crossPostWeitoutiao` 单独解释：头条发布页上「同时发布微头条」**默认是勾选的**，
 * 不处理就会在用户不知情时多发一条内容。我们的默认是**关闭**，且执行器会读回勾选状态校验
 * （关不掉就不发布，见 spec §4.2）。
 */
export interface ToutiaoPublishOptions {
  /** 「头条首发」。 */
  firstPublish: boolean;
  /** 作品声明（如「个人观点，仅供参考」），集合语义。 */
  declarations: string[];
  /** 「同时发布微头条」；缺省视为 false（关闭）。 */
  crossPostWeitoutiao: boolean;
}

export interface PlatformCopy {
  title: string;
  description: string;
  hashtags: string[];
}

export interface DeliveryPackage {
  id: string;
  sourceJobId: string;
  version: number;
  state: PublishPackageState;
  title: string;
  packagePath: string;
  videoPath?: string;
  coverPath?: string;
  videoSha256: string;
  videoSize: number;
  videoMethod: PackageVideoMethod;
  assetHealth: PublishAssetHealth;
  /** 缺省视为 `video`，因此存量包无需迁移。 */
  contentType?: PackageContentType;
  /** 仅图文包：包目录内 `images/NN.ext` 的有序列表。 */
  imagePaths?: string[];
  /** 仅图文包：抖音图文口径的文案（title ≤20 / note(=description) ≤1000）。 */
  noteCopy?: PlatformCopy;
  /** 仅文章包：文章文案 + 包内 `article.html` 的哈希。 */
  articleCopy?: ArticleCopy;
  /**
   * 仅文章包（今日头条）：发布选项。
   *
   * **必须参与 `previewRevision`** —— 它们改变「要发出去的内容」，
   * 不进指纹就会出现「预览后改了选项却照样提交」。
   */
  toutiaoOptions?: ToutiaoPublishOptions;
  createdBy: ActorSnapshot;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  purgeAt?: string;
  purgedAt?: string;
}

export interface PublishTask extends PlatformCopy {
  id: string;
  packageId: string;
  platform: PublishPlatform;
  copySource: PublishCopySource;
  status: PublishTaskStatus;
  scheduledAt?: string;
  dueNotifiedAt?: string;
  publishedAt?: string;
  lastError?: string;
  contentRevision: number;
  createdAt: string;
  updatedAt: string;
  /**
   * 自动发布（外部 sau CLI）的进度记录。
   *
   * 刻意**不扩展 `PublishTaskStatus`**：机器动作的结果只记在这里，
   * `succeeded` 的语义是「已提交」；是否真的发出去了，仍由人工点「标记已发布」确认。
   */
  autoPublish?: PublishAutoPublish;
}

export type PublishAutoPublishStatus = "running" | "awaiting_code" | "succeeded" | "failed";

export interface PublishAutoPublish {
  status: PublishAutoPublishStatus;
  startedAt: string;
  finishedAt?: string;
  /** CLI 输出摘要，便于事后追查。 */
  message?: string;
  /** 单次尝试的唯一 id。 */
  attemptId: string;
}

export interface PublishAuditEvent {
  id: string;
  packageId: string;
  taskId?: string;
  action: string;
  actor: ActorSnapshot;
  fromStatus?: PublishTaskStatus;
  toStatus?: PublishTaskStatus;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface PublishingTombstone {
  packageId: string;
  sourceJobId: string;
  version: number;
  platforms: Array<{ platform: PublishPlatform; finalStatus: PublishTaskStatus }>;
  createdAt: string;
  publishedAt?: string;
  deletedAt: string;
  purgedAt: string;
  videoSha256: string;
  auditSummary: Array<{ action: string; actor: ActorSnapshot; createdAt: string }>;
}

export interface PublishingIndex {
  schemaVersion: 1;
  revision: number;
  nextVersionBySource: Record<string, number>;
  packages: Record<string, DeliveryPackage>;
  tasks: Record<string, PublishTask>;
  audit: PublishAuditEvent[];
  tombstones: Record<string, PublishingTombstone>;
}

export interface PublishingPackageDetail {
  package: DeliveryPackage;
  tasks: PublishTask[];
  audit: PublishAuditEvent[];
  tombstone?: PublishingTombstone;
}

export interface DueNotification {
  taskId: string;
  packageId: string;
  platform: PublishPlatform;
  platformLabel: string;
  title: string;
  scheduledAt: string;
  becameReadyAt: string;
  overdueMs: number;
}

export interface PublishingPreview {
  sourceJobId: string;
  nextVersion: number;
  previewRevision: string;
  video: {
    filename: string;
    size: number;
    width: number;
    height: number;
    duration: number;
    coverAvailable: boolean;
  };
  copies: Partial<Record<PublishPlatform, PlatformCopy & { copySource: PublishCopySource }>>;
  warning?: { code: string; message: string };
  expectedPackagePath: string;
  /** 缺省视为 `video`（存量行为不变）。 */
  contentType?: PackageContentType;
  /** 仅图文：本次预览用的素材来源；缺省 `frames`。 */
  imageSource?: NoteImageSource;
  /**
   * 仅图文：将被打包进包的图片，顺序即入包顺序（静帧按场景序、素材库按选择顺序）。
   * 素材库来源的每一项带 `assetId`，界面据此回显选中状态。
   */
  images?: Array<{ name: string; size: number; assetId?: string }>;
  /** 仅图文：抖音图文张数上限，由服务端下发（界面只渲染，不复刻数字）。 */
  imageLimit?: number;
  /** 仅图文：文案字段上限，由服务端下发（表单只渲染，不复刻 20/1000/10）。 */
  copyLimits?: { titleMax: number; descriptionMax: number; hashtagMax: number };
  /** 仅图文：压缩到图文口径后的默认文案。 */
  noteCopy?: PlatformCopy;
  /** 仅图文：标题是否因超过 20 字被压缩（界面需标注「已压缩，可编辑」）。 */
  noteCopyTitleCompressed?: boolean;
  /**
   * 仅文章包：AI 成文结果（标题 + 正文纯文本）。
   * 正文以**纯文本**往返（段落之间空行分隔），HTML 由服务端在打包时渲染 ——
   * 渲染规则留在服务端一处，客户端只负责编辑文字。
   */
  articleCopy?: { title: string; body: string };
  /** 仅文章包：本平台的字段限额（界面只渲染，不复刻数字）。 */
  articleLimits?: { titleMin: number; titleMax: number; bodyChars: number };
  /** 仅文章包：AI 成文走了兜底时的提示（**绝不静默**，界面必须显示）。 */
  articleFallback?: { code: string; message: string };
  /** 仅文章包：将被裁成 16:9 的封面候选（**头条必填**）。 */
  articleCover?: { name: string; size: number; assetId?: string };
  /** 仅文章包：今日头条发布选项的默认值（全关；微头条同步默认关闭）。 */
  toutiaoOptions?: ToutiaoPublishOptions;
}

/** 文案字段的字数与上限，由服务端按对应口径算好，前端只渲染不复刻规则。 */
export interface PublishingPreviewCopyField {
  actual: number;
  limit: number;
  over: boolean;
}

export interface PublishingPreviewCopyCheck {
  platform: PublishPlatform;
  /**
   * `package` 表示检查的是包级文案（图文包用 `noteCopy`，与 auto-publish 实际提交的一致）；
   * `task` 表示检查的是某个平台任务自己的文案（视频包）。
   */
  scope: "package" | "task";
  taskId?: string;
  /** 平台中文名，如「抖音」。 */
  label: string;
  title: PublishingPreviewCopyField;
  description: PublishingPreviewCopyField;
  hashtags: PublishingPreviewCopyField;
  violations: PlatformCopyValidationError[];
}

export interface PublishingPreviewTask {
  id: string;
  platform: PublishPlatform;
  status: PublishTaskStatus;
  contentRevision: number;
  scheduledAt?: string;
  copy: PlatformCopy;
}

/** 包级预览：发布前「看得见将要发出去的内容」的唯一数据面（spec §14）。 */
export interface PublishingPackagePreview {
  package: {
    id: string;
    sourceJobId: string;
    version: number;
    state: PublishPackageState;
    title: string;
    packagePath: string;
    contentType: PackageContentType;
    assetHealth: PublishAssetHealth;
    createdBy: ActorSnapshot;
    createdAt: string;
    updatedAt: string;
  };
  /** 内容指纹；带它调用 auto-publish 才被接受（缺失 400 / 不一致 409）。 */
  previewRevision: string;
  /** 仅视频包：成片元数据，前端据此接既有 `/api/jobs/:id/video/stream` 播放。 */
  video?: {
    path: string;
    sha256: string;
    size: number;
    method: PackageVideoMethod;
    hasCover: boolean;
  };
  /** 仅图文包：**有序**包内相对路径，前端用 `/images/:index` 逐张取。 */
  imagePaths?: string[];
  /** 仅图文包：将被提交的文案（= 包级 `noteCopy`）。 */
  noteCopy?: PlatformCopy;
  /**
   * 仅文章包：将被提交的文章（标题 + **从包内 `article.html` 提取的正文纯文本**）。
   * 正文以纯文本下发而不是原样 HTML：预览弹窗只负责渲染文字，不做 HTML 注入。
   */
  articleCopy?: { title: string; body: string };
  /** 仅文章包：本平台的字段限额（界面只渲染，不复刻数字）。 */
  articleLimits?: { titleMin: number; titleMax: number; bodyChars: number };
  /** 仅文章包：发布选项（首发 / 作品声明 / 同步微头条）—— 它们改变要发出去的内容。 */
  toutiaoOptions?: ToutiaoPublishOptions;
  copyChecks: PublishingPreviewCopyCheck[];
  tasks: PublishingPreviewTask[];
}

export interface PublishingAssetInspection {
  filename: string;
  size: number;
  width: number;
  height: number;
  duration: number;
  coverAvailable: boolean;
  estimatedAdditionalBytes: number;
  warnings: Array<{ code: string; message: string }>;
}

export interface CreatePublishingPackageInput {
  sourceJobId: string;
  previewRevision: string;
  title: string;
  /** 缺省视为 `video`。 */
  contentType?: PackageContentType;
  /**
   * 仅图文包：包级文案（title ≤20 / note ≤1000）。
   * 图文包的平台任务文案由服务端从它同步生成，避免两处各写一份后互相漂移。
   */
  noteCopy?: PlatformCopy;
  /** 仅图文包：素材来源；缺省 `frames`（自动静帧）。 */
  imageSource?: NoteImageSource;
  /** 仅图文包：`library` 时必填，按**选择顺序**进包；`frames` 时不允许携带。 */
  imageAssetIds?: string[];
  /**
   * 仅文章包：文章文案（标题 + 正文纯文本）。
   * 与图文包同理：平台任务文案由服务端从它同步生成，客户端不许传两份。
   */
  articleCopy?: { title: string; body: string };
  /** 仅文章包：今日头条发布选项；缺省全关。 */
  toutiaoOptions?: ToutiaoPublishOptions;
  platforms: Array<{
    platform: PublishPlatform;
    copy: PlatformCopy;
    copySource?: PublishCopySource;
    scheduledAt?: string;
  }>;
}

export interface PublishingListFilters {
  status?: PublishingListStatus;
  /**
   * 内容类型过滤（发布中心「渠道」分栏的唯一真源：抖音图文 = note、今日头条文章 = article、
   * 视频人工交付 = video）。**省略时不过滤**（既有调用方与用例不受影响）。
   */
  contentType?: PackageContentType;
  platform?: PublishPlatform;
  sourceJobId?: string;
  version?: number;
  createdBy?: string;
  search?: string;
}

export interface PublishingErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface LocalSessionView {
  token: string;
  user: LocalUserView;
}

export type JobStage =
  | "submitted"
  | "parsed"
  | "downloading"
  | "downloaded"
  | "extracting"
  | "audio_extracted"
  | "transcribing"
  | "transcribed"
  | "cleaning"
  | "cleaned"
  | "generating-video-prompts"
  | "scripted"
  | "generating-video"
  | "rendered"
  | "failed";

export type WorkflowMode = "manual" | "auto";

export type PipelineStep =
  | "transcribe"
  | "clean"
  | "generate_video_prompts"
  | "generate_video";

export type StreamablePipelineStep = "clean" | "generate_video_prompts";
export type JobStepStreamEventType = "started" | "preview" | "completed" | "paused" | "error";

export interface JobStepStreamEvent {
  id: number;
  type: JobStepStreamEventType;
  jobId: string;
  step: StreamablePipelineStep;
  delta?: string;
  text?: string;
  model?: string;
  message?: string;
}

export type PipelineStepStatus = "pending" | "running" | "succeeded" | "failed" | "paused";
export type VideoGenerationPhase =
  | "checking_environment"
  | "building_project"
  | "validating"
  | "snapshotting"
  | "rendering"
  | "verifying";

export interface PipelineStepState {
  status: PipelineStepStatus;
  attempts: number;
  lastError?: string;
  startedAt?: string;
  finishedAt?: string;
  phase?: VideoGenerationPhase;
  progress?: number;
}

export type PipelineSteps = Record<PipelineStep, PipelineStepState>;

export interface JobRecord {
  id: string;
  sourceUrl: string;
  topic: string;
  coverUrl?: string;
  status: JobStatus;
  stage: JobStage;
  workflowMode?: WorkflowMode;
  steps?: PipelineSteps;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
  downloadErrorMessage?: string;
  audioErrorMessage?: string;
  transcriptErrorMessage?: string;
  deletedAt?: string;
  trashExpiresAt?: string;
  videoPath?: string;
  videoMetadataPath?: string;
  audioPath?: string;
  audioManifestPath?: string;
  transcriptPath?: string;
  transcriptModel?: string;
  videoProjectPath?: string;
  videoOutputPath?: string;
  videoGeneratedAt?: string;
  storagePath: string;
}

export interface JobPreview {
  displayTitle: string;
  subtitle: string;
  sourcePlatform: string;
  authorName?: string;
  summary?: string;
  coverTitle?: string;
  coverUrl?: string;
  hasTranscript: boolean;
  hasRewrite: boolean;
  hasVideoPrompts: boolean;
  hasVideo: boolean;
  currentStep?: PipelineStep;
  nextStep?: PipelineStep;
  nextActionLabel: string;
}

export type JobOverview = JobRecord & {
  preview: JobPreview;
};

export interface TranscriptSegment {
  start?: number;
  end?: number;
  text: string;
}

export interface TranscriptWord {
  start?: number;
  end?: number;
  word: string;
  probability?: number;
}

export interface TranscriptAsset {
  jobId: string;
  sourceUrl: string;
  audioPath: string;
  transcript: string;
  text: string;
  segments: TranscriptSegment[];
  words?: TranscriptWord[];
  duration?: number;
  language?: string;
  model: string;
  provider: string;
  createdAt: string;
}

export interface EnhancedScene {
  scene: number;
  originalVisual: string;
  videoPrompt: string;
  cameraMovement?: string;
  motionEffect?: string;
  lightingStyle?: string;
}

export type ShotType = "hook" | "problem" | "explain" | "proof" | "contrast" | "process" | "summary" | "cta";

export type ShotPacing = "fast" | "medium" | "slow";

export type ShotTransition = "cut" | "wipe" | "push" | "zoom" | "match-cut" | "flash";

export type ShotLayout =
  | "kinetic-title"
  | "concept-map"
  | "process-flow"
  | "comparison"
  | "metric"
  | "summary-stack";

export type ShotVisualTone = "primary" | "success" | "danger" | "muted";

export interface ShortVideoVisualItem {
  label: string;
  value?: string;
  tone?: ShotVisualTone;
}

export type ShortVideoVisualLayerType =
  | "background"
  | "subject"
  | "graphic"
  | "caption"
  | "emphasis"
  | "decoration";

export interface ShortVideoVisualLayer {
  type: ShortVideoVisualLayerType;
  content: string;
  motion?: string;
  style?: string;
}

export interface ShortVideoShot {
  index: number;
  duration: number;
  shotType: ShotType;
  subject: string;
  action: string;
  cameraMotion: string;
  visualLayers: ShortVideoVisualLayer[];
  caption: string;
  emphasisWords: string[];
  transition: ShotTransition;
  pacing: ShotPacing;
  narration: string;
  layout?: ShotLayout;
  headline?: string;
  supportingText?: string;
  captionLines?: string[];
  visualItems?: ShortVideoVisualItem[];
  sourceKeyPoints?: number[];
}

export interface ShortVideoPlan {
  planVersion: 2;
  targetDuration: 60;
  shortVideoScript: string;
  shots: ShortVideoShot[];
}

export interface HyperframesVideoScene {
  index: number;
  shotType?: ShotType;
  layout?: ShotLayout;
  headline?: string;
  supportingText?: string;
  captionLines?: string[];
  visualItems?: ShortVideoVisualItem[];
  sourceKeyPoints?: number[];
  subject: string;
  action: string;
  cameraMotion: string;
  visualLayers: ShortVideoVisualLayer[];
  caption: string;
  emphasisWords: string[];
  transition: ShotTransition;
  pacing: ShotPacing;
  narration: string;
  duration: number;
  accent: string;
}

export interface HyperframesVideoOutput {
  provider: "hyperframes";
  projectPath: string;
  videoPath: string;
  manifestPath: string;
  createdAt: string;
  duration: number;
  aspectRatio: "9:16";
  width: 1080;
  height: 1920;
  scenes: HyperframesVideoScene[];
}

export interface ScriptAsset {
  sourceUrl: string;
  videoId?: string;
  title?: string;
  pageTitle?: string;
  pageDescription?: string;
  authorName?: string;
  coverUrl?: string;
  publishTime?: string;
  topic: string;
  rawShareText?: string;
  normalizedShareText?: string;
  introText?: string;
  hashtags?: string[];
  contentType?: string;
  rawText: string;
  transcriptText?: string;
  cleanScript: string;
  voiceoverScript: string;
  coverTitle: string;
  tags: string[];
  summary?: string;
  hook?: string;
  shortVideoScript?: string;
  keyPoints?: string[];
  qualityNotes?: string[];
  videoOutline?: Array<{
    title: string;
    bullets: string[];
    visualPrompt?: string;
  }>;
  aiModel?: string;
  cleaningMode?: AiProvider | "fallback";
  cleanedAt?: string;
  sceneList: Array<{
    scene: number;
    duration: number;
    caption: string;
    visual: string;
  }>;
  status: "draft" | "ready" | "rendered";

  // 视频增强字段
  videoPrompts?: string[];
  enhancedScenes?: EnhancedScene[];
  shortVideoShots?: ShortVideoShot[];
  planVersion?: 2;
  targetDuration?: 60;
  videoEnhancedAt?: string;

  hyperframesVideo?: HyperframesVideoOutput;
}

// --- 用户主页爬取 & 合集 ---

export interface DouyinVideoItem {
  awemeId: string;
  desc: string;
  coverUrl: string;
  videoUrl: string;
  duration: number;
  createTime: number;
  statistics: {
    diggCount: number;
    commentCount: number;
    shareCount: number;
    playCount: number;
  };
  musicTitle?: string;
  hashtags?: string[];
}

export interface DouyinUserPageInfo {
  secUid: string;
  nickname: string;
  avatarUrl: string;
  description: string;
  followerCount: number;
  followingCount: number;
  awemeCount: number;
}

export interface CrawlUserPageResult {
  userInfo: DouyinUserPageInfo;
  items: DouyinVideoItem[];
  totalCollected: number;
  hasMore: boolean;
  nextCursor: number;
}

export interface CollectionRecord {
  id: string;
  sourcePageUrl: string;
  secUid: string;
  nickname: string;
  avatarUrl: string;
  crawlResult: {
    items: DouyinVideoItem[];
    totalCollected: number;
    hasMore: boolean;
    nextCursor: number;
  };
  childJobIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CollectionOverview extends CollectionRecord {
  childJobProgress: {
    total: number;
    transcribed: number;
    cleaned: number;
    scripted: number;
    rendered: number;
    failed: number;
  };
}
