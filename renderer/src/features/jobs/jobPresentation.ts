import type { Job, JobOverview, JobFilterStatus, PipelineStep, PipelineStepState, ViewMode } from '../../types/index';

// ── Visual State ──

export type JobVisualState = {
  label: '待执行' | '处理中' | '已完成' | '失败';
  tone: 'info' | 'processing' | 'success' | 'danger';
  busy: boolean;
};

export function getJobVisualState(job: Job | JobOverview): JobVisualState {
  if (job.workflowMode === 'manual' && job.status === 'queued') {
    return { label: '待执行', tone: 'info', busy: false };
  }
  if (job.status === 'processing') {
    return { label: '处理中', tone: 'processing', busy: true };
  }
  if (job.status === 'done') {
    return { label: '已完成', tone: 'success', busy: false };
  }
  if (job.status === 'failed') {
    return { label: '失败', tone: 'danger', busy: false };
  }
  return { label: '待执行', tone: 'info', busy: false };
}

// ── Artifacts ──

export type ArtifactKey = 'transcript' | 'script' | 'shots' | 'video';
export type ArtifactState = 'ready' | 'processing' | 'waiting' | 'failed';

export interface ArtifactAvailability {
  transcriptReady: boolean;
  rewriteReady: boolean;
  shotsReady: boolean;
  videoReady: boolean;
  transcriptError?: string | null;
  rewriteError?: string | null;
  videoError?: string | null;
}

export function buildArtifactStates(
  job: Job,
  availability: ArtifactAvailability,
): Array<{ key: ArtifactKey; label: string; state: ArtifactState }> {
  const statusOf = (step: PipelineStep): PipelineStepState | undefined => job.steps?.[step];

  const resolve = (step: PipelineStep, readyCheck: boolean, error?: string | null): ArtifactState => {
    const stepState = statusOf(step);
    if (stepState?.status === 'running') return 'processing';
    if (stepState?.status === 'failed' || error) return 'failed';
    if (readyCheck) return 'ready';
    if (stepState?.status === 'succeeded') return 'failed'; // step succeeded but file missing
    return 'waiting';
  };

  return [
    { key: 'transcript', label: '转录', state: resolve('transcribe', availability.transcriptReady, availability.transcriptError) },
    { key: 'script', label: 'AI 洗稿', state: resolve('clean', availability.rewriteReady, availability.rewriteError) },
    { key: 'shots', label: '分镜', state: resolve('generate_video_prompts', availability.shotsReady) },
    { key: 'video', label: '视频成片', state: resolve('generate_video', availability.videoReady, availability.videoError) },
  ];
}

// ── Workflow Steps ──

export interface WorkflowStepView {
  key: PipelineStep;
  index: number;
  label: string;
  status: PipelineStepState['status'];
  blocked: boolean;
  actionLabel: string;
  progress?: number;
  error?: string;
}

const STEP_LABELS: Record<PipelineStep, string> = {
  transcribe: '视频转录',
  clean: 'AI 洗稿',
  generate_video_prompts: '生成分镜',
  generate_video: '生成视频',
};

const STEP_ORDER: PipelineStep[] = ['transcribe', 'clean', 'generate_video_prompts', 'generate_video'];

export function buildWorkflowSteps(
  job: Job,
  runningStep: PipelineStep | null,
): WorkflowStepView[] {
  return STEP_ORDER.map((key, index) => {
    const step = job.steps?.[key];
    const status = step?.status ?? 'pending';

    // Determine if blocked
    let blocked = false;
    if (index > 0 && status === 'pending') {
      const prevKey = STEP_ORDER[index - 1];
      const prevStep = job.steps?.[prevKey];
      blocked = !prevStep || prevStep.status !== 'succeeded';
    }

    // Determine action label
    let actionLabel: string;
    if (status === 'failed') {
      actionLabel = `重试 ${STEP_LABELS[key]}`;
    } else if (status === 'paused') {
      actionLabel = `重新执行 ${STEP_LABELS[key]}`;
    } else if (status === 'running') {
      actionLabel = `${STEP_LABELS[key]}进行中...`;
    } else if (status === 'succeeded') {
      actionLabel = `${STEP_LABELS[key]}已完成`;
    } else if (blocked) {
      const prevLabel = index > 0 ? STEP_LABELS[STEP_ORDER[index - 1]] : '前置步骤';
      actionLabel = `等待 ${prevLabel}完成`;
    } else if (status === 'pending') {
      actionLabel = `执行 ${STEP_LABELS[key]}`;
    } else {
      actionLabel = STEP_LABELS[key];
    }

    return {
      key,
      index: index + 1,
      label: STEP_LABELS[key],
      status,
      blocked,
      actionLabel,
      progress: step?.progress,
      error: step?.lastError,
    };
  });
}

// ── Filtering & Selection ──

export function filterJobOverviews(
  jobs: JobOverview[],
  query: string,
  filter: JobFilterStatus,
): JobOverview[] {
  const needle = query.trim().toLowerCase();
  return jobs.filter((job) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'pending'
        ? job.status === 'queued' && job.workflowMode === 'manual'
        : job.status === filter);
    if (!matchesFilter) return false;
    if (!needle) return true;
    return [
      job.preview.displayTitle,
      job.preview.subtitle,
      job.preview.summary,
      job.preview.sourcePlatform,
      job.topic,
      job.sourceUrl,
    ].some((value) => value?.toLowerCase().includes(needle));
  });
}

export function selectActiveJob(overviews: JobOverview[]): JobOverview | undefined {
  return overviews.find((job) => job.status === 'processing' || (job.workflowMode === 'manual' && job.status === 'queued'));
}

// ── View Mode Persistence ──

export const JOB_VIEW_MODE_KEY = 'douyin-ai-video.job-view-mode';

export function readStoredViewMode(storage: Storage): ViewMode {
  try {
    const raw = storage.getItem(JOB_VIEW_MODE_KEY);
    if (raw === 'card') return 'card';
    return 'list';
  } catch {
    return 'list';
  }
}

export function writeStoredViewMode(storage: Storage, mode: ViewMode): void {
  try {
    if (mode === 'card') {
      storage.setItem(JOB_VIEW_MODE_KEY, 'card');
    } else {
      storage.removeItem(JOB_VIEW_MODE_KEY);
    }
  } catch {
    // ignore quota errors
  }
}

// ── Formatters ──

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
