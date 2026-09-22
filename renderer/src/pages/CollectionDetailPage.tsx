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
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { CookieHint } from '../components/CookieHint';
import { apiClient } from '../services/api';
import type { CollectionOverview, DouyinVideoItem, Job, PipelineStep, CollectionTranscriptsResponse, GenerateSkillResponse } from '../types';
import { SkillViewModal } from '../features/skills/SkillViewModal';
import { displayNickname, formatDateFromSeconds, formatDuration, formatDurationWithLabel } from '../utils/display';

const pipelineSteps: Array<{
  id: PipelineStep;
  label: string;
  description: string;
  icon: typeof Video;
  /** 进度字段名：用来算「还剩多少个待处理」，进而把数量写进按钮 */
  progressKey: 'transcribed' | 'cleaned' | 'scripted' | 'rendered';
  /**
   * 相对代价。转录要下载+抽音+本地推理，洗稿是单次 AI 调用，分镜是单次 AI 调用，
   * 「生成视频」是逐条本地渲染、可能数小时 —— 三者不该长得一模一样。
   */
  cost: 'medium' | 'low' | 'heavy';
}> = [
  { id: 'transcribe', label: '批量转录', description: '对尚未转录的子任务执行视频转录', icon: Mic, progressKey: 'transcribed', cost: 'medium' },
  { id: 'clean', label: '批量洗稿', description: '对已转录、未洗稿的子任务执行 AI 洗稿', icon: Sparkles, progressKey: 'cleaned', cost: 'low' },
  { id: 'generate_video_prompts', label: '批量分镜', description: '对已洗稿、未分镜的子任务生成分镜', icon: Wand2, progressKey: 'scripted', cost: 'low' },
  { id: 'generate_video', label: '批量生成视频', description: '对已分镜、未出片的子任务本地渲染，耗时最长', icon: Video, progressKey: 'rendered', cost: 'heavy' },
];

