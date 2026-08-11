import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Grid3X3,
  LayoutList,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { CreateJobDialog } from '../components/CreateJobDialog';
import { ApiKeyWarning } from '../components/ApiKeyWarning';
import { useAppStore } from '../store';
import { apiClient } from '../services/api';
import { hasValidApiKey } from '../utils/apiKeyValidator';
import { useJobPolling } from '../hooks/useJobPolling';
import type { JobFilterStatus, JobOverview, ViewMode } from '../types';
import {
  getJobVisualState,
  filterJobOverviews,
  readStoredViewMode,
  writeStoredViewMode,
  formatDate,
} from '../features/jobs/jobPresentation';

const filterOptions: Array<{ id: JobFilterStatus; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'processing', label: '处理中' },
  { id: 'failed', label: '失败' },
  { id: 'done', label: '已完成' },
  { id: 'pending', label: '待执行' },
];

export function JobListPage() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [showApiWarning, setShowApiWarning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [overviews, setOverviews] = useState<JobOverview[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<JobFilterStatus>('all');
  const [viewMode, setViewMode] = useState<ViewMode>(() => readStoredViewMode(window.localStorage));
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const navigate = useNavigate();
  const setJobs = useAppStore((state) => state.setJobs);
  const serverPort = useAppStore((state) => state.serverPort);
  const setServerPort = useAppStore((state) => state.setServerPort);

  const { isPolling } = useJobPolling(true);

  const refreshOverviews = useCallback(async () => {
    const items = await apiClient.getJobOverviews();
    setOverviews(items);
    setJobs(items);
  }, [setJobs]);

  useEffect(() => {
    const init = async () => {
      try {
        if (typeof window !== 'undefined' && window.electron?.getServerPort) {
          const port = await window.electron.getServerPort();
          setServerPort(port);
        } else {
          setServerPort(5173); // 浏览器开发模式使用 Vite 代理端口
        }
        await apiClient.initialize();
        await refreshOverviews();
      } catch (error) {
        console.error('Failed to initialize:', error);
      } finally {
        setIsLoading(false);
      }
    };

    init();
  }, [setServerPort, refreshOverviews]);

  useEffect(() => {
    if (!isPolling || overviews.length === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      refreshOverviews().catch((error) => console.error('Failed to refresh overviews:', error));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [isPolling, overviews.length, refreshOverviews]);

  const filteredJobs = useMemo(() => {
    return filterJobOverviews(overviews, query, filter);
  }, [filter, overviews, query]);

  const handleJobClick = (jobId: string) => {
    navigate(`/jobs/${jobId}`);
  };

  const handleDeleteJob = async (jobId: string) => {
    setConfirmDeleteId(jobId);
  };

  const confirmDelete = async () => {
    if (!confirmDeleteId) return;
    const jobId = confirmDeleteId;
    try {
      setDeletingId(jobId);
      await apiClient.deleteJob(jobId);
      const next = overviews.filter((job) => job.id !== jobId);
      setOverviews(next);
      setJobs(next);
    } catch (error: any) {
      window.alert(error.response?.data?.message || '删除作品失败');
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  const handleCreateClick = async () => {
    const hasKey = await hasValidApiKey();
    if (!hasKey) {
      setShowApiWarning(true);
      return;
    }
    setIsDialogOpen(true);
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[420px]">
          <div className="text-center">
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-tech-blue border-t-transparent" />
            <p className="mt-4 text-tech-muted">正在载入作品列表...</p>
          </div>
        </div>
      </Layout>
    );
  }

  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    writeStoredViewMode(window.localStorage, mode);
  };

  return (
    <Layout>
      {/* Page header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-tech-text">最近作品</h2>
          <p className="mt-1 text-sm text-tech-muted">
            从视频链接开始，管理转录、洗稿、分镜和视频产出
          </p>
        </div>
        <button
          onClick={handleCreateClick}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-tech-blue px-5 py-2.5 text-sm font-medium text-white hover:bg-tech-blue-dark transition-colors disabled:opacity-50"
        >
          <Plus size={18} />
          创建作品
        </button>
      </div>

      {/* Toolbar */}
      <div className="mb-5 flex flex-col gap-3 rounded-lg border border-tech-border bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tech-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、来源或摘要"
            className="h-10 w-full rounded-lg border border-tech-border bg-white pl-10 pr-4 text-sm text-tech-text outline-none placeholder:text-tech-muted focus:border-tech-blue focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {filterOptions.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setFilter(item.id)}
                className={`h-8 rounded-lg px-3 text-xs font-medium transition-colors ${
                  filter === item.id
                    ? 'bg-tech-text text-white'
                    : 'bg-gray-100 text-tech-muted hover:bg-gray-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex h-8 shrink-0 rounded-lg border border-tech-border bg-gray-100 p-0.5">
            <button
              type="button"
              aria-label="列表视图"
              aria-pressed={viewMode === 'list'}
              onClick={() => changeViewMode('list')}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                viewMode === 'list' ? 'bg-white text-tech-blue shadow-sm' : 'text-tech-muted'
              }`}
            >
              <LayoutList size={15} />
            </button>
            <button
              type="button"
              aria-label="卡片视图"
              aria-pressed={viewMode === 'card'}
              onClick={() => changeViewMode('card')}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                viewMode === 'card' ? 'bg-white text-tech-blue shadow-sm' : 'text-tech-muted'
              }`}
            >
              <Grid3X3 size={15} />
            </button>
          </div>
          {isPolling && overviews.length > 0 && (
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-tech-muted">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              同步中
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      {overviews.length === 0 ? (
        <div className="rounded-lg border border-dashed border-tech-border bg-white px-6 py-20 text-center">
          <Sparkles size={36} className="mx-auto mb-4 text-tech-muted" />
          <h3 className="text-lg font-semibold text-tech-text">还没有作品</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-tech-muted">
            粘贴抖音链接或分享文本，生成转录、洗稿内容、分镜和本地成片。
          </p>
          <button
            onClick={handleCreateClick}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-tech-blue px-5 py-2.5 text-sm font-medium text-white hover:bg-tech-blue-dark"
          >
            <Plus size={16} />
            创建第一个作品
          </button>
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-tech-border bg-white py-16 text-center">
          <Search className="mx-auto mb-4 h-10 w-10 text-tech-muted" />
          <h3 className="text-lg font-semibold text-tech-text">没有匹配的作品</h3>
          <p className="mt-2 text-sm text-tech-muted">换个关键词或筛选条件再试试。</p>
        </div>
      ) : viewMode === 'list' ? (
        <JobOverviewTable
          jobs={filteredJobs}
          deletingId={deletingId}
          onOpen={handleJobClick}
          onDelete={handleDeleteJob}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredJobs.map((job) => (
            <JobOverviewCard
              key={job.id}
              job={job}
              deleting={deletingId === job.id}
              onOpen={handleJobClick}
              onDelete={handleDeleteJob}
            />
          ))}
        </div>
      )}

      <CreateJobDialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
      />

      <ApiKeyWarning
        isOpen={showApiWarning}
        onClose={() => setShowApiWarning(false)}
      />

      {/* Confirm delete dialog */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setConfirmDeleteId(null)} />
          <div role="dialog" aria-modal="true" className="relative z-10 w-full max-w-sm rounded-xl bg-white p-6 shadow-lg">
            <h3 className="text-lg font-semibold text-tech-text">确定删除这个作品吗？</h3>
            <p className="mt-2 text-sm text-tech-muted">删除后会进入垃圾桶，30 天内可恢复。</p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                disabled={!!deletingId}
                className="rounded-lg border border-tech-border px-4 py-2 text-sm font-medium text-tech-text hover:bg-tech-bg disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={!!deletingId}
                className="rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white hover:bg-tech-blue-dark disabled:opacity-50"
              >
                {deletingId ? '删除中...' : '删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

function JobOverviewTable({
  jobs,
  deletingId,
  onOpen,
  onDelete,
}: {
  jobs: JobOverview[];
  deletingId: string | null;
  onOpen: (jobId: string) => void;
  onDelete: (jobId: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-tech-border bg-white">
      <div className="grid grid-cols-[minmax(240px,1.4fr)_minmax(130px,0.8fr)_minmax(110px,0.6fr)_minmax(150px,0.8fr)_96px] gap-3 border-b border-tech-border bg-gray-50 px-4 py-2.5 text-xs font-medium text-tech-muted max-lg:hidden">
        <span>作品</span>
        <span>更新时间</span>
        <span>状态</span>
        <span>下一步</span>
        <span className="text-right">操作</span>
      </div>
      <div className="divide-y divide-tech-border">
        {jobs.map((job) => (
          <div
            key={job.id}
            className="grid w-full grid-cols-1 gap-3 px-4 py-3.5 transition-colors hover:bg-gray-50 lg:grid-cols-[minmax(240px,1.4fr)_minmax(130px,0.8fr)_minmax(110px,0.6fr)_minmax(150px,0.8fr)_96px] lg:items-center"
          >
            <div
              className="flex min-w-0 items-center gap-3 cursor-pointer"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(job.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onOpen(job.id);
              }}
            >
              <PreviewCover
                title={job.preview.coverTitle || job.preview.displayTitle}
                imageUrl={job.preview.coverUrl}
                compact
              />
              <div className="min-w-0">
                <h3 className="line-clamp-1 font-semibold text-sm text-tech-text">{job.preview.displayTitle}</h3>
                <p className="mt-0.5 line-clamp-1 text-xs text-tech-muted">
                  {job.preview.sourcePlatform} · {job.preview.subtitle}
                </p>
              </div>
            </div>
            <div className="text-xs text-tech-muted">{formatDate(job.updatedAt)}</div>
            <JobStatusBadge job={job} />
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-tech-text">
              <Wand2 size={13} className="text-tech-purple shrink-0" />
              <span className="line-clamp-1">{job.preview.nextActionLabel}</span>
            </div>
            <div className="flex justify-start gap-2 lg:justify-end">
              <button
                type="button"
                onClick={() => onOpen(job.id)}
                className="rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-medium text-tech-blue hover:bg-blue-100"
              >
                打开
              </button>
              {!job.deletedAt && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(job.id);
                  }}
                  disabled={deletingId === job.id}
                  className={`rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50`}
                >
                  删除
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function JobStatusBadge({ job }: { job: JobOverview }) {
  const state = getJobVisualState(job);
  const toneClasses: Record<string, string> = {
    info: 'border-blue-200 bg-blue-50 text-blue-700',
    processing: 'border-cyan-200 bg-cyan-50 text-cyan-700',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    danger: 'border-red-200 bg-red-50 text-red-700',
  };
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${toneClasses[state.tone]}`}>
      {state.busy && <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {!state.busy && <span className={`inline-block h-1.5 w-1.5 rounded-full ${state.tone === 'success' ? 'bg-emerald-500' : state.tone === 'danger' ? 'bg-red-500' : state.tone === 'processing' ? 'bg-cyan-500' : 'bg-blue-500'}`} />}
      {state.label}
    </span>
  );
}

function AssetPill({ ready, label }: { ready: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
        ready ? 'bg-purple-50 text-tech-purple' : 'bg-gray-100 text-tech-muted'
      }`}
    >
      {label}
    </span>
  );
}

function JobOverviewCard({
  job,
  deleting,
  onOpen,
  onDelete,
}: {
  job: JobOverview;
  deleting: boolean;
  onOpen: (jobId: string) => void;
  onDelete: (jobId: string) => void;
}) {
  return (
    <div
      onClick={() => onOpen(job.id)}
      className="cursor-pointer overflow-hidden rounded-lg border border-tech-border bg-tech-surface transition-all hover:border-tech-blue hover:shadow-lg"
    >
      <PreviewCover title={job.preview.coverTitle || job.preview.displayTitle} imageUrl={job.preview.coverUrl} />
      <div className="p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="line-clamp-1 font-semibold text-tech-text">{job.preview.displayTitle}</h3>
            <p className="mt-1 line-clamp-1 text-sm text-tech-muted">
              {job.preview.sourcePlatform} · {job.preview.subtitle}
            </p>
          </div>
          <JobStatusBadge job={job} />
        </div>
        {job.preview.summary && (
          <p className="mb-4 line-clamp-2 text-sm leading-6 text-tech-muted">{job.preview.summary}</p>
        )}
        <div className="mb-4 flex flex-wrap gap-2">
          <AssetPill ready={job.preview.hasTranscript} label="Transcript" />
          <AssetPill ready={job.preview.hasRewrite} label="Rewrite" />
          <AssetPill ready={job.preview.hasVideoPrompts} label="Prompts" />
          <AssetPill ready={job.preview.hasVideo} label="Video" />
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-tech-border pt-3">
          <span className="inline-flex items-center gap-2 text-sm font-medium text-tech-text">
            <Wand2 size={15} className="text-tech-purple" />
            {job.preview.nextActionLabel}
          </span>
          {!job.deletedAt && (
            <button
              type="button"
              disabled={deleting}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(job.id);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 text-red-600 transition-all hover:bg-red-50 disabled:opacity-50"
              aria-label="删除作品"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewCover({ title, imageUrl, compact = false }: { title: string; imageUrl?: string; compact?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [imageUrl]);
  const showImage = Boolean(imageUrl) && !imageFailed;

  return (
    <div
      className={`shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-tech-blue via-tech-purple to-tech-purple-dark text-white ${
        compact ? 'relative h-12 w-20' : 'relative flex aspect-video w-full items-end'
      }`}
    >
      {showImage && (
        <img
          src={imageUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      )}
      <div className={`relative z-10 ${showImage ? 'bg-gradient-to-t from-black/75 via-black/20 to-transparent' : ''} ${compact ? 'flex h-full w-full items-center p-1.5' : 'w-full p-4'}`}>
        <p className={`line-clamp-2 font-semibold leading-tight ${compact ? 'text-[10px]' : 'text-base'}`}>
          {title || '视频作品'}
        </p>
      </div>
    </div>
  );
}

// Old helpers: emptyCreatorState, getStatusConfig, formatDate removed — now using centralized jobPresentation
