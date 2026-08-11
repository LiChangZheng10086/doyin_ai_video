import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { CreateJobDialog } from '../components/CreateJobDialog';
import { ApiKeyWarning } from '../components/ApiKeyWarning';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { apiClient } from '../services/api';
import { hasValidApiKey } from '../utils/apiKeyValidator';
import type { CollectionOverview } from '../types';

export function CollectionListPage() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [showApiWarning, setShowApiWarning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [collections, setCollections] = useState<CollectionOverview[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const navigate = useNavigate();

  const refreshCollections = useCallback(async () => {
    try {
      const items = await apiClient.getCollections();
      setCollections(items);
    } catch (error) {
      console.error('Failed to load collections:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshCollections();
  }, [refreshCollections]);

  // 每 5 秒刷新合集进度
  useEffect(() => {
    if (collections.length === 0) return;
    const timer = window.setInterval(() => {
      refreshCollections();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [collections.length, refreshCollections]);

  const handleDelete = async (collectionId: string) => {
    try {
      setDeleteError(null);
      setDeletingId(collectionId);
      await apiClient.deleteCollection(collectionId);
      setCollections((prev) => prev.filter((c) => c.id !== collectionId));
      setDeleteTarget(null);
    } catch (error: any) {
      setDeleteError(error.response?.data?.message || '删除合集失败');
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
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-tech-purple" />
            <p className="mt-4 text-tech-muted">正在载入合集...</p>
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
            作品合集
          </p>
          <h2 className="text-2xl font-semibold text-tech-text">作品合集</h2>
          <p className="mt-1 text-sm text-tech-muted">
            从抖音用户主页批量采集视频，统一管理、处理和生成
          </p>
        </div>
        <button
          onClick={handleCreateClick}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-tech-purple px-5 py-3 font-medium text-white shadow-sm transition-all hover:bg-purple-700 hover:shadow disabled:opacity-50"
        >
          <Plus size={18} />
          新建合集
        </button>
      </div>

      {collections.length === 0 ? (
        <div className="rounded-lg border border-dashed border-tech-border bg-tech-surface px-6 py-20 text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-lg bg-gradient-to-br from-tech-purple to-tech-blue text-white shadow-lg">
            <Users size={34} />
          </div>
          <h3 className="text-xl font-semibold text-tech-text">还没有合集</h3>
          <p className="mx-auto mt-2 max-w-md text-tech-muted">
            输入抖音用户主页链接，系统自动采集该用户全部视频作品，批量创建处理任务。
          </p>
          <button
            onClick={handleCreateClick}
            className="mt-8 inline-flex items-center justify-center gap-2 rounded-lg bg-tech-purple px-6 py-3 font-medium text-white shadow-sm transition-all hover:bg-purple-700 hover:shadow"
          >
            <Plus size={18} />
            创建第一个合集
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {collections.map((collection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              deleting={deletingId === collection.id}
              onOpen={() => navigate(`/collections/${collection.id}`)}
              onDelete={() => setDeleteTarget(collection.id)}
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
      <ConfirmDialog
        open={deleteTarget !== null}
        title="确定删除这个合集吗？"
        description="子任务不会被删除。"
        confirmLabel="删除"
        tone="danger"
        busy={deletingId !== null}
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
        onClose={() => { setDeleteTarget(null); setDeleteError(null); }}
      />

      {deleteError && (
        <div className="fixed bottom-6 right-6 z-50 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-lg">
          {deleteError}
          <button className="ml-3 font-medium underline" onClick={() => setDeleteError(null)}>关闭</button>
        </div>
      )}
    </Layout>
  );
}

function CollectionCard({
  collection,
  deleting,
  onOpen,
  onDelete,
}: {
  collection: CollectionOverview;
  deleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const progress = collection.childJobProgress;
  const showAvatar = Boolean(collection.avatarUrl) && !avatarFailed;
  const overallPercent = progress.total > 0
    ? Math.round(
        ((progress.transcribed + progress.cleaned + progress.scripted + progress.rendered) /
          (progress.total * 4)) *
          100
      )
    : 0;

  return (
    <div
      onClick={onOpen}
      className="cursor-pointer overflow-hidden rounded-lg border border-tech-border bg-tech-surface transition-all hover:border-tech-purple hover:shadow-lg"
    >
      {/* 封面区域 */}
      <div className="flex items-center gap-4 bg-gradient-to-br from-tech-purple via-tech-purple-dark to-tech-blue p-5">
        <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-white/20 text-2xl font-bold text-white">
          {collection.nickname?.charAt(0) || 'U'}
          {showAvatar && (
            <img
              src={collection.avatarUrl}
              alt={collection.nickname || '用户头像'}
              className="absolute inset-0 h-full w-full object-cover"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setAvatarFailed(true)}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-1 font-semibold text-white text-lg">
            {collection.nickname || '未知用户'}
          </h3>
          <p className="mt-0.5 text-sm text-white/70">
            {collection.crawlResult.totalCollected} 个作品
          </p>
        </div>
      </div>

      <div className="p-4">
        {/* 用户信息 */}
        <div className="mb-4 flex items-center gap-3 text-sm text-tech-muted">
          <Users size={14} />
          <span>{collection.crawlResult.totalCollected} 个视频已采集</span>
        </div>

        {/* 进度条 */}
        {progress.total > 0 && (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2 text-xs text-tech-muted">
              <span>处理进度</span>
              <span>{overallPercent}%</span>
            </div>
            <div className="h-2 rounded-full bg-tech-bg overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-tech-purple to-tech-blue transition-all"
                style={{ width: `${overallPercent}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <ProgressChip label="转录" count={progress.transcribed} total={progress.total} />
              <ProgressChip label="洗稿" count={progress.cleaned} total={progress.total} />
              <ProgressChip label="分镜" count={progress.scripted} total={progress.total} />
              <ProgressChip label="成片" count={progress.rendered} total={progress.total} />
            </div>
          </div>
        )}

        {progress.total === 0 && (
          <div className="mb-4 flex items-center gap-2 text-sm text-tech-muted">
            <AlertCircle size={14} />
            <span>尚未创建子任务</span>
          </div>
        )}

        {/* 操作 */}
        <div className="flex items-center justify-between border-t border-tech-border pt-3">
          <span className="text-sm font-medium text-tech-text">
            {progress.total > 0
              ? `${progress.rendered} / ${progress.total} 部成片`
              : '点击查看详情'}
          </span>
          <button
            type="button"
            disabled={deleting}
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 text-red-600 transition-all hover:bg-red-50 disabled:opacity-50"
            aria-label="删除合集"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ProgressChip({ label, count, total }: { label: string; count: number; total: number }) {
  const done = count === total && total > 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
        done ? 'bg-emerald-50 text-emerald-700' : 'bg-tech-bg text-tech-muted'
      }`}
    >
      {done ? <CheckCircle2 size={10} /> : <Clock size={10} />}
      {label}: {count}/{total}
    </span>
  );
}
