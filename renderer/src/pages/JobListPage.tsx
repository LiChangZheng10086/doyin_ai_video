import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { CreateJobDialog } from '../components/CreateJobDialog';
import { ApiKeyWarning } from '../components/ApiKeyWarning';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { useAppStore } from '../store';
import { apiClient } from '../services/api';
import { hasValidApiKey } from '../utils/apiKeyValidator';
import { useJobPolling } from '../hooks/useJobPolling';
import type { JobFilterStatus, JobOverview, ViewMode } from '../types';
import {
  filterJobOverviews,
  selectActiveJob,
  readStoredViewMode,
  writeStoredViewMode,
} from '../features/jobs/jobPresentation';
import { ActiveJobStrip } from '../features/jobs/ActiveJobStrip';
import { JobListToolbar } from '../features/jobs/JobListToolbar';
import { JobListView } from '../features/jobs/JobListView';
import { JobCardView } from '../features/jobs/JobCardView';

export function JobListPage() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [showApiWarning, setShowApiWarning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [overviews, setOverviews] = useState<JobOverview[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<JobFilterStatus>('all');
  const [viewMode, setViewMode] = useState<ViewMode>(() => readStoredViewMode(window.localStorage));
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const navigate = useNavigate();
  const setJobs = useAppStore((state) => state.setJobs);
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
          setServerPort(5173);
        }
        await apiClient.initialize();
        await refreshOverviews();
        setLoadError(null);
      } catch (error) {
        console.error('Failed to initialize:', error);
        setLoadError('加载作品列表失败，请检查后端服务是否正常运行');
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

  const activeJob = selectActiveJob(overviews);
  const filteredJobs = useMemo(() => {
    return filterJobOverviews(overviews, query, filter);
  }, [filter, overviews, query]);

  const handleJobClick = (jobId: string) => {
    navigate(`/jobs/${jobId}`);
  };

  const handleRequestDelete = (jobId: string) => {
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
      setDeleteError(null);
    } catch (error: any) {
      setDeleteError(error.response?.data?.message || '删除作品失败');
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

  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    writeStoredViewMode(window.localStorage, mode);
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

  return (
    <Layout>
      {/* Load error */}
      {loadError && (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center justify-between">
          <span className="flex items-center gap-2">
            <AlertCircle size={16} />
            {loadError}
          </span>
          <button
            onClick={() => { setLoadError(null); window.location.reload(); }}
            className="text-xs font-medium underline"
          >
            重试
          </button>
        </div>
      )}

      {/* Delete error */}
      {deleteError && (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center justify-between">
          <span className="flex items-center gap-2">
            <AlertCircle size={16} />
            {deleteError}
          </span>
          <button onClick={() => setDeleteError(null)} className="text-xs font-medium underline">
            关闭
          </button>
        </div>
      )}

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

      {/* Active job strip */}
      {activeJob && (
        <div className="mb-5">
          <ActiveJobStrip job={activeJob} onOpen={handleJobClick} />
        </div>
      )}

      {/* Toolbar */}
      <JobListToolbar
        query={query}
        filter={filter}
        viewMode={viewMode}
        polling={isPolling && overviews.length > 0}
        onQueryChange={setQuery}
        onFilterChange={setFilter}
        onViewModeChange={changeViewMode}
      />

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
        <JobListView
          jobs={filteredJobs}
          deletingId={deletingId}
          onOpen={handleJobClick}
          onRequestDelete={handleRequestDelete}
        />
      ) : (
        <JobCardView
          jobs={filteredJobs}
          deletingId={deletingId}
          onOpen={handleJobClick}
          onRequestDelete={handleRequestDelete}
        />
      )}

      <CreateJobDialog
        isOpen={isDialogOpen}
        onClose={() => setIsDialogOpen(false)}
      />

      <ApiKeyWarning
        isOpen={showApiWarning}
        onClose={() => setShowApiWarning(false)}
      />

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="确定删除这个作品吗？"
        description="删除后会进入垃圾桶，30 天内可恢复。"
        confirmLabel={deletingId ? '删除中...' : '删除'}
        onConfirm={confirmDelete}
        onClose={() => setConfirmDeleteId(null)}
        busy={deletingId !== null}
      />
    </Layout>
  );
}
