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
  | 'generating-ppt'
  | 'scripted'
  | 'rendered'
  | 'failed'
  | 'done'
  | 'error';

export type WorkflowMode = 'manual' | 'auto';

export type PipelineStep =
  | 'download'
  | 'extract_audio'
  | 'transcribe'
  | 'clean'
  | 'generate_ppt';

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
  hasPpt: boolean;
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
    content?: string;
    tags?: string[];
    videoPrompts?: any[];
    pptContent?: any;
    pptOutline?: Array<{
      title: string;
      bullets: string[];
    }>;
    qualityNotes?: string[];
    enhancedScenes?: any[];
    sceneList?: any[];
    voiceoverScript?: string;
    hashtags?: string[];
    introText?: string;
    coverTitle?: string;
  };
  parsed?: any;
  pageInfo?: any;
}

// 脚本资产
export interface ScriptAsset {
  id: string;
  topic: string;
  script: string;
  scenes?: Array<{
    index: number;
    text: string;
    description?: string;
  }>;
  videoPrompts?: Array<{
    sceneIndex: number;
    prompt: string;
    style?: string;
  }>;
  enhancedScenes?: Array<{
    index: number;
    originalText: string;
    enhancedPrompt: string;
  }>;
  pptContent?: any;
  pptStyle?: string;
  pptPath?: string;
}

// API 响应
export interface ApiResponse<T = any> {
  message?: string;
  job?: Job;
  script?: ScriptAsset;
  cleaned?: CleanedScript;
  rawTranscript?: RawTranscript;
  videoPrompts?: any;
  pptContent?: any;
  error?: string;
  jobs?: Job[];
}
