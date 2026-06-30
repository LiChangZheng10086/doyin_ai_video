import { Job } from '../types';

interface JobCardProps {
  job: Job;
  onClick?: () => void;
}

// 状态显示配置
const statusConfig = {
  queued: { label: '排队中', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  processing: { label: '处理中', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  completed: { label: '已完成', color: 'bg-green-50 text-green-700 border-green-200' },
  failed: { label: '失败', color: 'bg-red-50 text-red-700 border-red-200' },
};

// 阶段显示配置
const stageConfig: Record<string, string> = {
  submitted: '已提交',
  downloading: '下载中',
  extracting: '提取中',
  transcribing: '转录中',
  cleaning: '清洗中',
  'generating-video-prompts': '生成视频提示词',
  'generating-ppt': '生成 PPT',
  done: '完成',
  error: '错误',
};

export function JobCard({ job, onClick }: JobCardProps) {
  const statusInfo = statusConfig[job.status];
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
        <span className={`px-3 py-1 rounded-md text-xs border ${statusInfo.color}`}>
          {statusInfo.label}
        </span>
      </div>

      {/* URL or Share Text */}
      {job.sourceUrl && (
        <p className="text-sm text-tech-muted mb-3 line-clamp-1 flex items-center gap-1">
          <span className="text-tech-blue">🔗</span>
          {job.sourceUrl}
        </p>
      )}
      {job.shareText && !job.sourceUrl && (
        <p className="text-sm text-tech-muted mb-3 line-clamp-2 flex items-start gap-1">
          <span className="text-tech-blue">📝</span>
          <span>{job.shareText}</span>
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
      {job.status === 'failed' && job.error && (
        <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
          {job.error}
        </div>
      )}

      {/* Completed Time */}
      {job.status === 'completed' && job.completedAt && (
        <p className="text-xs text-tech-muted mt-2">
          完成于 {formatDate(job.completedAt)}
        </p>
      )}
    </div>
  );
}
