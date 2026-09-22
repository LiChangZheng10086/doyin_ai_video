import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, FileText, Link as LinkIcon, Users } from 'lucide-react';
import { apiClient } from '../services/api';
import { useAppStore } from '../store';
import { Modal } from './ui/Modal';

interface CreateJobDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type InputMode = 'url' | 'text' | 'user-page';

export function CreateJobDialog({ isOpen, onClose }: CreateJobDialogProps) {
  const [sourceUrl, setSourceUrl] = useState('');
  const [shareText, setShareText] = useState('');
  const [topic, setTopic] = useState('');
  const [userPageUrl, setUserPageUrl] = useState('');
  const [maxItems, setMaxItems] = useState(50);
  const [inputMode, setInputMode] = useState<InputMode>('url');
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
      if (inputMode === 'user-page') {
        // 主页链接模式：爬取用户主页 + 跳转到合集详情页
        if (!userPageUrl.trim()) {
          setError('请输入抖音用户主页链接');
          setIsSubmitting(false);
          return;
        }

        // 验证 URL 格式
        if (!/douyin\.com\/user\//i.test(userPageUrl.trim())) {
          setError('请输入有效的抖音用户主页链接（如 https://www.douyin.com/user/xxxxx）');
          setIsSubmitting(false);
          return;
        }

        const result = await apiClient.createCollection({
          pageUrl: userPageUrl.trim(),
          maxItems,
        });

        // 重置表单
        setUserPageUrl('');
        setMaxItems(50);
        setTopic('');
        onClose();
        navigate(`/collections/${result.collection.id}`);
        return;
      }

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
        return;
      }

      // 重置表单
      setSourceUrl('');
      setShareText('');
      setTopic('');
      onClose();
      navigate(`/jobs/${createdJob.id}`);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || '创建失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    /*
     * 改造前这里是一个裸 div：`bg-black bg-opacity-50` + **没有** role="dialog"、
     * 没有 Esc、没有焦点移入与陷阱、背景没有 inert。
     * 而且 `bg-opacity-*` 在 Tailwind v4 里**已被移除**（实测：该 class 不产出任何规则），
     * 所以遮罩实际是 `bg-black` 全不透明 —— 整个应用入口背后是一片纯黑，
     * 后面的 `backdrop-blur-sm` 也就白写了。
     * 现在换成共享 Modal：portal + role/aria-modal/aria-labelledby + Esc + 焦点陷阱
     * + #root inert + 55% 遮罩。
     */
    <Modal
      open
      onClose={onClose}
      busy={isSubmitting}
      size="md"
      title="创建新任务"
      subtitle={
        <p className="text-sm text-ink-muted">
          {inputMode === 'user-page'
            ? '输入抖音用户主页链接，批量采集该用户全部作品'
            : '输入抖音视频链接或分享文本开始处理'}
        </p>
      }
    >
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* 输入模式切换 */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setInputMode('url')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                inputMode === 'url'
                  ? 'bg-accent text-on-accent shadow-sm inline-flex items-center gap-2'
                  : 'bg-canvas text-ink-muted hover:bg-elevated inline-flex items-center gap-2'
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
                  ? 'bg-accent text-on-accent shadow-sm inline-flex items-center gap-2'
                  : 'bg-canvas text-ink-muted hover:bg-elevated inline-flex items-center gap-2'
              }`}
            >
              <FileText size={16} />
              分享文本
            </button>
            <button
              type="button"
              onClick={() => setInputMode('user-page')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                inputMode === 'user-page'
                  ? 'bg-ai text-on-accent shadow-sm inline-flex items-center gap-2'
                  : 'bg-canvas text-ink-muted hover:bg-elevated inline-flex items-center gap-2'
              }`}
            >
              <Users size={16} />
              主页采集
            </button>
          </div>

          {/* URL 输入 */}
          {inputMode === 'url' && (
            <div>
              <label className="block text-sm font-medium text-ink mb-2">
                抖音视频链接
              </label>
              <input
                type="text"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://www.douyin.com/video/..."
                className="w-full px-4 py-3 rounded-lg border border-line-ui bg-well text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all"
              />
            </div>
          )}

          {/* 分享文本输入 */}
          {inputMode === 'text' && (
            <div>
              <label className="block text-sm font-medium text-ink mb-2">
                分享文本
              </label>
              <textarea
                value={shareText}
                onChange={(e) => setShareText(e.target.value)}
                placeholder="粘贴抖音分享文本..."
                rows={4}
                className="w-full px-4 py-3 rounded-lg border border-line-ui bg-well text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent resize-none transition-all"
              />
            </div>
          )}

          {/* 主页链接输入 */}
          {inputMode === 'user-page' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-ink mb-2">
                  抖音用户主页链接
                </label>
                <input
                  type="text"
                  value={userPageUrl}
                  onChange={(e) => setUserPageUrl(e.target.value)}
                  placeholder="https://www.douyin.com/user/xxxxxxxxx"
                  className="w-full px-4 py-3 rounded-lg border border-line-ui bg-well text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-ai focus:border-transparent transition-all"
                />
                <p className="mt-1 text-xs text-ink-muted">
                  例如：https://www.douyin.com/user/MS4wLjABAAAA...
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-ink mb-2">
                  最大采集数量
                  <span className="text-ink-muted font-normal ml-1">(1-500)</span>
                </label>
                <input
                  type="number"
                  value={maxItems}
                  onChange={(e) => setMaxItems(Math.min(500, Math.max(1, Number(e.target.value) || 1)))}
                  min={1}
                  max={500}
                  className="w-full px-4 py-3 rounded-lg border border-line-ui bg-well text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-ai focus:border-transparent transition-all"
                />
              </div>
              <div className="rounded-lg border border-ai-line bg-ai-soft p-3 text-sm text-ai">
                <p>系统将自动获取该用户的主页信息及全部视频作品，您可以在合集详情页选择需要处理的视频。</p>
              </div>
            </div>
          )}

          {/* 主题（可选）— 主页模式也支持 */}
          <div>
            <label className="block text-sm font-medium text-ink mb-2">
              {inputMode === 'user-page' ? '合集名称' : '主题'} <span className="text-ink-muted font-normal">(可选)</span>
            </label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder={inputMode === 'user-page' ? '例如：某某博主的作品合集' : '例如：科技、美食、旅游...'}
              className="w-full px-4 py-3 rounded-lg border border-line-ui bg-well text-ink placeholder-ink-muted focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all"
            />
          </div>

          {/* 错误信息 */}
          {error && (
            <div className="bg-danger-soft border border-danger-line text-danger px-4 py-3 rounded-lg text-sm flex items-start gap-2">
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
              className="px-5 py-2.5 rounded-lg border border-line text-ink hover:bg-elevated transition-all disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className={`px-5 py-2.5 rounded-lg text-on-accent shadow-sm hover:shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                inputMode === 'user-page'
                  ? 'bg-ai hover:bg-ai'
                  : 'bg-accent hover:bg-accent-hover'
              }`}
            >
              {isSubmitting
                ? inputMode === 'user-page'
                  ? '采集中...'
                  : '创建中...'
                : inputMode === 'user-page'
                  ? '开始采集'
                  : '创建任务'}
            </button>
          </div>
        </form>
    </Modal>
  );
}
