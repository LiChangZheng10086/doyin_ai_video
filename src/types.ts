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

export type PublishPlatform = "douyin" | "xiaohongshu" | "wechat_channels" | "bilibili";
export type PublishTaskStatus = "scheduled" | "ready" | "published" | "failed" | "cancelled";
export type PublishPackageState = "active" | "trashed" | "purged";
export type PublishCopySource = "ai" | "cleaned_fallback" | "user_edited";
export type PackageVideoMethod = "clone" | "copy";
export type PublishAssetHealth = "healthy" | "missing_cover" | "broken_video";
export type PublishingListStatus = "action" | "all" | PublishTaskStatus | "broken" | "trash";

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
}

export interface CreatePublishingPackageInput {
  sourceJobId: string;
  previewRevision: string;
  title: string;
  platforms: Array<{
    platform: PublishPlatform;
    copy: PlatformCopy;
    copySource: PublishCopySource;
    scheduledAt?: string;
  }>;
}

export interface PublishingListFilters {
  status?: PublishingListStatus;
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

export type PipelineStepStatus = "pending" | "running" | "succeeded" | "failed";
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
  cleaningMode?: "deepseek" | "openai" | "fallback";
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
