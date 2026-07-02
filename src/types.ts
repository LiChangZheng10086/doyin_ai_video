export type JobStatus = "queued" | "processing" | "done" | "failed";

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
  | "generating-ppt"
  | "scripted"
  | "rendered"
  | "failed";

export type WorkflowMode = "manual" | "auto";

export type PipelineStep =
  | "download"
  | "extract_audio"
  | "transcribe"
  | "clean"
  | "generate_ppt";

export type PipelineStepStatus = "pending" | "running" | "succeeded" | "failed";

export interface PipelineStepState {
  status: PipelineStepStatus;
  attempts: number;
  lastError?: string;
  startedAt?: string;
  finishedAt?: string;
}

export type PipelineSteps = Record<PipelineStep, PipelineStepState>;

export interface JobRecord {
  id: string;
  sourceUrl: string;
  topic: string;
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
  storagePath: string;
}

export interface JobPreview {
  displayTitle: string;
  subtitle: string;
  sourcePlatform: string;
  authorName?: string;
  summary?: string;
  coverTitle?: string;
  hasTranscript: boolean;
  hasRewrite: boolean;
  hasPpt: boolean;
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

export interface PPTSlide {
  title: string;
  bullets: string[];
  speakerNotes: string;
  imagePrompt: string;
}

export interface PPTContent {
  slides: PPTSlide[];
  style: string;
  theme: string;
}

export interface ScriptAsset {
  sourceUrl: string;
  videoId?: string;
  title?: string;
  pageTitle?: string;
  pageDescription?: string;
  authorName?: string;
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
  keyPoints?: string[];
  qualityNotes?: string[];
  pptOutline?: Array<{
    title: string;
    bullets: string[];
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
  videoEnhancedAt?: string;

  // PPT 生成字段
  pptContent?: PPTContent;
  pptPath?: string;
  pptStyle?: string;
  pptGeneratedAt?: string;
}
