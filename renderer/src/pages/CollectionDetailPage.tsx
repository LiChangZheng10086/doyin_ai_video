import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Mic,
  Play,
  Plus,
  Sparkles,
  Users,
  Video,
  Wand2,
  XCircle,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { CookieHint } from '../components/CookieHint';
import { apiClient } from '../services/api';
import type { CollectionOverview, DouyinVideoItem, Job, PipelineStep } from '../types';

const pipelineSteps: Array<{ id: PipelineStep; label: string; description: string; icon: typeof Video }> = [
  { id: 'transcribe', label: '批量转录', description: '全部子任务执行视频转录', icon: Mic },
  { id: 'clean', label: '批量洗稿', description: '全部子任务执行 AI 洗稿', icon: Sparkles },
  { id: 'generate_video_prompts', label: '批量分镜', description: '全部子任务生成分镜', icon: Wand2 },
  { id: 'generate_video', label: '批量生成视频', description: '全部子任务渲染视频', icon: Video },
];

export function CollectionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [collection, setCollection] = useState<CollectionOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [creatingJobs, setCreatingJobs] = useState(false);
  const [runningStep, setRunningStep] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [batchResults, setBatchResults] = useState<Array<{ jobId: string; status: string; error?: string }> | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const data = await apiClient.getCollection(id);
      setCollection(data);
    } catch (err: any) {
      setError(err.response?.data?.message || '加载合集失败');
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 定时刷新进度
  useEffect(() => {
    if (!collection) return;
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [collection, refresh]);

  const createdJobIds = useMemo(
    () => new Set(collection?.childJobIds ?? []),
    [collection?.childJobIds]
  );

  const canCreate = useMemo(
    () => !createdJobIds.size || collection?.childJobIds.length !== collection?.crawlResult.items.length,
    [createdJobIds.size, collection]
  );

  const toggleItem = (awemeId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(awemeId)) {
        next.delete(awemeId);
      } else {
        next.add(awemeId);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (!collection) return;
    const uncreated = collection.crawlResult.items.filter(
      (_, idx) => !createdJobIds.has(`${collection.id}-${idx}`)
    );
    const allSelected = uncreated.every(
      (item) => selectedIds.has(item.awemeId)
    );

    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(
        new Set(uncreated.map((item) => item.awemeId))
      );
    }
  };

  const handleCreateJobs = async () => {
    if (!collection || selectedIds.size === 0) return;

    setCreatingJobs(true);
    setError('');
    try {
      await apiClient.createCollectionJobs(
        collection.id,
        Array.from(selectedIds)
      );
      setSelectedIds(new Set());
      await refresh();
    } catch (err: any) {
      setError(err.response?.data?.message || '创建子任务失败');
    } finally {
      setCreatingJobs(false);
    }
  };

  const handleBatchStep = async (step: PipelineStep) => {
    if (!collection) return;

    setRunningStep(step);
    setError('');
    setBatchResults(null);
    try {
      const result = await apiClient.batchRunCollectionStep(collection.id, step);
      setBatchResults(result.results);
      await refresh();
    } catch (err: any) {
      setError(err.response?.data?.message || '批量执行失败');
    } finally {
      setRunningStep(null);
    }
  };

  const getItemStatus = (item: DouyinVideoItem, index: number): 'created' | 'processing' | 'done' | 'failed' | 'pending' => {
    if (!collection) return 'pending';
    // 检查是否创建了子任务
    const jobId = collection.childJobIds[index];
    if (!jobId) return 'pending';

    const progress = collection.childJobProgress;
    const itemIndex = collection.crawlResult.items.findIndex((i) => i.awemeId === item.awemeId);
    if (itemIndex < 0 || itemIndex >= collection.childJobIds.length) return 'pending';

    // 由于我们无法直接获取每个 job 的详情，这里用索引近似判断
    // 实际状态通过 item-job 映射表来管理
    if (progress.rendered >= itemIndex + 1) return 'done';
    if (progress.failed > 0) return 'failed'; // 简化处理
    if (progress.transcribed < itemIndex + 1) return 'created';
    return 'processing';
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[420px]">
          <Loader2 className="mx-auto h-12 w-12 animate-spin text-tech-purple" />
        </div>
      </Layout>
    );
  }

  if (!collection) {
    return (
      <Layout>
        <div className="text-center py-20">
          <XCircle className="mx-auto h-12 w-12 text-red-400" />
          <p className="mt-4 text-tech-muted">合集未找到</p>
        </div>
      </Layout>
    );
  }

  const uncreatedCount = collection.crawlResult.items.filter(
    (_, idx) => !createdJobIds.has(`${collection.id}-${idx}`)
  ).length;

  return (
    <Layout>
      {/* 返回按钮 */}
      <button
        onClick={() => navigate('/collections')}
        className="mb-4 inline-flex items-center gap-2 text-sm text-tech-muted hover:text-tech-text transition-colors"
      >
        <ArrowLeft size={16} />
        返回合集列表
      </button>

      {/* 用户信息卡片 */}
      <div className="mb-6 rounded-lg border border-tech-border bg-tech-surface p-6">
        <div className="flex items-start gap-5">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-tech-purple to-tech-blue text-2xl font-bold text-white shrink-0">
            {collection.nickname?.charAt(0) || 'U'}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-tech-text">
              {collection.nickname || '未知用户'}
            </h1>
            <p className="mt-1 text-sm text-tech-muted">
              已采集 {collection.crawlResult.totalCollected} 个视频 ·
              已创建 {collection.childJobIds.length} 个子任务
            </p>
          </div>
        </div>

        {/* 进度概览 */}
        {collection.childJobIds.length > 0 && (
          <div className="mt-5 border-t border-tech-border pt-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatBadge label="已转录" value={collection.childJobProgress.transcribed} total={collection.childJobIds.length} icon={Mic} />
              <StatBadge label="已洗稿" value={collection.childJobProgress.cleaned} total={collection.childJobIds.length} icon={Sparkles} />
              <StatBadge label="已分镜" value={collection.childJobProgress.scripted} total={collection.childJobIds.length} icon={Wand2} />
              <StatBadge label="已生成视频" value={collection.childJobProgress.rendered} total={collection.childJobIds.length} icon={Video} />
            </div>
          </div>
        )}
      </div>

      {/* 批量操作按钮 */}
      {collection.childJobIds.length > 0 && (
        <div className="mb-5 rounded-lg border border-tech-border bg-tech-surface p-4">
          <h3 className="mb-3 text-sm font-semibold text-tech-text">批量操作</h3>
          <div className="mb-3">
            <CookieHint compact />
          </div>
          <div className="flex flex-wrap gap-2">
            {pipelineSteps.map((step) => (
              <button
                key={step.id}
                disabled={runningStep === step.id}
                onClick={() => handleBatchStep(step.id)}
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all ${
                  runningStep === step.id
                    ? 'bg-tech-bg text-tech-muted cursor-wait'
                    : 'bg-tech-purple text-white hover:bg-purple-700'
                } disabled:opacity-50`}
              >
                {runningStep === step.id ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <step.icon size={14} />
                )}
                {step.label}
              </button>
            ))}
          </div>
          {batchResults && (
            <div className="mt-3 text-xs text-tech-muted">
              完成：{batchResults.filter((r) => r.status === 'ok').length} 成功，
              {batchResults.filter((r) => r.status === 'error').length} 失败
            </div>
          )}
        </div>
      )}

      {/* 错误 */}
      {error && (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* 创建子任务区域 */}
      {uncreatedCount > 0 && (
        <div className="mb-5 rounded-lg border border-dashed border-tech-border bg-tech-surface p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-tech-text">
                还有 {uncreatedCount} 个视频未创建子任务
              </h3>
              <p className="text-sm text-tech-muted mt-1">
                勾选需要处理的视频，创建为独立任务。视频下载会尝试使用已配置的 Cookie 获取无水印版本。
              </p>
            </div>
            <button
              disabled={selectedIds.size === 0 || creatingJobs}
              onClick={handleCreateJobs}
              className="inline-flex items-center gap-2 rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white hover:bg-tech-blue-dark disabled:opacity-50"
            >
              {creatingJobs ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              创建 {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
            </button>
          </div>
          {selectedIds.size > 0 && (
            <div className="mt-2 text-xs text-tech-muted">
              已选择 {selectedIds.size} 个视频
            </div>
          )}
        </div>
      )}

      {/* 视频列表 */}
      <div className="rounded-lg border border-tech-border bg-tech-surface overflow-hidden">
        <div className="flex items-center justify-between border-b border-tech-border bg-tech-bg px-4 py-3">
          <span className="text-sm font-medium text-tech-text">
            视频列表 ({collection.crawlResult.items.length})
          </span>
          <button
            onClick={toggleAll}
            className="text-xs text-tech-purple hover:underline"
          >
            {selectedIds.size > 0 ? '取消全选' : '全选未创建'}
          </button>
        </div>
        <div className="divide-y divide-tech-border max-h-[600px] overflow-y-auto">
          {collection.crawlResult.items.map((item, index) => {
            const hasJob = index < collection.childJobIds.length;
            const isSelected = selectedIds.has(item.awemeId);
            const progress = collection.childJobProgress;
            const jobId = collection.childJobIds[index];

            // 计算该项的状态
            let status: 'pending' | 'created' | 'transcribed' | 'cleaned' | 'scripted' | 'done' | 'failed' = 'pending';
            if (hasJob) {
              status = 'created';
              // 根据进度位置粗略推断
              if (progress.failed >= index + 1) status = 'failed';
              else if (progress.rendered >= index + 1) status = 'done';
              else if (progress.scripted >= index + 1) status = 'scripted';
              else if (progress.cleaned >= index + 1) status = 'cleaned';
              else if (progress.transcribed >= index + 1) status = 'transcribed';
            }

            return (
              <div
                key={item.awemeId}
                className={`flex items-center gap-4 px-4 py-3 transition-colors ${
                  isSelected ? 'bg-purple-50' : 'hover:bg-tech-bg'
                }`}
              >
                {/* 复选框 */}
                {!hasJob && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleItem(item.awemeId)}
                    className="h-4 w-4 rounded border-tech-border text-tech-purple focus:ring-tech-purple"
                  />
                )}
                {hasJob && (
                  <div className="w-4 flex justify-center">
                    <CheckCircle2 size={16} className="text-tech-muted" />
                  </div>
                )}

                {/* 封面 */}
                <div className="h-16 w-28 shrink-0 overflow-hidden rounded-md bg-tech-bg">
                  {item.coverUrl ? (
                    <img
                      src={item.coverUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <Video size={20} className="text-tech-muted" />
                    </div>
                  )}
                </div>

                {/* 描述 */}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium text-tech-text">
                    {item.desc || '(无描述)'}
                  </p>
                  <p className="mt-1 text-xs text-tech-muted">
                    {formatDuration(item.duration)} ·{' '}
                    {new Date(item.createTime * 1000).toLocaleDateString('zh-CN')}
                    {item.statistics.diggCount > 0 &&
                      ` · ❤️ ${formatCount(item.statistics.diggCount)}`}
                  </p>
                </div>

                {/* 状态 */}
                <div className="shrink-0">
                  {status === 'pending' && (
                    <span className="inline-flex items-center gap-1 text-xs text-tech-muted">
                      <Clock size={12} />
                      待创建
                    </span>
                  )}
                  {status === 'created' && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700">
                      <Clock size={12} />
                      待处理
                    </span>
                  )}
                  {status === 'transcribed' && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-cyan-50 px-2 py-1 text-xs text-cyan-700">
                      <Mic size={12} />
                      已转录
                    </span>
                  )}
                  {status === 'cleaned' && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-1 text-xs text-indigo-700">
                      <Sparkles size={12} />
                      已洗稿
                    </span>
                  )}
                  {status === 'scripted' && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 px-2 py-1 text-xs text-purple-700">
                      <Wand2 size={12} />
                      已分镜
                    </span>
                  )}
                  {status === 'done' && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
                      <CheckCircle2 size={12} />
                      已完成
                    </span>
                  )}
                  {status === 'failed' && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-1 text-xs text-red-700">
                      <XCircle size={12} />
                      失败
                    </span>
                  )}
                </div>

                {/* 打开详情 */}
                {hasJob && jobId && (
                  <button
                    onClick={() => navigate(`/jobs/${jobId}`)}
                    className="shrink-0 text-xs text-tech-blue hover:underline"
                  >
                    查看
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Layout>
  );
}

function StatBadge({
  label,
  value,
  total,
  icon: Icon,
}: {
  label: string;
  value: number;
  total: number;
  icon: React.ComponentType<{ size?: number }>;
}) {
  const done = value === total && total > 0;
  return (
    <div
      className={`flex items-center gap-2 rounded-lg p-3 text-sm ${
        done ? 'bg-emerald-50 text-emerald-700' : 'bg-tech-bg text-tech-muted'
      }`}
    >
      <Icon size={16} />
      <span>
        {label}: <strong>{value}</strong>/{total}
      </span>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}
