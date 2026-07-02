import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, FileText, Link as LinkIcon } from 'lucide-react';
import { apiClient } from '../services/api';
import { useAppStore } from '../store';

interface CreateJobDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateJobDialog({ isOpen, onClose }: CreateJobDialogProps) {
  const [sourceUrl, setSourceUrl] = useState('');
  const [shareText, setShareText] = useState('');
  const [topic, setTopic] = useState('');
  const [inputMode, setInputMode] = useState<'url' | 'text'>('url');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const setJobs = useAppStore((state) => state.setJobs);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      const params: any = { topic: topic || undefined };

      if (inputMode === 'url') {
        if (!sourceUrl.trim()) {
          setError('请输入抖音链接');
          setIsSubmitting(false);
          return;
        }
        params.sourceUrl = sourceUrl.trim();
      } else {
        if (!shareText.trim()) {
          setError('请输入分享文本');
          setIsSubmitting(false);
          return;
        }
        params.shareText = shareText.trim();
      }

      const createdJob = await apiClient.createJob(params);

      // 立即刷新任务列表，确保新任务显示
      try {
        const response = await apiClient.get('/api/jobs');
        if (response.data?.jobs) {
          setJobs(response.data.jobs);
        }
      } catch (refreshError) {
        console.error('Failed to refresh jobs:', refreshError);
        setError('任务已创建，但列表刷新失败。请手动刷新页面查看。');
        setIsSubmitting(false);
        return; // 不关闭对话框，让用户看到提示
      }

      // 重置表单
      setSourceUrl('');
      setShareText('');
      setTopic('');
      onClose();
      navigate(`/jobs/${createdJob.id}`);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || '创建任务失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-tech-surface rounded-xl shadow-2xl w-full max-w-2xl mx-4 border border-tech-border">
        {/* Header */}
        <div className="border-b border-tech-border px-6 py-4">
          <h2 className="text-xl font-semibold text-tech-text">
            创建新任务
          </h2>
          <p className="text-sm text-tech-muted mt-1">
            输入抖音视频链接或分享文本开始处理
          </p>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* 输入模式切换 */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setInputMode('url')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                inputMode === 'url'
                  ? 'bg-tech-blue text-white shadow-sm inline-flex items-center gap-2'
                  : 'bg-tech-bg text-tech-muted hover:bg-tech-border inline-flex items-center gap-2'
              }`}
            >
              <LinkIcon size={16} />
              抖音链接
            </button>
            <button
              type="button"
              onClick={() => setInputMode('text')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                inputMode === 'text'
                  ? 'bg-tech-blue text-white shadow-sm inline-flex items-center gap-2'
                  : 'bg-tech-bg text-tech-muted hover:bg-tech-border inline-flex items-center gap-2'
              }`}
            >
              <FileText size={16} />
              分享文本
            </button>
          </div>

          {/* URL 输入 */}
          {inputMode === 'url' && (
            <div>
              <label className="block text-sm font-medium text-tech-text mb-2">
                抖音视频链接
              </label>
              <input
                type="text"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://www.douyin.com/video/..."
                className="w-full px-4 py-3 rounded-lg border border-tech-border bg-tech-surface text-tech-text placeholder-tech-muted focus:outline-none focus:ring-2 focus:ring-tech-blue focus:border-transparent transition-all"
              />
            </div>
          )}

          {/* 分享文本输入 */}
          {inputMode === 'text' && (
            <div>
              <label className="block text-sm font-medium text-tech-text mb-2">
                分享文本
              </label>
              <textarea
                value={shareText}
                onChange={(e) => setShareText(e.target.value)}
                placeholder="粘贴抖音分享文本..."
                rows={4}
                className="w-full px-4 py-3 rounded-lg border border-tech-border bg-tech-surface text-tech-text placeholder-tech-muted focus:outline-none focus:ring-2 focus:ring-tech-blue focus:border-transparent resize-none transition-all"
              />
            </div>
          )}

          {/* 主题（可选） */}
          <div>
            <label className="block text-sm font-medium text-tech-text mb-2">
              主题 <span className="text-tech-muted font-normal">(可选)</span>
            </label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如：科技、美食、旅游..."
              className="w-full px-4 py-3 rounded-lg border border-tech-border bg-tech-surface text-tech-text placeholder-tech-muted focus:outline-none focus:ring-2 focus:ring-tech-blue focus:border-transparent transition-all"
            />
          </div>

          {/* 错误信息 */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* 按钮 */}
          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-lg border border-tech-border text-tech-text hover:bg-tech-bg transition-all disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-lg bg-tech-blue text-white hover:bg-tech-blue-dark shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? '创建中...' : '创建任务'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
