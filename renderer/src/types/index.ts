// 任务状态
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

// 任务阶段
export type JobStage =
  | 'submitted'
  | 'downloading'
  | 'extracting'
  | 'transcribing'
  | 'cleaning'
  | 'generating-video-prompts'
  | 'generating-ppt'
  | 'done'
  | 'error';

// 任务记录
export interface Job {
  id: string;
  sourceUrl?: string;
  shareText?: string;
  topic?: string;
  status: JobStatus;
  stage: JobStage;
  progress?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  storagePath?: string;
}

// 清洗后的脚本
export interface CleanedScript {
  rawText: string;
  cleanedSentences: Array<{
    text: string;
    startTime?: number;
    endTime?: number;
  }>;
  summary?: string;
  keyPoints?: string[];
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
  videoPrompts?: any;
  pptContent?: any;
  error?: string;
}
