// 任务状态
export type AiProvider = 'deepseek' | 'openai' | 'custom';
export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

export type LocalUserRole = 'admin' | 'publisher';
export type ActorRole = LocalUserRole | 'system';

export interface LocalUser {
  id: string;
  displayName: string;
  role: LocalUserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LocalSession {
  token: string;
  user: LocalUser;
}

export interface ActorSnapshot {
  userId: string;
  displayName: string;
  role: ActorRole;
}

export type PublishPlatform =
  | 'douyin'
  | 'xiaohongshu'
  | 'wechat_channels'
  | 'bilibili'
  | 'wechat_mp'
  | 'toutiao';
export type PublishTaskStatus = 'scheduled' | 'ready' | 'published' | 'failed' | 'cancelled';
export type PublishPackageState = 'active' | 'trashed' | 'purged';
export type PublishCopySource = 'ai' | 'cleaned_fallback' | 'user_edited';
export type PackageVideoMethod = 'clone' | 'copy';
export type PublishAssetHealth = 'healthy' | 'missing_cover' | 'broken_video' | 'missing_images';
/** 交付包内容类型；缺省（含存量包）一律按 `video` 处理。 */
export type PackageContentType = 'video' | 'note' | 'article';
/**
 * 图文素材来源：`frames` = 该作品已生成的场景静帧（缺省），`library` = 素材库里手动选的图片。
 * 两种来源都在打包时被复制进包目录，因此包本身不记录来源。
 */
export type NoteImageSource = 'frames' | 'library';

/**
 * 今日头条文章包的发布选项。
 *
 * `crossPostWeitoutiao` 要单独解释：头条发布页上「同时发布微头条」**默认是勾选的**，
 * 不处理就会在用户不知情时多发一条内容 —— 我们的默认是关闭，执行器还会读回勾选状态校验。
 */
export interface ToutiaoPublishOptions {
  firstPublish: boolean;
  declarations: string[];
  crossPostWeitoutiao: boolean;
}
export type PublishingListStatus = 'action' | 'all' | PublishTaskStatus | 'broken' | 'trash';

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
  /** 仅图文包：抖音图文口径的文案（title ≤20 / note ≤1000）。 */
  noteCopy?: PlatformCopy;
  /** 仅文章包：文章文案 + 包内 `article.html` 的哈希。 */
  articleCopy?: { title: string; digest?: string; author?: string; htmlSha256: string };
  /** 仅文章包（今日头条）：发布选项 —— 它们改变要发出去的内容，所以参与 previewRevision。 */
  toutiaoOptions?: ToutiaoPublishOptions;
  createdBy: ActorSnapshot;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  purgeAt?: string;
  purgedAt?: string;
}

export type PublishAutoPublishStatus = 'running' | 'awaiting_code' | 'succeeded' | 'failed';

/**
 * 自动发布（外部 sau CLI）的进度记录。
 *
 * 刻意**不扩展 `PublishTaskStatus`**：机器动作的结果只记在这里，
 * `succeeded` 的语义是「已提交」；是否真的发出去了，仍由人工点「标记已发布」确认。
 */
export interface PublishAutoPublish {
  status: PublishAutoPublishStatus;
  startedAt: string;
  finishedAt?: string;
  message?: string;
  attemptId: string;
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
  autoPublish?: PublishAutoPublish;
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
  /** 缺省视为 `video`。 */
  contentType?: PackageContentType;
  /** 仅图文：本次预览用的素材来源；缺省 `frames`（自动静帧）。 */
  imageSource?: NoteImageSource;
  /** 仅图文：将被打包进包的图片，顺序即入包顺序（静帧按场景序、素材库按选择顺序）。 */
  images?: Array<{ name: string; size: number; assetId?: string }>;
  /** 仅图文：抖音图文张数上限，由服务端下发。 */
  imageLimit?: number;
  /** 仅图文：文案字段上限，由服务端下发（表单只渲染，不复刻 20/1000/10 这些数字）。 */
  copyLimits?: NoteCopyLimits;
  /** 仅图文：压缩到图文口径后的默认文案。 */
  noteCopy?: PlatformCopy;
  /** 仅图文：标题是否因超过 20 字被压缩。 */
  noteCopyTitleCompressed?: boolean;
  /** 仅文章包：AI 成文结果（标题 + 正文纯文本）。 */
  articleCopy?: { title: string; body: string };
  /** 仅文章包：字段限额（界面只渲染）。 */
  articleLimits?: { titleMin: number; titleMax: number; bodyChars: number };
  /** 仅文章包：AI 成文走了兜底时的提示（**必须显示**，绝不静默）。 */
  articleFallback?: { code: string; message: string };
  /** 仅文章包：将被裁成 16:9 的封面候选（头条必填）。 */
  articleCover?: { name: string; size: number; assetId?: string };
  /** 仅文章包：头条发布选项的默认值。 */
  toutiaoOptions?: ToutiaoPublishOptions;
}

