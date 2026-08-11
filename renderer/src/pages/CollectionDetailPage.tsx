import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Brain,
  CheckCircle2,
  Clock,
  Copy,
  Eye,
  FileText,
  Loader2,
  Mic,
  Plus,
  RefreshCw,
  Sparkles,
  Users,
  Video,
  Wand2,
  X,
  XCircle,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { CookieHint } from '../components/CookieHint';
import { apiClient } from '../services/api';
import type { CollectionOverview, DouyinVideoItem, Job, PipelineStep, CollectionTranscriptsResponse, GenerateSkillResponse } from '../types';

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
  const [transcriptsData, setTranscriptsData] = useState<CollectionTranscriptsResponse | null>(null);
  const [loadingTranscripts, setLoadingTranscripts] = useState(false);
  // 合集更新状态
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<{ newItemsCount: number; message: string } | null>(null);
  // Skill generation state
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [skillFocusPrompt, setSkillFocusPrompt] = useState("");
  const [generatingSkill, setGeneratingSkill] = useState(false);
  const [skillResult, setSkillResult] = useState<GenerateSkillResponse | null>(null);
  const [skillError, setSkillError] = useState("");
  // Skill generation progress (streaming)
  const [skillProgress, setSkillProgress] = useState<{
    stage: string;
    message: string;
    progress: number;
    current?: number;
    total?: number;
    itemId?: string;
    itemLabel?: string;
    generates?: Record<string, boolean>;
    templates?: Array<{ name: string; topic: string }>;
    totalTasks?: number;
    error?: string;
  } | null>(null);
  const [skillElapsedSeconds, setSkillElapsedSeconds] = useState(0);
  // Skill content view state
  const [viewingSkill, setViewingSkill] = useState(false);
  const [skillContentData, setSkillContentData] = useState<{
    skillName: string;
    skillPath: string;
    skillMarkdown: string;
    sourceMarkdown: string;
    meta: any;
  } | null>(null);

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

  useEffect(() => {
    if (!generatingSkill) return;
    const startedAt = Date.now();
    setSkillElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setSkillElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [generatingSkill]);

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

  const handleUpdate = async () => {
    if (!collection) return;
    setUpdating(true);
    setError('');
    setUpdateResult(null);
    try {
      const result = await apiClient.updateCollection(collection.id);
      setUpdateResult(result);
      await refresh();
    } catch (err: any) {
      setError(err.response?.data?.message || '检查更新失败');
    } finally {
      setUpdating(false);
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

  const handleViewTranscripts = async () => {
    if (!collection) return;
    setLoadingTranscripts(true);
    setError('');
    try {
      const data = await apiClient.getCollectionTranscripts(collection.id);
      setTranscriptsData(data);
    } catch (err: any) {
      setError(err.response?.data?.message || '获取转录文本失败');
    } finally {
      setLoadingTranscripts(false);
    }
  };

  const handleGenerateSkill = async () => {
    if (!collection) return;
    setGeneratingSkill(true);
    setSkillError('');
    setSkillResult(null);
    setSkillProgress(null);
    setSkillElapsedSeconds(0);
    try {
      const result = await apiClient.generateSkill(
        collection.id,
        {
          focusPrompt: skillFocusPrompt.trim() || undefined,
          mode: collection.skillName ? 'update' : 'create',
        },
        (event) => {
          setSkillProgress({
            stage: event.stage || '',
            message: event.message || '',
            progress: Math.min(99, event.progress || 0),
            current: event.current,
            total: event.total,
            itemId: event.itemId,
            itemLabel: event.itemLabel,
            generates: event.generates,
            templates: event.templates,
            totalTasks: event.totalTasks,
            error: event.error,
          });
        }
      );
      setSkillResult(result);
      setSkillProgress({ stage: 'done', message: result.message, progress: 100 });
      await refresh();
    } catch (err: any) {
      const message = err.response?.data?.message || err.message || 'Skill 生成失败';
      setSkillError(message);
      setSkillProgress((previous) => ({
        stage: 'error',
        message,
        progress: 100,
        current: previous?.current,
        total: previous?.total,
      }));
    } finally {
      setGeneratingSkill(false);
    }
  };

  const handleToggleAutoSync = async (enabled: boolean) => {
    if (!collection) return;
    try {
      await apiClient.toggleAutoSyncSkill(collection.id, enabled);
      await refresh();
    } catch { /* ignore */ }
  };

  const openSkillModal = () => {
    setSkillFocusPrompt("");
    setSkillResult(null);
    setSkillError("");
    setSkillProgress(null);
    setSkillModalOpen(true);
  };

  const handleViewSkill = async () => {
    if (!collection) return;
    setViewingSkill(true);
    try {
      const data = await apiClient.getSkillContent(collection.id);
      setSkillContentData(data);
    } catch (err: any) {
      setError(err.response?.data?.message || '读取 Skill 失败');
    } finally {
      setViewingSkill(false);
    }
  };

  const handleCopyAllText = () => {
    if (transcriptsData?.aggregatedText) {
      navigator.clipboard.writeText(transcriptsData.aggregatedText);
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
          {collection.avatarUrl ? (
            <img
              src={collection.avatarUrl}
              alt={collection.nickname}
              className="h-16 w-16 shrink-0 rounded-full object-cover ring-2 ring-tech-border"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
                (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
              }}
            />
          ) : null}
          <div className={`flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-tech-purple to-tech-blue text-2xl font-bold text-white shrink-0 ${collection.avatarUrl ? 'hidden' : ''}`}>
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
          {/* 更新按钮 */}
          <div className="shrink-0">
            <button
              onClick={handleUpdate}
              disabled={updating}
              className="inline-flex items-center gap-2 rounded-lg border border-tech-border px-3 py-2 text-sm text-tech-text hover:bg-tech-bg transition-colors disabled:opacity-50"
              title="检查博主是否有新视频"
            >
              {updating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              {updating ? '检查中…' : '检查更新'}
            </button>
            {updateResult && (
              <p className={`mt-1 text-xs ${updateResult.newItemsCount > 0 ? 'text-emerald-600' : 'text-tech-muted'}`}>
                {updateResult.message}
              </p>
            )}
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
          {/* 查看全部转录按钮 */}
          {collection.childJobProgress.transcribed > 0 && (
            <div className="mt-3 border-t border-tech-border pt-3 flex flex-wrap items-center gap-3">
              <button
                disabled={loadingTranscripts}
                onClick={handleViewTranscripts}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 transition-all disabled:opacity-50"
              >
                {loadingTranscripts ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <FileText size={14} />
                )}
                查看全部转录（{collection.childJobProgress.transcribed}）
              </button>

              {/* 生成 Skill 按钮 */}
              <button
                onClick={openSkillModal}
                className="inline-flex items-center gap-2 rounded-lg bg-tech-purple px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 transition-all"
              >
                <Brain size={14} />
                生成 Skill
                {collection.skillName && (
                  <span className="text-xs opacity-80">（更新）</span>
                )}
              </button>

              {/* 自动同步开关 */}
              <label className="inline-flex items-center gap-2 text-sm text-tech-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={collection.autoSyncSkill || false}
                  onChange={(e) => handleToggleAutoSync(e.target.checked)}
                  className="h-4 w-4 rounded border-tech-border text-tech-purple focus:ring-tech-purple"
                />
                转录后自动更新
              </label>
            </div>
          )}

          {/* Skill 生成状态指示 */}
          {collection.skillName && !collection.childJobProgress.transcribed && (
            <div className="mt-3 border-t border-tech-border pt-3 flex items-center gap-3 text-xs text-tech-muted">
              <Brain size={14} className="text-tech-purple" />
              已生成 Skill「{collection.skillName}」
              {collection.skillGeneratedAt && (
                <span>· {new Date(collection.skillGeneratedAt).toLocaleString('zh-CN')}</span>
              )}
              <button
                onClick={handleViewSkill}
                className="text-tech-blue hover:underline"
              >
                查看
              </button>
              <span className="text-tech-muted">·</span>
              <button
                onClick={openSkillModal}
                className="text-tech-blue hover:underline"
              >
                重新生成
              </button>
            </div>
          )}

          {/* Skill 状态指示（有转录同时也有 Skill 时） */}
          {collection.skillName && collection.childJobProgress.transcribed > 0 && (
            <div className="mt-3 border-t border-tech-border pt-3 flex items-center gap-3 text-xs text-tech-muted">
              <Brain size={14} className="text-tech-purple" />
              已有 Skill「{collection.skillName}」
              <button
                onClick={handleViewSkill}
                className="text-tech-blue hover:underline"
              >
                查看
              </button>
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
          {[...collection.crawlResult.items]
            .sort((a, b) => b.createTime - a.createTime)
            .map((item, index) => {
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
                <div className="h-16 w-28 shrink-0 overflow-hidden rounded-md bg-tech-bg relative">
                  {/* fallback icon — always there, behind the image */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Video size={20} className="text-tech-muted" />
                  </div>
                  {item.coverUrl ? (
                    <img
                      src={item.coverUrl}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : null}
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

      {/* 转录文本查看 Modal */}
      {transcriptsData && (
        <TranscriptsModal
          data={transcriptsData}
          onCopy={handleCopyAllText}
          onClose={() => setTranscriptsData(null)}
        />
      )}

      {/* Skill 生成 Modal */}
      {skillModalOpen && (
        <SkillGenModal
          collection={collection}
          focusPrompt={skillFocusPrompt}
          onFocusPromptChange={setSkillFocusPrompt}
          generating={generatingSkill}
          result={skillResult}
          error={skillError}
          progress={skillProgress}
          elapsedSeconds={skillElapsedSeconds}
          onGenerate={handleGenerateSkill}
          onClose={() => setSkillModalOpen(false)}
          onViewSkill={handleViewSkill}
        />
      )}

      {/* Skill 内容查看 Modal */}
      {skillContentData && (
        <SkillViewModal
          data={skillContentData}
          loading={viewingSkill}
          onClose={() => setSkillContentData(null)}
        />
      )}
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

// ─── 转录文本查看 Modal ────────────────────────────────────────────

function TranscriptsModal({
  data,
  onCopy,
  onClose,
}: {
  data: CollectionTranscriptsResponse;
  onCopy: () => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<'merged' | 'list'>('merged');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[90vh] w-full max-w-4xl flex-col rounded-xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-tech-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-tech-text truncate">
              {data.collection.nickname} · 全部转录文本
            </h2>
            <p className="text-xs text-tech-muted mt-0.5">
              {data.summary.transcribed}/{data.summary.totalJobs} 个视频已转录
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-2 rounded-lg border border-tech-border px-3 py-2 text-sm font-medium text-tech-text hover:bg-tech-bg transition-colors"
            >
              {copied ? <CheckCircle2 size={16} className="text-emerald-500" /> : <Copy size={16} />}
              {copied ? '已复制' : '复制全部文本'}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-tech-muted hover:bg-tech-bg hover:text-tech-text transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* View switcher */}
        <div className="flex shrink-0 gap-1 border-b border-tech-border bg-tech-bg px-6 py-2">
          <button
            onClick={() => setView('merged')}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              view === 'merged'
                ? 'bg-white text-tech-text shadow-sm'
                : 'text-tech-muted hover:text-tech-text'
            }`}
          >
            聚合全文
          </button>
          <button
            onClick={() => setView('list')}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              view === 'list'
                ? 'bg-white text-tech-text shadow-sm'
                : 'text-tech-muted hover:text-tech-text'
            }`}
          >
            按视频查看
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {view === 'merged' ? (
            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-tech-text">
              {data.aggregatedText || '(暂无转录文本)'}
            </pre>
          ) : (
            <div className="space-y-3">
              {data.transcripts.map((item, idx) => (
                <div
                  key={item.jobId}
                  className="rounded-lg border border-tech-border overflow-hidden"
                >
                  <button
                    onClick={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
                    className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-tech-bg transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-tech-text truncate pr-2">
                        {item.desc}
                      </p>
                      {item.duration != null && (
                        <p className="text-xs text-tech-muted mt-0.5">
                          时长 {formatDuration(item.duration)}
                          {item.segments?.length ? ` · ${item.segments.length} 个分段` : ''}
                        </p>
                      )}
                    </div>
                    <span className={`text-tech-muted transition-transform shrink-0 ${expandedIndex === idx ? 'rotate-180' : ''}`}>
                      ▼
                    </span>
                  </button>
                  {expandedIndex === idx && (
                    <div className="border-t border-tech-border bg-tech-bg px-4 py-3">
                      <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-tech-text">
                        {item.transcript}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
              {data.transcripts.length === 0 && (
                <p className="text-center text-tech-muted py-8">暂无转录文本</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ─── Small planned-item badge used in progress panel ─────────────

function PlannedItem({ label, active, icon }: { label: string; active: boolean; icon: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${active ? 'text-tech-text' : 'text-tech-muted line-through'}`}>
      <span>{icon}</span>
      <span className="truncate">{label}</span>
    </span>
  );
}

// ─── Skill 生成 Modal ────────────────────────────────────────────────

function SkillGenModal({
  collection,
  focusPrompt,
  onFocusPromptChange,
  generating,
  result,
  error,
  progress,
  elapsedSeconds,
  onGenerate,
  onClose,
  onViewSkill,
}: {
  collection: CollectionOverview;
  focusPrompt: string;
  onFocusPromptChange: (v: string) => void;
  generating: boolean;
  result: GenerateSkillResponse | null;
  error: string;
  progress: {
    stage: string;
    message: string;
    progress: number;
    current?: number;
    total?: number;
    itemId?: string;
    itemLabel?: string;
    generates?: Record<string, boolean>;
    templates?: Array<{ name: string; topic: string }>;
    totalTasks?: number;
    error?: string;
  } | null;
  elapsedSeconds: number;
  onGenerate: () => void;
  onClose: () => void;
  onViewSkill: () => void;
}) {
  const existingSkill = collection.skillName;

  // Progress phase labels
  const productLabelMap: Record<string, string> = {
    enhanced_skill_md: "增强 SKILL.md",
    knowledge_base: "结构化知识库",
    case_library: "案例库",
    quotes_collection: "金句合集",
    checklist: "执行检查清单",
    decision_framework: "决策框架",
    eval_cases: "验收用例",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex w-full max-w-lg flex-col rounded-xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-tech-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Brain size={20} className="text-tech-purple" />
            <h2 className="text-lg font-semibold text-tech-text">
              {existingSkill ? '更新 Skill' : '生成 Skill'}
            </h2>
            {existingSkill && (
              <span className="text-xs text-tech-muted">
                （{existingSkill}）
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-tech-muted hover:bg-tech-bg hover:text-tech-text transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="shrink-0 px-6 py-4 space-y-4">
          {/* 信息提示 */}
          {!generating && !result && (
            <div className="rounded-lg border border-tech-border bg-tech-bg p-3 text-xs text-tech-muted">
              <p>
                基于 <strong>{collection.childJobProgress.transcribed}</strong> 个已转录视频，通过<strong>逐视频提炼 + 汇总生成</strong>生成知识增强型 Claude Code Skill。
              </p>
              <p className="mt-1">
                阶段 1：逐个视频提炼 → 阶段 2：汇总分析 → 阶段 3：生成产物
              </p>
              <p className="mt-1">
                生成位置：<code className="text-tech-purple">~/.claude/skills/douyin-{collection.id.slice(0, 8)}/</code>
              </p>
              {existingSkill && (
                <p className="mt-1 text-tech-blue">
                  已有 Skill「{existingSkill}」将被更新。
                </p>
              )}
            </div>
          )}

          {/* 进度条 */}
          {(generating || progress?.stage === 'error') && progress && (
            <div className="rounded-lg border border-tech-border bg-tech-bg p-4 space-y-3">
              {/* 阶段指示器 */}
              <div className="flex items-center gap-2 text-sm">
                {progress.stage === 'error' ? (
                  <XCircle size={16} className="text-red-500" />
                ) : progress.stage === 'analyze' || progress.stage === 'planned' ? (
                  <Brain size={16} className="text-tech-purple animate-pulse" />
                ) : progress.stage === 'done' ? (
                  <CheckCircle2 size={16} className="text-emerald-500" />
                ) : (
                  <Loader2 size={16} className="text-tech-purple animate-spin" />
                )}
                <span className="text-tech-text font-medium">
                  {progress.stage === 'collecting' && '准备阶段：读取转录内容'}
                  {progress.stage === 'extracting' && '阶段 1/3：逐个提炼视频'}
                  {progress.stage === 'extracting_item' && `阶段 1/3：提炼第 ${progress.current ?? ''}/${progress.total ?? ''} 个视频`}
                  {progress.stage === 'retrying' && '正在重试当前 AI 请求'}
                  {progress.stage === 'analyze' && '阶段 2/3：汇总提炼结果'}
                  {progress.stage === 'planned' && '阶段 2/3：分析完成'}
                  {progress.stage === 'generating' && '阶段 3/3：生成 Skill 产物'}
                  {progress.stage === 'generating_item' && `阶段 3/3：${progress.itemLabel || '生成中…'}`}
                  {progress.stage === 'item_done' && `阶段 3/3：${progress.itemLabel || ''} ✓`}
                  {progress.stage === 'item_failed' && `阶段 3/3：${progress.itemLabel || ''} ✗`}
                  {progress.stage === 'done' && '生成完成'}
                  {progress.stage === 'error' && '生成失败'}
                  {!progress.stage && '准备中…'}
                </span>
                {progress.total != null && progress.current != null && (
                  <span className="text-xs text-tech-muted ml-auto">
                    {progress.current}/{progress.total}
                  </span>
                )}
              </div>

              {/* 进度条 */}
              <div className="w-full bg-tech-border rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    progress.stage === 'error'
                      ? 'bg-red-500'
                      : progress.stage === 'done'
                      ? 'bg-emerald-500'
                      : 'bg-gradient-to-r from-tech-purple to-tech-blue'
                  }`}
                  style={{ width: `${progress.progress}%` }}
                />
              </div>

              {/* 百分比 */}
              <div className="flex items-center justify-between text-xs text-tech-muted">
                <span className={progress.stage === 'error' ? 'text-red-600' : ''}>
                  {progress.message}
                </span>
                <span>{progress.progress}%{generating && ` · 已用时 ${Math.floor(elapsedSeconds / 60)}分${elapsedSeconds % 60}秒`}</span>
              </div>

              {/* 阶段 1 分析结果 */}
              {progress.stage === 'planned' && progress.generates && (
                <div className="text-xs space-y-1 pt-1 border-t border-tech-border">
                  <p className="font-medium text-tech-text mb-1">将生成以下产物：</p>
                  <div className="grid grid-cols-2 gap-1">
                    <PlannedItem label="增强 SKILL.md" active icon="📄" />
                    {Object.entries(progress.generates).map(([key, val]) => (
                      <PlannedItem
                        key={key}
                        label={productLabelMap[key] || key}
                        active={!!val}
                        icon={val ? '✅' : '⏭️'}
                      />
                    ))}
                    {progress.templates && progress.templates.length > 0 && (
                      <PlannedItem
                        label={`${progress.templates.length} 个模板`}
                        active
                        icon="📋"
                      />
                    )}
                    <PlannedItem label="验收用例" active icon="🧪" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Focus prompt - 只在非进行中显示 */}
          {!generating && (
            <div>
              <label className="block text-sm font-medium text-tech-text mb-1.5">
                聚焦方向（可选）
              </label>
              <textarea
                value={focusPrompt}
                onChange={(e) => onFocusPromptChange(e.target.value)}
                placeholder={
                  '留空则全面提取所有可复用知识。\n' +
                  '例如：「只提取关于人物冲突塑造的方法论，忽略其他内容」\n' +
                  '「聚焦世界观搭建和剧情节奏控制的框架」'
                }
                rows={4}
                className="w-full rounded-lg border border-tech-border bg-tech-bg px-3 py-2 text-sm text-tech-text placeholder-tech-muted focus:border-tech-purple focus:outline-none focus:ring-1 focus:ring-tech-purple resize-none"
                disabled={generating}
              />
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 space-y-2">
              <div className="flex items-center gap-2 text-emerald-700 text-sm font-medium">
                <CheckCircle2 size={16} />
                Skill 生成成功
              </div>
              <p className="text-xs text-emerald-600">
                名称：<strong>{result.skillName}</strong>
                {result.skillType === "knowledge" && (
                  <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-purple-100 px-1.5 py-0.5 text-purple-700">
                    <Brain size={10} />
                    知识增强型
                  </span>
                )}
              </p>
              <p className="text-xs text-emerald-600 truncate">
                路径：<code>{result.skillPath}</code>
              </p>
              {result.generated && result.generated.length > 0 && (
                <div className="text-xs text-emerald-600">
                  <p className="font-medium mb-1">已生成 {result.generated.length} 项产物：</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {result.generated.map((g: string, i: number) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </div>
              )}
              <button
                onClick={() => { onClose(); onViewSkill(); }}
                className="mt-2 inline-flex items-center gap-1 text-xs text-tech-blue hover:underline"
              >
                <Eye size={12} />
                查看 Skill 内容
              </button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-tech-border px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-tech-border px-4 py-2 text-sm font-medium text-tech-text hover:bg-tech-bg transition-colors"
            disabled={generating}
          >
            {result ? '关闭' : '取消'}
          </button>
          <button
            onClick={onGenerate}
            disabled={generating || collection.childJobProgress.transcribed === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-tech-purple px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 transition-all disabled:opacity-50"
          >
            {generating ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                生成中…
              </>
            ) : (
              <>
                <Brain size={14} />
                {existingSkill ? '更新 Skill' : '生成 Skill'}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Skill 内容查看 Modal ────────────────────────────────────────────

function SkillViewModal({
  data,
  loading,
  onClose,
}: {
  data: {
    skillName: string;
    skillPath: string;
    skillMarkdown: string;
    sourceMarkdown: string;
    meta: any;
    knowledgeBase?: string;
    caseLibrary?: string;
    quotesCollection?: string;
    checklist?: string;
    decisionFramework?: string;
    evalCases?: string;
    templates?: Array<{ name: string; content: string }>;
  };
  loading: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<string>('skill');
  const [copied, setCopied] = useState(false);

  const getCurrentContent = () => {
    switch (tab) {
      case 'skill': return data.skillMarkdown;
      case 'source': return data.sourceMarkdown;
      case 'knowledge_base': return data.knowledgeBase || '';
      case 'case_library': return data.caseLibrary || '';
      case 'quotes': return data.quotesCollection || '';
      case 'checklist': return data.checklist || '';
      case 'decision': return data.decisionFramework || '';
      case 'evals': return data.evalCases || '';
      case 'meta': return JSON.stringify(data.meta, null, 2);
      default:
        // 模板tab
        if (tab.startsWith('tpl_') && data.templates) {
          const tplName = tab.slice(4);
          return data.templates.find(t => t.name === tplName)?.content || '';
        }
        return '';
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(getCurrentContent());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="rounded-xl bg-white p-8 shadow-2xl flex items-center gap-3">
          <Loader2 size={24} className="animate-spin text-tech-purple" />
          <span className="text-tech-text">加载 Skill 内容…</span>
        </div>
      </div>
    );
  }

  const tabs = [
    { id: 'skill', label: 'SKILL.md' },
    ...(data.knowledgeBase ? [{ id: 'knowledge_base', label: '知识库' }] : []),
    ...(data.caseLibrary ? [{ id: 'case_library', label: '案例库' }] : []),
    ...(data.quotesCollection ? [{ id: 'quotes', label: '金句集' }] : []),
    ...(data.checklist ? [{ id: 'checklist', label: '检查清单' }] : []),
    ...(data.decisionFramework ? [{ id: 'decision', label: '决策框架' }] : []),
    ...(data.evalCases ? [{ id: 'evals', label: '验收用例' }] : []),
    ...(data.templates || []).map(t => ({ id: `tpl_${t.name}`, label: t.name })),
    { id: 'source', label: '原始来源' },
    { id: 'meta', label: '元信息' },
  ];

  const currentContent = getCurrentContent();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex h-[90vh] w-full max-w-4xl flex-col rounded-xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-tech-border px-6 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <Brain size={20} className="text-tech-purple shrink-0" />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-tech-text truncate">
                {data.skillName}
              </h2>
              <p className="text-xs text-tech-muted truncate mt-0.5">
                {data.skillPath}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-2 rounded-lg border border-tech-border px-3 py-2 text-sm font-medium text-tech-text hover:bg-tech-bg transition-colors"
            >
              {copied ? <CheckCircle2 size={16} className="text-emerald-500" /> : <Copy size={16} />}
              {copied ? '已复制' : '复制'}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-tech-muted hover:bg-tech-bg hover:text-tech-text transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 border-b border-tech-border bg-tech-bg px-6 py-2 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'bg-white text-tech-text shadow-sm'
                  : 'text-tech-muted hover:text-tech-text'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {tab === 'skill' || tab === 'knowledge_base' || tab === 'case_library' || tab === 'quotes' || tab === 'checklist' || tab === 'decision' || tab === 'evals' || tab.startsWith('tpl_') ? (
            <div className="p-6">
              <div className="prose prose-sm max-w-none">
                <RenderMarkdown content={currentContent} />
              </div>
            </div>
          ) : tab === 'source' ? (
            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-tech-text p-6">
              {data.sourceMarkdown || '(暂无原始来源)'}
            </pre>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-tech-text p-6">
              {JSON.stringify(data.meta, null, 2) || '(暂无元信息)'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function RenderMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeContent = '';
  let codeLang = '';

  const elements: React.ReactNode[] = [];

  const flushCodeBlock = () => {
    if (codeContent) {
      elements.push(
        <pre key={elements.length} className="rounded-lg bg-tech-bg border border-tech-border p-4 my-3 overflow-x-auto">
          <code className="text-sm font-mono">{codeContent.trim()}</code>
        </pre>
      );
      codeContent = '';
      codeLang = '';
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        codeLang = line.slice(3).trim();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent += (codeContent ? '\n' : '') + line;
      continue;
    }

    // Frontmatter detection
    if (i === 0 && line === '---') {
      let j = i + 1;
      while (j < lines.length && lines[j] !== '---') j++;
      if (j < lines.length) {
        const fmLines = lines.slice(i + 1, j);
        elements.push(
          <div key={elements.length} className="rounded-lg bg-tech-bg border border-tech-border p-3 my-3 font-mono text-sm text-tech-muted">
            {fmLines.map((fl, fi) => (
              <div key={fi}>{fl}</div>
            ))}
          </div>
        );
        i = j;
        continue;
      }
    }

    // Headings
    if (line.startsWith('### ')) {
      elements.push(<h3 key={elements.length} className="text-base font-semibold text-tech-text mt-5 mb-2">{line.slice(4)}</h3>);
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(<h2 key={elements.length} className="text-lg font-bold text-tech-text mt-6 mb-3 border-b border-tech-border pb-1">{line.slice(3)}</h2>);
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(<h1 key={elements.length} className="text-xl font-bold text-tech-text mt-6 mb-3">{line.slice(2)}</h1>);
      continue;
    }

    // Ordered list item
    const olMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (olMatch) {
      elements.push(
        <div key={elements.length} className="flex gap-2 text-sm text-tech-text ml-4 my-0.5">
          <span className="text-tech-muted min-w-[1.5em] text-right">{olMatch[1]}.</span>
          <span>{renderInline(olMatch[2])}</span>
        </div>
      );
      continue;
    }

    // Unordered list item
    if (/^[-*]\s+/.test(line)) {
      const text = line.replace(/^[-*]\s+/, '');
      elements.push(
        <div key={elements.length} className="flex gap-2 text-sm text-tech-text ml-4 my-0.5">
          <span className="text-tech-muted">•</span>
          <span>{renderInline(text)}</span>
        </div>
      );
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      elements.push(<div key={elements.length} className="h-2" />);
      continue;
    }

    // Bold text only
    if (/^\*\*.+\*\*$/.test(line.trim())) {
      elements.push(
        <p key={elements.length} className="text-sm font-semibold text-tech-text my-1">
          {line.trim().replace(/\*\*/g, '')}
        </p>
      );
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={elements.length} className="text-sm text-tech-text leading-relaxed my-1">
        {renderInline(line)}
      </p>
    );
  }

  flushCodeBlock();

  return <>{elements}</>;
}

function renderInline(text: string): React.ReactNode {
  // Bold
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    // Inline code
    const codeParts = part.split(/(`[^`]+`)/g);
    return codeParts.map((cp, j) => {
      if (cp.startsWith('`') && cp.endsWith('`')) {
        return <code key={j} className="bg-tech-bg px-1 py-0.5 rounded text-xs font-mono text-tech-purple">{cp.slice(1, -1)}</code>;
      }
      return cp;
    });
  });
}
