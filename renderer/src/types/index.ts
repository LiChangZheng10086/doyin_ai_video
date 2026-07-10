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

export interface PipelineStepState {
  status: PipelineStepStatus;
  attempts: number;
  lastError?: string;
  startedAt?: string;
  finishedAt?: string;
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
  title: string;
  bullets: string[];
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
    keyPoints?: string[];
    tags?: string[];
    videoOutline?: Array<{
      title: string;
      bullets: string[];
      visualPrompt?: string;
    }>;
    videoPrompts?: string[];
    enhancedScenes?: VideoPromptScene[];
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
  videoOutput?: HyperframesVideoOutput;
  error?: string;
  jobs?: Job[];
}