export function CollectionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [collection, setCollection] = useState<CollectionOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [creatingJobs, setCreatingJobs] = useState(false);
  const [runningStep, setRunningStep] = useState<string | null>(null);
  /**
   * 批次的开始时间与已用秒数。
   *
   * 批量接口是后端**串行**跑完全部子任务才响应（客户端已关掉超时，见 api.ts），
   * 100 条视频的转录轻易几十分钟 —— 界面必须让人看到「它活着」，
   * 否则用户面对一个静止的转圈会以为卡死，进而重复触发。
   */
  const [batchStartedAt, setBatchStartedAt] = useState<number | null>(null);
  const [batchElapsed, setBatchElapsed] = useState(0);

  useEffect(() => {
    if (batchStartedAt === null) { setBatchElapsed(0); return; }
    const timer = setInterval(() => setBatchElapsed(Math.floor((Date.now() - batchStartedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [batchStartedAt]);
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
  // Per-item job state map (awemeId → job snapshot)
  const [itemStates, setItemStates] = useState<Record<string, {
    jobId: string;
    status: string;
    stage: string;
    error?: string;
  } | null> | null>(null);
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

  // 加载每个视频项的任务状态
  useEffect(() => {
    if (!id || !collection) return;
    let active = true;
    const loadItemStates = async () => {
      try {
        const states = await apiClient.getCollectionItemStates(id);
        if (active) setItemStates(states);
      } catch {
        // 静默失败，回退到进度摘要
        if (active) setItemStates(null);
      }
    };
    loadItemStates();
    return () => { active = false; };
  }, [id, collection?.childJobIds.length]);

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
      (item) => !collection.childJobMap?.[item.awemeId]
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
    setBatchStartedAt(Date.now());
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
      setBatchStartedAt(null);
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

  const getItemStatus = (item: DouyinVideoItem): 'created' | 'processing' | 'done' | 'failed' | 'pending' | 'unknown' => {
    if (!collection) return 'pending';
    const jobId = collection.childJobMap?.[item.awemeId];
    if (!jobId) return 'pending';

    if (itemStates?.[item.awemeId]) {
      const s = itemStates[item.awemeId]!;
      if (s.status === 'done' || s.stage === 'rendered') return 'done';
      if (s.status === 'failed' || s.stage === 'failed') return 'failed';
      if (s.status === 'processing' || s.status === 'queued') return 'processing';
      return 'created';
    }

    // itemStates 加载失败，无法确定精确状态
    return 'unknown';
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[420px]">
          <Loader2 className="mx-auto h-12 w-12 animate-spin text-ai" />
        </div>
      </Layout>
    );
  }

  if (!collection) {
    return (
      <Layout>
        <div className="text-center py-20">
          <XCircle className="mx-auto h-12 w-12 text-danger" />
          <p className="mt-4 text-ink-muted">合集未找到</p>
        </div>
      </Layout>
    );
  }

  const uncreatedCount = collection.crawlResult.items.filter(
    (item) => !collection.childJobMap?.[item.awemeId]
  ).length;

  return (
    <Layout>
      {/* 返回按钮 */}
      <button
        onClick={() => navigate('/collections')}
        className="mb-4 inline-flex items-center gap-2 text-sm text-ink-muted hover:text-ink transition-colors"
      >
        <ArrowLeft size={16} />
        返回合集列表
      </button>

      {/* 用户信息卡片 */}
      <div className="mb-6 rounded-lg border border-line bg-panel p-6">
        <div className="flex items-start gap-5">
          {collection.avatarUrl ? (
            <img
              src={collection.avatarUrl}
              alt={displayNickname(collection.nickname)}
              className="h-16 w-16 shrink-0 rounded-full object-cover ring-2 ring-line"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
                (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
              }}
            />
          ) : null}
          <div className={`flex h-16 w-16 items-center justify-center rounded-full border border-line bg-canvas text-2xl font-bold text-ink-muted shrink-0 ${collection.avatarUrl ? 'hidden' : ''}`}>
            {displayNickname(collection.nickname).charAt(0)}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-ink">
              {displayNickname(collection.nickname)}
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              已采集 {collection.crawlResult.totalCollected} 个视频 ·
              已创建 {collection.childJobIds.length} 个子任务
            </p>
          </div>
          {/* 更新按钮 */}
          <div className="shrink-0">
            <button
              onClick={handleUpdate}
              disabled={updating}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-elevated transition-colors disabled:opacity-50"
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
              <p className={`mt-1 text-xs ${updateResult.newItemsCount > 0 ? 'text-success' : 'text-ink-muted'}`}>
                {updateResult.message}
              </p>
            )}
          </div>
        </div>

        {/* 进度概览 */}
        {collection.childJobIds.length > 0 && (
          <div className="mt-5 border-t border-line pt-4">
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
        <div className="mb-5 rounded-lg border border-line bg-panel p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">批量操作</h3>
          <div className="mb-3">
            <CookieHint compact />
          </div>
          {/*
            改造前这里有三处问题（审查 M8/M9）：
            ① `disabled={runningStep === step.id}` —— **只禁用被点的那个**，其余仍可点，
               于是能同时发起两个长请求，而 `runningStep` 只有一个值、状态会张冠李戴；
            ② 按钮上**没有数量**，用户看不出「批量生成视频」会对多少个任务发起渲染；
            ③ 四个按钮都是实心同色，转录（下载+本地推理）与生成视频（逐条渲染、可能数小时）
               在视觉上毫无区别，点下去之前无从判断代价。
            现在：全部互斥、按钮带「待处理数量」、代价最高的那条单独用警示描边。
          */}
          <div className="flex flex-wrap gap-2">
            {/*
              待处理数 = 子任务总数 − 该步已完成数。
              为 0 说明这一步没有可做的了（例如 61 条全部已转录），此时按钮禁用 ——
              但**必须把原因写在界面上**：disabled 按钮不可聚焦，键盘与读屏都读不到 title。
              改造前这里是「四个按钮全都可点、且不带数量」，用户看不出会对多少条发起操作。
            */}
            {pipelineSteps.map((step) => {
              const pending = Math.max(0, collection.childJobIds.length - collection.childJobProgress[step.progressKey]);
              const isRunning = runningStep === step.id;
              const anyRunning = runningStep !== null;
              const variant = step.cost === 'heavy' ? 'heavy' : step.cost === 'medium' ? 'outline' : 'accent';
              return (
                <Button
                  key={step.id}
                  variant={isRunning ? 'ghost' : variant}
                  disabled={anyRunning || pending === 0}
                  title={pending === 0 ? '这一步已经没有待处理的任务了' : step.description}
                  onClick={() => handleBatchStep(step.id)}
                >
                  {isRunning ? (
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <step.icon size={14} aria-hidden="true" />
                  )}
                  {step.label}
                  {pending > 0 && <span className="tabular opacity-80">({pending})</span>}
                </Button>
              );
            })}
          </div>
          {(() => {
            const blocked = pipelineSteps
              .filter((step) => collection.childJobIds.length - collection.childJobProgress[step.progressKey] <= 0)
              .map((step) => step.label);
            if (blocked.length === 0 || runningStep) return null;
            return (
              <p className="mt-2 text-xs text-ink-muted">
                {blocked.join('、')}：已经没有待处理的任务，所以不可点。
              </p>
            );
          })()}
          {runningStep && (
            <p className="mt-3 flex items-center gap-2 text-xs text-ink-muted" role="status">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              正在执行 {pipelineSteps.find((s) => s.id === runningStep)?.label ?? '批量任务'} ·
              已用 {formatElapsed(batchElapsed)}。后端是逐条串行执行的，长合集可能几十分钟；
              期间请勿重复点击，完成后会自动刷新进度。
            </p>
          )}
          {batchResults && (
            <div className="mt-3 text-xs text-ink-muted">
              完成：{batchResults.filter((r) => r.status === 'ok').length} 成功，
              {batchResults.filter((r) => r.status === 'error').length} 失败
            </div>
          )}
          {/*
            这一组与上面的批量流水线动作是**两类事**：上面是「对全部子任务跑某一步」，
            这里是「看全部转录 / 蒸馏 Skill / 自动更新开关」。改造前它们同处一个
            标题为「批量操作」的盒子里，把设置开关和 Skill 信息也算成了「批量操作」。
            现在单独起一小标题，各归其位。
          */}
          {collection.childJobProgress.transcribed > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-2 text-xs font-medium text-ink-muted">内容与 Skill</p>
              <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="success"
                disabled={loadingTranscripts}
                onClick={handleViewTranscripts}
              >
                {loadingTranscripts ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <FileText size={14} aria-hidden="true" />
                )}
                查看全部转录（{collection.childJobProgress.transcribed}）
              </Button>

              {/* 生成 Skill 按钮 */}
              <Button variant="ai" onClick={openSkillModal}>
                <Brain size={14} aria-hidden="true" />
                生成 Skill
                {collection.skillName && (
                  <span className="text-xs opacity-80">（更新）</span>
                )}
              </Button>

              {/* 自动同步开关 */}
              <label className="inline-flex items-center gap-2 text-sm text-ink-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={collection.autoSyncSkill || false}
                  onChange={(e) => handleToggleAutoSync(e.target.checked)}
                  className="h-4 w-4 rounded border-line text-ai focus:ring-ai"
                />
                转录后自动更新
              </label>
              </div>
            </div>
          )}

          {/* Skill 生成状态指示 */}
          {collection.skillName && !collection.childJobProgress.transcribed && (
            <div className="mt-3 border-t border-line pt-3 flex items-center gap-3 text-xs text-ink-muted">
              <Brain size={14} className="text-ai" />
              已生成 Skill「{collection.skillName}」
              {collection.skillGeneratedAt && (
                <span>· {new Date(collection.skillGeneratedAt).toLocaleString('zh-CN')}</span>
              )}
              <button
                onClick={handleViewSkill}
                className="text-accent hover:underline"
              >
                查看
              </button>
              <span className="text-ink-muted">·</span>
              <button
                onClick={openSkillModal}
                className="text-accent hover:underline"
              >
                重新生成
              </button>
            </div>
          )}

          {/* Skill 状态指示（有转录同时也有 Skill 时） */}
          {collection.skillName && collection.childJobProgress.transcribed > 0 && (
            <div className="mt-3 border-t border-line pt-3 flex items-center gap-3 text-xs text-ink-muted">
              <Brain size={14} className="text-ai" />
              已有 Skill「{collection.skillName}」
              <button
                onClick={handleViewSkill}
                className="text-accent hover:underline"
              >
                查看
              </button>
            </div>
          )}
        </div>
      )}

      {/* 错误 */}
      {error && (
        <div className="mb-5 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {/* 创建子任务区域 */}
      {uncreatedCount > 0 && (
        <div className="mb-5 rounded-lg border border-dashed border-line bg-panel p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-ink">
                还有 {uncreatedCount} 个视频未创建子任务
              </h3>
              <p className="text-sm text-ink-muted mt-1">
                勾选需要处理的视频，创建为独立任务。视频下载会尝试使用已配置的 Cookie 获取无水印版本。
              </p>
            </div>
            <button
              disabled={selectedIds.size === 0 || creatingJobs}
              onClick={handleCreateJobs}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
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
            <div className="mt-2 text-xs text-ink-muted">
              已选择 {selectedIds.size} 个视频
            </div>
          )}
        </div>
      )}

      {/* 视频列表 */}
      <div className="rounded-lg border border-line bg-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-line bg-canvas px-4 py-3">
          <span className="text-sm font-medium text-ink">
            视频列表 ({collection.crawlResult.items.length})
          </span>
          <button
            onClick={toggleAll}
            className="text-xs text-ai hover:underline"
          >
            {selectedIds.size > 0 ? '取消全选' : '全选未创建'}
          </button>
        </div>
        <div className="divide-y divide-line max-h-[600px] overflow-y-auto">
          {[...collection.crawlResult.items]
            .sort((a, b) => b.createTime - a.createTime)
            .map((item) => {
            const jobId = collection.childJobMap?.[item.awemeId];
            const hasJob = Boolean(jobId);
            const isSelected = selectedIds.has(item.awemeId);
            const status = getItemStatus(item);

            return (
              <div
                key={item.awemeId}
                className={`flex items-center gap-4 px-4 py-3 transition-colors ${
                  isSelected ? 'bg-ai-soft' : 'hover:bg-elevated'
                }`}
              >
                {/* 复选框 */}
                {!hasJob && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleItem(item.awemeId)}
                    className="h-4 w-4 rounded border-line text-ai focus:ring-ai"
                  />
                )}
                {hasJob && (
                  <div className="w-4 flex justify-center">
                    <CheckCircle2 size={16} className="text-ink-muted" />
                  </div>
                )}

                {/* 封面 */}
                <div className="h-16 w-28 shrink-0 overflow-hidden rounded-md bg-canvas relative">
                  {/* fallback icon — always there, behind the image */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Video size={20} className="text-ink-muted" />
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
                  <p className="line-clamp-2 text-sm font-medium text-ink">
                    {item.desc || '(无描述)'}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {formatDuration(item.duration)} ·{' '}
                    {formatDateFromSeconds(item.createTime)}
                    {item.statistics.diggCount > 0 &&
                      ` · 赞 ${formatCount(item.statistics.diggCount)}`}
                  </p>
                </div>

                {/* 状态 */}
                <div className="shrink-0">
                  {status === 'pending' && (
                    <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                      <Clock size={12} />
                      待创建
                    </span>
                  )}
                  {status === 'unknown' && (
                    <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                      <Clock size={12} />
                      状态同步失败
                    </span>
                  )}
                  {status === 'processing' && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-info-soft px-2 py-1 text-xs text-info">
                      <RefreshCw size={12} className="animate-spin" />
                      处理中
                    </span>
                  )}
                  {status === 'created' && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-info-soft px-2 py-1 text-xs text-info">
                      <Clock size={12} />
                      待处理
                    </span>
                  )}
                  {status === 'done' && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-1 text-xs text-success">
                      <CheckCircle2 size={12} />
                      已完成
                    </span>
                  )}
                  {status === 'failed' && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-1 text-xs text-danger">
                      <XCircle size={12} />
                      失败
                    </span>
                  )}
                </div>

                {/* 打开详情 */}
                {hasJob && jobId && (
                  <button
                    onClick={() => navigate(`/jobs/${jobId}`)}
                    className="shrink-0 text-xs text-accent hover:underline"
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
        done ? 'bg-success-soft text-success' : 'bg-canvas text-ink-muted'
      }`}
    >
      <Icon size={16} />
      <span>
        {label}: <strong>{value}</strong>/{total}
      </span>
    </div>
  );
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
    <Modal open onClose={onClose} size="xl" ariaLabel="全部转录文本" bodyClassName="p-0" hideClose>
      <div className="flex h-[90vh] w-full flex-col">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-ink truncate">
              {displayNickname(data.collection.nickname)} · 全部转录文本
            </h2>
            <p className="text-xs text-ink-muted mt-0.5">
              {data.summary.transcribed}/{data.summary.totalJobs} 个视频已转录
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-elevated transition-colors"
            >
              {copied ? <CheckCircle2 size={16} className="text-success" /> : <Copy size={16} />}
              {copied ? '已复制' : '复制全部文本'}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-ink-muted hover:bg-elevated hover:text-ink transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* View switcher */}
        <div className="flex shrink-0 gap-1 border-b border-line bg-canvas px-6 py-2">
          <button
            onClick={() => setView('merged')}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              view === 'merged'
                ? 'bg-panel text-ink shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            聚合全文
          </button>
          <button
            onClick={() => setView('list')}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              view === 'list'
                ? 'bg-panel text-ink shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            按视频查看
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {view === 'merged' ? (
            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-ink">
              {data.aggregatedText || '(暂无转录文本)'}
            </pre>
          ) : (
            <div className="space-y-3">
              {data.transcripts.map((item, idx) => (
                <div
                  key={item.jobId}
                  className="rounded-lg border border-line overflow-hidden"
                >
                  <button
                    onClick={() => setExpandedIndex(expandedIndex === idx ? null : idx)}
                    className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-elevated transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink truncate pr-2">
                        {item.desc}
                      </p>
                      {item.duration != null && (
                        <p className="text-xs text-ink-muted mt-0.5">
                          {formatDurationWithLabel(item.duration)}
                          {item.segments?.length ? ` · ${item.segments.length} 个分段` : ''}
                        </p>
                      )}
                    </div>
                    <span className={`text-ink-muted transition-transform shrink-0 ${expandedIndex === idx ? 'rotate-180' : ''}`}>
                      ▼
                    </span>
                  </button>
                  {expandedIndex === idx && (
                    <div className="border-t border-line bg-canvas px-4 py-3">
                      <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-ink">
                        {item.transcript}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
              {data.transcripts.length === 0 && (
                <p className="text-center text-ink-muted py-8">暂无转录文本</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}


// ─── Small planned-item badge used in progress panel ─────────────

/** 把秒数写成「X 分 Y 秒 / Y 秒」。 */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

function PlannedItem({ label, active, icon }: { label: string; active: boolean; icon: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${active ? 'text-ink' : 'text-ink-muted line-through'}`}>
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
    <Modal
      open
      onClose={onClose}
      size="md"
      ariaLabel={existingSkill ? '更新 Skill' : '生成 Skill'}
      bodyClassName="p-0"
      hideClose
      busy={generating}
    >
        {/* Header —— sticky：内容区现在可滚动（Modal 给的是 max-h-[90vh] + overflow-y-auto），
            头部与底部操作条钉住，避免长内容把「生成」按钮顶出视口（改造前根本没有滚动，
            小窗口下底部按钮点不到）。 */}
        <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-line bg-panel px-6 py-4">
          <div className="flex items-center gap-2">
            <Brain size={20} className="text-ai" />
            <h2 className="text-lg font-semibold text-ink">
              {existingSkill ? '更新 Skill' : '生成 Skill'}
            </h2>
            {existingSkill && (
              <span className="text-xs text-ink-muted">
                （{existingSkill}）
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-ink-muted hover:bg-elevated hover:text-ink transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="shrink-0 px-6 py-4 space-y-4">
          {/* 信息提示 */}
          {!generating && !result && (
            <div className="rounded-lg border border-line bg-canvas p-3 text-xs text-ink-muted">
              <p>
                基于 <strong>{collection.childJobProgress.transcribed}</strong> 个已转录视频，通过<strong>逐视频提炼 + 汇总生成</strong>生成知识增强型 Claude Code Skill。
              </p>
              <p className="mt-1">
                阶段 1：逐个视频提炼 → 阶段 2：汇总分析 → 阶段 3：生成产物
              </p>
              <p className="mt-1">
                生成位置：<code className="text-ai">~/.claude/skills/douyin-{collection.id.slice(0, 8)}/</code>
              </p>
              {existingSkill && (
                <p className="mt-1 text-accent">
                  已有 Skill「{existingSkill}」将被更新。
                </p>
              )}
            </div>
          )}

          {/* 进度条 */}
          {(generating || progress?.stage === 'error') && progress && (
            <div className="rounded-lg border border-line bg-canvas p-4 space-y-3">
              {/* 阶段指示器 */}
              <div className="flex items-center gap-2 text-sm">
                {progress.stage === 'error' ? (
                  <XCircle size={16} className="text-danger" />
                ) : progress.stage === 'analyze' || progress.stage === 'planned' ? (
                  <Brain size={16} className="text-ai animate-pulse" />
                ) : progress.stage === 'done' ? (
                  <CheckCircle2 size={16} className="text-success" />
                ) : (
                  <Loader2 size={16} className="text-ai animate-spin" />
                )}
                <span className="text-ink font-medium">
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
                  <span className="text-xs text-ink-muted ml-auto">
                    {progress.current}/{progress.total}
                  </span>
                )}
              </div>

              {/* 进度条 */}
              <div className="w-full bg-line rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    progress.stage === 'error'
                      ? 'bg-danger'
                      : progress.stage === 'done'
                      ? 'bg-success'
                      : 'bg-gradient-to-r from-ai to-accent'
                  }`}
                  style={{ width: `${progress.progress}%` }}
                />
              </div>

              {/* 百分比 */}
              <div className="flex items-center justify-between text-xs text-ink-muted">
                <span className={progress.stage === 'error' ? 'text-danger' : ''}>
                  {progress.message}
                </span>
                <span>{progress.progress}%{generating && ` · 已用时 ${Math.floor(elapsedSeconds / 60)}分${elapsedSeconds % 60}秒`}</span>
              </div>

              {/* 阶段 1 分析结果 */}
              {progress.stage === 'planned' && progress.generates && (
                <div className="text-xs space-y-1 pt-1 border-t border-line">
                  <p className="font-medium text-ink mb-1">将生成以下产物：</p>
                  <div className="grid grid-cols-2 gap-1">
                    <PlannedItem label="增强 SKILL.md" active icon="·" />
                    {Object.entries(progress.generates).map(([key, val]) => (
                      <PlannedItem
                        key={key}
                        label={productLabelMap[key] || key}
                        active={!!val}
                        icon={val ? '✓' : '—'}
                      />
                    ))}
                    {progress.templates && progress.templates.length > 0 && (
                      <PlannedItem
                        label={`${progress.templates.length} 个模板`}
                        active
                        icon="·"
                      />
                    )}
                    <PlannedItem label="验收用例" active icon="·" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Focus prompt - 只在非进行中显示 */}
          {!generating && (
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">
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
                className="w-full rounded-lg border border-line-ui bg-well px-3 py-2 text-sm text-ink placeholder-ink-muted focus:border-ai-line focus:outline-none focus:ring-1 focus:ring-ai resize-none"
                disabled={generating}
              />
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="rounded-lg border border-success-line bg-success-soft px-4 py-3 space-y-2">
              <div className="flex items-center gap-2 text-success text-sm font-medium">
                <CheckCircle2 size={16} />
                Skill 生成成功
              </div>
              <p className="text-xs text-success">
                名称：<strong>{result.skillName}</strong>
                {result.skillType === "knowledge" && (
                  <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-ai-soft px-1.5 py-0.5 text-ai">
                    <Brain size={10} />
                    知识增强型
                  </span>
                )}
              </p>
              <p className="text-xs text-success truncate">
                路径：<code>{result.skillPath}</code>
              </p>
              {result.generated && result.generated.length > 0 && (
                <div className="text-xs text-success">
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
                className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                <Eye size={12} />
                查看 Skill 内容
              </button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 z-10 flex shrink-0 items-center justify-end gap-3 border-t border-line bg-panel px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-elevated transition-colors"
            disabled={generating}
          >
            {result ? '关闭' : '取消'}
          </button>
          <button
            onClick={onGenerate}
            disabled={generating || collection.childJobProgress.transcribed === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-ai px-4 py-2 text-sm font-medium text-on-accent hover:bg-ai transition-all disabled:opacity-50"
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
    </Modal>
  );
}
