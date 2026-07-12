import { FileText, Link as LinkIcon } from 'lucide-react';
import { Job, PipelineStep } from '../types';

interface JobCardProps {
  job: Job;
  onClick?: () => void;
  onDelete?: () => void;
}

// 状态显示配置
const statusConfig = {
  queued: { label: '排队中', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  processing: { label: '处理中', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  done: { label: '已完成', color: 'bg-green-50 text-green-700 border-green-200' },
  failed: { label: '失败', color: 'bg-red-50 text-red-700 border-red-200' },
};

const manualStepLabels: Record<PipelineStep, string> = {
  transcribe: '视频转录',
  clean: 'AI 洗稿',
  generate_video_prompts: '生成分镜',
  generate_video: '生成视频',
};

const manualStepOrder: PipelineStep[] = ['transcribe', 'clean', 'generate_video_prompts', 'generate_video'];

// 阶段显示配置
const stageConfig: Record<string, string> = {
  submitted: '已提交',
  parsed: '已解析',
  downloading: '下载中',
  downloaded: '已下载',
  extracting: '提取中',
  audio_extracted: '音频已提取',
  transcribing: '转录中',
  transcribed: '已转录',
  cleaning: '清洗中',
  cleaned: '已清洗',
  'generating-video-prompts': '生成分镜',
  scripted: '脚本完成',
  'generating-video': '生成视频',
  rendered: '已渲染',
  failed: '失败',
  done: '完成',
  error: '错误',
};

export function JobCard({ job, onClick, onDelete }: JobCardProps) {
  const manualSummary = getManualSummary(job);
  const statusInfo = job.workflowMode === 'manual' && job.status === 'queued'
    ? { label: '待执行', color: 'bg-blue-50 text-blue-700 border-blue-200' }
    : statusConfig[job.status as keyof typeof statusConfig] || {
    label: job.status,
    color: 'bg-gray-50 text-gray-700 border-gray-200'
  };
  const stageLabel = stageConfig[job.stage] || job.stage;

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div
      onClick={onClick}
      className="bg-tech-surface rounded-lg border border-tech-border p-5 hover:border-tech-blue hover:shadow-lg transition-all duration-200 cursor-pointer"
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1">
          <h3 className="font-medium text-tech-text mb-1 line-clamp-1">
            {job.topic || '无主题'}
          </h3>
          <p className="text-xs text-tech-muted">
            {formatDate(job.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-3 py-1 rounded-md text-xs border ${statusInfo.color}`}>
            {statusInfo.label}
          </span>
          {onDelete && !job.deletedAt && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              className="px-2 py-1 rounded-md text-xs border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
            >
              删除
            </button>
          )}
        </div>
      </div>

      {/* URL or Share Text */}
      {job.sourceUrl && (
        <p className="text-sm text-tech-muted mb-3 line-clamp-1 flex items-center gap-1">
          <LinkIcon size={14} className="text-tech-blue shrink-0" />
          {job.sourceUrl}
        </p>
      )}
      {job.shareText && !job.sourceUrl && (
        <p className="text-sm text-tech-muted mb-3 line-clamp-2 flex items-start gap-1">
          <FileText size={14} className="text-tech-blue shrink-0 mt-0.5" />
          <span>{job.shareText}</span>
        </p>
      )}

      {manualSummary && (
        <p className="text-xs text-tech-muted mb-3">
          {manualSummary}
        </p>
      )}

      {/* Progress */}
      {job.status === 'processing' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-tech-muted">
            <span>{stageLabel}</span>
            {job.progress !== undefined && (
              <span className="font-mono">{Math.round(job.progress)}%</span>
            )}
          </div>
          {job.progress !== undefined && (
            <div className="w-full bg-tech-bg rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-gradient-to-r from-tech-blue to-tech-blue-light h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${job.progress}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {job.status === 'failed' && (job.error || getManualError(job)) && (
        <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          {job.error || getManualError(job)}
        </div>
      )}

      {/* Completed Time */}
      {job.status === 'done' && job.completedAt && (
        <p className="text-xs text-tech-muted mt-2">
          完成于 {formatDate(job.completedAt)}
        </p>
      )}
    </div>
  );
}

function getManualSummary(job: Job) {
  if (job.workflowMode !== 'manual' || !job.steps) {
    return '';
  }
  const running = manualStepOrder.find((step) => job.steps?.[step]?.status === 'running');
  if (running) {
    return `正在执行：${manualStepLabels[running]}`;
  }
  const failed = manualStepOrder.find((step) => job.steps?.[step]?.status === 'failed');
  if (failed) {
    return `失败待重试：${manualStepLabels[failed]}`;
  }
  const next = manualStepOrder.find((step) => job.steps?.[step]?.status !== 'succeeded');
  if (next) {
    return `下一步：${manualStepLabels[next]}`;
  }
  return '主链路已完成';
}

function getManualError(job: Job) {
  if (!job.steps) {
    return '';
  }
  const failed = manualStepOrder.find((step) => job.steps?.[step]?.status === 'failed');
  return failed ? job.steps[failed].lastError : '';
}
