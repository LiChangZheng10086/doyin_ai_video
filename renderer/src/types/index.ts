// 任务状态
export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

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

export type PipelineStepStatus = 'pending' | 'running' | 'succeeded' | 'failed';
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