/** 抖音图文口径的字段上限，与服务端 `PUBLISH_NOTE_POLICIES.douyin` 同源下发。 */
export interface NoteCopyLimits {
  titleMax: number;
  descriptionMax: number;
  hashtagMax: number;
}

/** 文案字段的字数与上限，由服务端按对应口径算好，前端只渲染不复刻规则。 */
export interface PublishingPreviewCopyField {
  actual: number;
  limit: number;
  over: boolean;
}

export interface PublishingPreviewCopyCheck {
  platform: PublishPlatform;
  scope: 'package' | 'task';
  taskId?: string;
  label: string;
  title: PublishingPreviewCopyField;
  description: PublishingPreviewCopyField;
  hashtags: PublishingPreviewCopyField;
  violations: Array<{ platform: PublishPlatform; field: string; actual: number; limit: number; message: string }>;
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
  previewRevision: string;
  video?: { path: string; sha256: string; size: number; method: PackageVideoMethod; hasCover: boolean };
  imagePaths?: string[];
  noteCopy?: PlatformCopy;
  /**
   * 仅文章包：将被提交的文章（标题 + **从包内 article.html 提取的正文纯文本**）。
   * 正文以纯文本下发而不是原样 HTML：预览弹窗只负责渲染文字，不做 HTML 注入。
   */
  articleCopy?: { title: string; body: string };
  /** 仅文章包：本平台的字段限额（界面只渲染，不复刻数字）。 */
  articleLimits?: { titleMin: number; titleMax: number; bodyChars: number };
  /** 仅文章包：发布选项（首发 / 作品声明 / 同步微头条）—— 它们改变要发出去的内容。 */
  toutiaoOptions?: ToutiaoPublishOptions;
  copyChecks: PublishingPreviewCopyCheck[];
  tasks: Array<{
    id: string;
    platform: PublishPlatform;
    status: PublishTaskStatus;
    contentRevision: number;
    scheduledAt?: string;
    copy: PlatformCopy;
  }>;
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
  /** 仅图文包：包级文案（标题 ≤20 / 正文 ≤1000），平台任务文案由服务端同步。 */
  noteCopy?: PlatformCopy;
  /**
   * 仅文章包：文章文案（标题 + 正文纯文本，`## ` 开头的行是小标题）。
   * 与图文包同理：平台任务文案由服务端同步生成，客户端不许传两份。
   */
  articleCopy?: { title: string; body: string };
  /** 仅文章包：今日头条发布选项；缺省全关（微头条同步默认关闭）。 */
  toutiaoOptions?: ToutiaoPublishOptions;
  /** 仅图文包：素材来源；缺省 `frames`。 */
  imageSource?: NoteImageSource;
  /** 仅图文包：`library` 时必填，按选择顺序进包。 */
  imageAssetIds?: string[];
  platforms: Array<{
    platform: PublishPlatform;
    copy: PlatformCopy;
    copySource?: PublishCopySource;
    scheduledAt?: string;
  }>;
}

export interface CreatePublishingVersionPlatformInput {
  platform: PublishPlatform;
  copy?: PlatformCopy;
  scheduledAt?: string | null;
}

export interface CreatePublishingVersionInput {
  title?: string;
  platforms?: PublishPlatform[] | CreatePublishingVersionPlatformInput[];
  schedules?: Partial<Record<PublishPlatform, string | null>>;
}

export interface UpdatePublishingContentInput extends PlatformCopy {
  expectedRevision: number;
}

export type PublishingActionErrorType = 'open_platform' | 'show_in_finder';

export interface ConfirmedPublishingAction {
  confirmation: true;
}

export interface RestoredPublishingPackage {
  package: DeliveryPackage;
  notifications: DueNotification[];
}

