export type JobStatus = "queued" | "processing" | "done" | "failed";

export type JobStage =
  | "submitted"
  | "parsed"
  | "downloading"
  | "downloaded"
  | "audio_extracted"
  | "transcribing"
  | "cleaned"
  | "scripted"
  | "rendered"
  | "failed";

export interface JobRecord {
  id: string;
  sourceUrl: string;
  topic: string;
  status: JobStatus;
  stage: JobStage;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
  downloadErrorMessage?: string;
  audioErrorMessage?: string;
  transcriptErrorMessage?: string;
  videoPath?: string;
  videoMetadataPath?: string;
  audioPath?: string;
  audioManifestPath?: string;
  transcriptPath?: string;
  transcriptModel?: string;
  storagePath: string;
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
  keyPoints?: string[];
  qualityNotes?: string[];
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
