import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  Clock,
  Grid3X3,
  LayoutList,
  Loader2,
  Plus,
  Search,
  Server,
  Sparkles,
  Trash2,
  Video,
  Wand2,
  XCircle,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { CreateJobDialog } from '../components/CreateJobDialog';
import { ApiKeyWarning } from '../components/ApiKeyWarning';
import { useAppStore } from '../store';
import { apiClient } from '../services/api';
import { hasValidApiKey } from '../utils/apiKeyValidator';
import { useJobPolling } from '../hooks/useJobPolling';
import type { JobFilterStatus, JobOverview, ViewMode } from '../types';

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
  const [viewMode, setViewMode] = useState<ViewMode>('list');

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
    const needle = query.trim().toLowerCase();
    return overviews.filter((job) => {
      const matchesFilter =
        filter === 'all' ||
        (filter === 'pending'
          ? job.status === 'queued' && job.workflowMode === 'manual'
          : job.status === filter);
      if (!matchesFilter) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return [
        job.preview.displayTitle,
        job.preview.subtitle,
        job.preview.summary,
        job.preview.sourcePlatform,
        job.topic,
        job.sourceUrl,
      ].some((value) => value?.toLowerCase().includes(needle));
    });
  }, [filter, overviews, query]);

  const handleJobClick = (jobId: string) => {
    navigate(`/jobs/${jobId}`);
  };

  const handleDeleteJob = async (jobId: string) => {
    const ok = window.confirm('确定删除这个作品吗？删除后会进入垃圾桶，30 天内可恢复。');
    if (!ok) return;

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
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-tech-blue" />
            <p className="mt-4 text-tech-muted">正在载入创作中心...</p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 inline-flex items-center gap-2 rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-tech-purple">
            <Sparkles size={14} />
            Creative workspace
          </p>
          <h2 className="text-2xl font-semibold text-tech-text">最近作品</h2>
          <p className="mt-1 text-sm text-tech-muted">
            从视频链接开始，管理转录、洗稿、提示词和视频产出
          </p>
        </div>
        <button
          onClick={handleCreateClick}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-tech-blue px-5 py-3 font-medium text-white shadow-sm transition-all hover:bg-tech-blue-dark hover:shadow disabled:opacity-50"
        >
          <Plus size={18} />
          创建作品
        </button>
      </div>

      <div className="mb-5 rounded-lg border border-tech-border bg-tech-surface p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-tech-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题、来源、摘要或链接"
              className="h-11 w-full rounded-lg border border-tech-border bg-white pl-10 pr-4 text-sm text-tech-text outline-none transition-all placeholder:text-tech-muted focus:border-tech-blue focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex flex-wrap gap-2">
              {filterOptions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  className={`h-9 rounded-lg px-3 text-sm font-medium transition-all ${
                    filter === item.id
                      ? 'bg-tech-text text-white'
                      : 'bg-tech-bg text-tech-muted hover:text-tech-text'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="flex h-9 shrink-0 rounded-lg border border-tech-border bg-tech-bg p-1">
              <button
                type="button"
                aria-label="列表视图"
                onClick={() => setViewMode('list')}
                className={`flex h-7 w-8 items-center justify-center rounded-md transition-all ${
                  viewMode === 'list' ? 'bg-white text-tech-blue shadow-sm' : 'text-tech-muted'
                }`}
              >
                <LayoutList size={16} />
              </button>
              <button
                type="button"
                aria-label="卡片视图"
                onClick={() => setViewMode('card')}
                className={`flex h-7 w-8 items-center justify-center rounded-md transition-all ${
                  viewMode === 'card' ? 'bg-white text-tech-purple shadow-sm' : 'text-tech-muted'
                }`}
              >
                <Grid3X3 size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {serverPort && (
        <div className="mb-5 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          <Server size={16} />
          <span className="font-medium">后端服务运行中</span>
          <code className="rounded bg-white px-2 py-1 text-xs text-emerald-700">
            http://localhost:{serverPort}
          </code>
        </div>
      )}

      {overviews.length === 0 ? (
        <EmptyCreatorState onCreate={handleCreateClick} />
      ) : filteredJobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-tech-border bg-tech-surface py-16 text-center">
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

      {isPolling && overviews.length > 0 && (
        <div className="fixed bottom-4 right-4 rounded-lg border border-tech-border bg-tech-surface px-3 py-2 text-xs text-tech-muted shadow-sm">
          <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
          同步作品状态...
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
    <div className="overflow-hidden rounded-lg border border-tech-border bg-tech-surface">
      <div className="grid grid-cols-[minmax(260px,1.6fr)_minmax(150px,0.9fr)_minmax(130px,0.7fr)_minmax(160px,0.9fr)_112px] gap-4 border-b border-tech-border bg-tech-bg px-4 py-3 text-xs font-medium uppercase text-tech-muted max-lg:hidden">
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
            role="button"
            tabIndex={0}
            onClick={() => onOpen(job.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                onOpen(job.id);
              }
            }}
            className="grid w-full grid-cols-1 gap-4 px-4 py-4 text-left transition-all hover:bg-tech-bg lg:grid-cols-[minmax(260px,1.6fr)_minmax(150px,0.9fr)_minmax(130px,0.7fr)_minmax(160px,0.9fr)_112px] lg:items-center"
          >
            <div className="flex min-w-0 items-center gap-4">
              <PreviewCover title={job.preview.coverTitle || job.preview.displayTitle} compact />
              <div className="min-w-0">
                <h3 className="line-clamp-1 font-semibold text-tech-text">{job.preview.displayTitle}</h3>
                <p className="mt-1 line-clamp-1 text-sm text-tech-muted">
                  {job.preview.sourcePlatform} · {job.preview.subtitle}
                </p>
              </div>
            </div>
            <div className="text-sm text-tech-muted">{formatDate(job.updatedAt)}</div>
            <StatusBadge job={job} />
            <div className="inline-flex items-center gap-2 text-sm font-medium text-tech-text">
              <Wand2 size={15} className="text-tech-purple" />
              {job.preview.nextActionLabel}
            </div>
            <div className="flex justify-start gap-2 lg:justify-end">
              <span className="rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-tech-blue">
                打开
              </span>
              {!job.deletedAt && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(job.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.stopPropagation();
                      onDelete(job.id);
                    }
                  }}
                  className={`rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-all hover:bg-red-50 ${
                    deletingId === job.id ? 'pointer-events-none opacity-50' : ''
                  }`}
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
      <PreviewCover title={job.preview.coverTitle || job.preview.displayTitle} />
      <div className="p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="line-clamp-1 font-semibold text-tech-text">{job.preview.displayTitle}</h3>
            <p className="mt-1 line-clamp-1 text-sm text-tech-muted">
              {job.preview.sourcePlatform} · {job.preview.subtitle}
            </p>
          </div>
          <StatusBadge job={job} />
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

function PreviewCover({ title, compact = false }: { title: string; compact?: boolean }) {
  return (
    <div
      className={`shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-tech-blue via-tech-purple to-tech-purple-dark text-white ${
        compact ? 'h-14 w-24' : 'flex aspect-video w-full items-end'
      }`}
    >
      <div className={`${compact ? 'flex h-full items-center p-2' : 'w-full p-4'}`}>
        <div className="flex items-center gap-2">
          <Video size={compact ? 14 : 18} className="shrink-0 opacity-90" />
          <p className={`line-clamp-2 font-semibold leading-tight ${compact ? 'text-xs' : 'text-lg'}`}>
            {title || 'AI 视频作品'}
          </p>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ job }: { job: JobOverview }) {
  const config = getStatusConfig(job);
  const Icon = config.icon;
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${config.className}`}>
      <Icon size={13} />
      {config.label}
    </span>
  );
}