export interface PublishingListFilters {
  status?: PublishingListStatus;
  /** 渠道分栏的过滤字段（note = 抖音图文 / article = 今日头条文章 / video = 视频人工交付）。 */
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

export interface ParsedApiError extends PublishingErrorBody {
  status?: number;
}

export interface LocalUsersResponse {
  users: LocalUser[];
  needsBootstrap: boolean;
}

export interface LocalUserResponse {
  user: LocalUser;
}

export interface LocalSessionResponse {
  session: LocalSession;
}

export interface LocalUserSessionResponse extends LocalUserResponse, LocalSessionResponse {}

// 任务阶段
export type JobStage =
  | 'submitted'
  | 'parsed'
  | 'downloading'
  | 'downloaded'
  | 'extracting'
  | 'audio_extracted'
  | 'transcribing'
  | 'transcribed'
  | 'cleaning'
  | 'cleaned'
  | 'generating-video-prompts'
  | 'scripted'
  | 'generating-video'
  | 'rendered'
  | 'failed'
  | 'done'
  | 'error';

export type WorkflowMode = 'manual' | 'auto';

export type PipelineStep =
  | 'transcribe'
  | 'clean'
  | 'generate_video_prompts'
  | 'generate_video';

export type StreamablePipelineStep = 'clean' | 'generate_video_prompts';
export type JobStepStreamEventType = 'started' | 'preview' | 'completed' | 'paused' | 'error';

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

export interface AiStreamPreview {
  step: StreamablePipelineStep;
  status: 'connecting' | 'streaming' | 'completed' | 'paused' | 'error';
  text: string;
  model?: string;
  receivedLength: number;
  message?: string;
}

export type PipelineStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'paused';
export type VideoGenerationPhase =
  | 'checking_environment'
  | 'building_project'
  | 'validating'
  | 'snapshotting'
  | 'rendering'
  | 'verifying';

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

export type JobOverview = Job & {
  preview: JobPreview;
};

export type ViewMode = 'list' | 'card';

export type JobFilterStatus = 'all' | 'processing' | 'failed' | 'done' | 'pending';

// 任务记录
export interface Job {
  id: string;
  sourceUrl?: string;
  shareText?: string;
  topic?: string;
  status: JobStatus;
  stage: JobStage;
  workflowMode?: WorkflowMode;
  steps?: PipelineSteps;
  progress?: number;
  error?: string;
  errorMessage?: string;
  downloadErrorMessage?: string;
  audioErrorMessage?: string;
  transcriptErrorMessage?: string;
  deletedAt?: string;
  trashExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  storagePath?: string;
  videoPath?: string;
  audioPath?: string;
  videoProjectPath?: string;
  videoOutputPath?: string;
  videoGeneratedAt?: string;
}

export interface HyperframesVideoScene {
  index: number;
  title?: string;
  bullets?: string[];
  shotType?: ShotType;
  layout?: ShotLayout;
  headline?: string;
  supportingText?: string;
  captionLines?: string[];
  visualItems?: ShortVideoVisualItem[];
  sourceKeyPoints?: number[];
  subject?: string;
  action?: string;
  cameraMotion?: string;
  visualLayers?: ShortVideoVisualLayer[];
  caption?: string;
  emphasisWords?: string[];
  transition?: ShotTransition;
  pacing?: ShotPacing;
  narration: string;
  duration: number;
  accent: string;
}

export interface HyperframesVideoOutput {
  provider: 'hyperframes';
  projectPath: string;
  videoPath: string;
  manifestPath: string;
  createdAt: string;
  duration: number;
  aspectRatio: '9:16';
  width: 1080;
  height: 1920;
  scenes: HyperframesVideoScene[];
}

export interface VideoPromptScene {
  scene: number;
  originalVisual: string;
  videoPrompt: string;
  cameraMovement?: string;
  motionEffect?: string;
  lightingStyle?: string;
}

export type ShotType = 'hook' | 'problem' | 'explain' | 'proof' | 'contrast' | 'process' | 'summary' | 'cta';

export type ShotPacing = 'fast' | 'medium' | 'slow';

export type ShotTransition = 'cut' | 'wipe' | 'push' | 'zoom' | 'match-cut' | 'flash';

export type ShotLayout =
  | 'kinetic-title'
  | 'concept-map'
  | 'process-flow'
  | 'comparison'
  | 'metric'
  | 'summary-stack';

export type ShotVisualTone = 'primary' | 'success' | 'danger' | 'muted';

export interface ShortVideoVisualItem {
  label: string;
  value?: string;
  tone?: ShotVisualTone;
}

export type ShortVideoVisualLayerType =
  | 'background'
  | 'subject'
  | 'graphic'
  | 'caption'
  | 'emphasis'
  | 'decoration';

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

export interface TranscriptSegment {
  start?: number;
  end?: number;
  text: string;
}

export interface RawTranscript {
  transcript: string;
  text?: string;
  segments?: TranscriptSegment[];
  duration?: number;
  language?: string;
  model?: string;
  provider?: string;
  createdAt?: string;
}

// 清洗后的脚本
export interface CleanedScript {
  jobId: string;
  sourceUrl: string;
  topic?: string;
  transcriptText?: string;
  supplementalText?: string;
  cleaningMode?: string;
  createdAt?: string;
  output?: {
    title?: string;
    rawText?: string;
    cleanScript?: string;
    summary?: string;
    hook?: string;
    shortVideoScript?: string;
    keyPoints?: string[];
    tags?: string[];
    videoOutline?: Array<{
      title: string;
      bullets: string[];
      visualPrompt?: string;
    }>;
    videoPrompts?: string[];
    enhancedScenes?: VideoPromptScene[];
    shortVideoShots?: ShortVideoShot[];
    planVersion?: 2;
    targetDuration?: 60;
    qualityNotes?: string[];
    voiceoverScript?: string;
    coverTitle?: string;
    hyperframesVideo?: HyperframesVideoOutput;
  };
  parsed?: any;
  pageInfo?: any;
}

// API 响应
export interface ApiResponse<T = any> {
  message?: string;
  job?: Job;
  cleaned?: CleanedScript;
  rawTranscript?: RawTranscript;
  videoPrompts?: string[];
  enhancedScenes?: VideoPromptScene[];
  shortVideoShots?: ShortVideoShot[];
  planVersion?: 2;
  targetDuration?: 60;
  shortVideoScript?: string;
  videoOutline?: Array<{
    title: string;
    bullets: string[];
    visualPrompt?: string;
  }>;
  videoOutput?: HyperframesVideoOutput;
  error?: string;
  jobs?: Job[];
}

// --- 合集相关类型 ---

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
  childJobMap?: Record<string, string>; // awemeId → jobId
  skillName?: string;
  skillPath?: string;
  autoSyncSkill?: boolean;
  skillGeneratedAt?: string;
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

// Skill 生成 API 响应
export interface GenerateSkillResponse {
  success: boolean;
  skillName: string;
  skillPath: string;
  message: string;
  generated: string[];
  allGenerated: string[];
  skillType: string;
  failed?: string[];
}

// Skill 查看内容响应
export interface SkillContentResponse {
  skillName: string;
  skillPath: string;
  skillMarkdown: string;
  sourceMarkdown: string;
  meta: {
    collectionId: string;
    nickname: string;
    sourcePageUrl: string;
    generatedAt: string;
    videoCount: number;
    hasFocusPrompt: boolean;
    skillType?: string;
    generated?: string[];
  } | null;
  // 增强产物
  knowledgeBase: string;
  caseLibrary: string;
  quotesCollection: string;
  checklist: string;
  decisionFramework: string;
  evalCases: string;
  templates: Array<{ name: string; content: string }>;
}

// Skill 列表项
export interface SkillSummary {
  collectionId: string;
  collectionNickname: string;
  avatarUrl: string;
  skillName: string;
  skillPath: string;
  skillGeneratedAt: string;
  autoSyncSkill: boolean;
  transcribedCount: number;
}

export interface SkillsListResponse {
  skills: SkillSummary[];
}

// 合集全部转录文本聚合响应
export interface CollectionTranscriptsResponse {
  collection: { id: string; nickname: string };
  transcripts: Array<{
    jobId: string;
    desc: string;
    transcript: string;
    duration?: number;
    segments?: TranscriptSegment[];
  }>;
  aggregatedText: string;
  summary: { totalJobs: number; transcribed: number };
}

// ─── 素材库 ─────────────────────────────────────────────────────────

export type AssetKind = 'image' | 'audio';

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  filename: string;
  originalName: string;
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  createdAt: string;
}
