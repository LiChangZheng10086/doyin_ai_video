import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
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
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-accent-line border-t-transparent" />
            <p className="mt-4 text-ink-muted">正在载入作品列表...</p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      {/*
        ⚠️ 错误横幅只在**已有数据**时显示。改造前它无条件渲染，而下面的空态只判断
        `overviews.length === 0` —— 后端挂掉时界面会**同时**说「加载作品列表失败」
        和「还没有作品」，用户会以为自己的作品没了（同一个写法在 TrashPage /
        AssetsPage / SkillListPage / CollectionListPage 上也出现过）。
        现在的口径：有错且无数据 → 只显示错误态（带重试）；有错但有旧数据 → 横幅提示。
      */}
      {loadError && overviews.length > 0 && (
        <div className="mb-5 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger flex items-center justify-between">
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
        <div className="mb-5 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger flex items-center justify-between">
          <span className="flex items-center gap-2">
            <AlertCircle size={16} />
            {deleteError}
          </span>
          <button onClick={() => setDeleteError(null)} className="text-xs font-medium underline">
            关闭
          </button>
        </div>
      )}

      <PageHeader
        title="最近作品"
        description="从视频链接开始，管理转录、洗稿、分镜和视频产出"
        actions={
          <Button variant="primary" size="lg" onClick={handleCreateClick}>
            <Plus size={18} aria-hidden="true" />
            创建作品
          </Button>
        }
      />

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
      {loadError && overviews.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState
            icon={AlertCircle}
            title="作品列表加载失败"
            description={loadError}
            action={
              <Button variant="outline" onClick={() => { setLoadError(null); window.location.reload(); }}>
                重新加载
              </Button>
            }
          />
        </div>
      ) : overviews.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState
            icon={Sparkles}
            title="还没有作品"
            description="粘贴抖音链接或分享文本，生成转录、洗稿内容、分镜和本地成片。"
            action={
              <Button variant="primary" onClick={handleCreateClick}>
                <Plus size={16} aria-hidden="true" />
                创建第一个作品
              </Button>
            }
          />
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState
            icon={Search}
            title="没有匹配的作品"
            description="换个关键词或筛选条件再试试。"
            action={
              <Button
                variant="outline"
                onClick={() => { setQuery(''); setFilter('all'); }}
              >
                清空筛选条件
              </Button>
            }
          />
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