function AssetPill({ ready, label }: { ready: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
        ready ? 'bg-purple-50 text-tech-purple' : 'bg-tech-bg text-tech-muted'
      }`}
    >
      {ready ? 'Ready' : 'Waiting'} · {label}
    </span>
  );
}

function EmptyCreatorState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-tech-border bg-tech-surface px-6 py-20 text-center">
      <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-lg bg-gradient-to-br from-tech-blue to-tech-purple text-white shadow-lg">
        <Sparkles size={34} />
      </div>
      <h3 className="text-xl font-semibold text-tech-text">还没有作品</h3>
      <p className="mx-auto mt-2 max-w-md text-tech-muted">
        粘贴抖音链接或分享文本，生成转录、洗稿内容、连续分镜和本地成片。
      </p>
      <button
        onClick={onCreate}
        className="mt-8 inline-flex items-center justify-center gap-2 rounded-lg bg-tech-blue px-6 py-3 font-medium text-white shadow-sm transition-all hover:bg-tech-blue-dark hover:shadow"
      >
        <Plus size={18} />
        创建第一个作品
      </button>
    </div>
  );
}

function getStatusConfig(job: JobOverview) {
  if (job.workflowMode === 'manual' && job.status === 'queued') {
    return {
      label: '待执行',
      icon: Clock,
      className: 'border-blue-200 bg-blue-50 text-blue-700',
    };
  }
  if (job.status === 'processing') {
    return {
      label: '处理中',
      icon: Loader2,
      className: 'border-cyan-200 bg-cyan-50 text-cyan-700',
    };
  }
  if (job.status === 'done') {
    return {
      label: '已完成',
      icon: CheckCircle2,
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    };
  }
  if (job.status === 'failed') {
    return {
      label: '失败',
      icon: XCircle,
      className: 'border-red-200 bg-red-50 text-red-700',
    };
  }
  return {
    label: job.status,
    icon: Clock,
    className: 'border-tech-border bg-tech-bg text-tech-muted',
  };
}

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
