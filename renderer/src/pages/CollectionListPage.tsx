import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import { Layout } from '../components/Layout';
import { PageHeader } from '../components/ui/PageHeader';
import { Button } from '../components/ui/Button';
import { CreateJobDialog } from '../components/CreateJobDialog';
import { ApiKeyWarning } from '../components/ApiKeyWarning';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { apiClient } from '../services/api';
import { hasValidApiKey } from '../utils/apiKeyValidator';
import { displayNickname } from '../utils/display';
import type { CollectionOverview } from '../types';

export function CollectionListPage() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [showApiWarning, setShowApiWarning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [collections, setCollections] = useState<CollectionOverview[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);

  const navigate = useNavigate();

  const refreshCollections = useCallback(async (silent = false) => {
    try {
      const items = await apiClient.getCollections();
      setCollections(items);
      setRefreshError(false);
    } catch (error) {
      console.error('Failed to load collections:', error);
      if (!silent) {
        setRefreshError(true);
      }
      // 静默轮询失败不清空已有数据
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshCollections();
  }, [refreshCollections]);

  // 每 5 秒刷新合集进度（静默轮询）
  useEffect(() => {
    if (collections.length === 0) return;
    const timer = window.setInterval(() => {
      refreshCollections(true);
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
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-ai" />
            <p className="mt-4 text-ink-muted">正在载入合集...</p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      {/*
        静默刷新失败的提示**只在已有数据时**成立 —— 一份都没加载出来时说
        「当前显示上次数据」是假话，那时应该走下面的错误态。
      */}
      {refreshError && collections.length > 0 && (
        <div className="mb-4 rounded-lg border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning flex items-center justify-between">
          <span className="flex items-center gap-2">
            <AlertCircle size={16} />
            刷新失败，当前显示上次数据
          </span>
          <button
            onClick={() => { setRefreshError(false); refreshCollections(); }}
            className="text-xs font-medium underline"
          >
            重试
          </button>
        </div>
      )}
      <PageHeader
        title="作品合集"
        description="从抖音用户主页批量采集视频，统一管理、处理和生成"
        actions={
          <Button variant="ai" size="lg" onClick={handleCreateClick}>
            <Plus size={18} aria-hidden="true" />
            新建合集
          </Button>
        }
      />

      {collections.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-panel px-6 py-20 text-center">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-lg border border-line bg-canvas text-ink-muted">
            <Users size={34} />
          </div>
          <h3 className="text-xl font-semibold text-ink">还没有合集</h3>
          <p className="mx-auto mt-2 max-w-md text-ink-muted">
            输入抖音用户主页链接，系统自动采集该用户全部视频作品，批量创建处理任务。
          </p>
          <button
            onClick={handleCreateClick}
            className="mt-8 inline-flex items-center justify-center gap-2 rounded-lg bg-ai px-6 py-3 font-medium text-on-accent shadow-sm transition-all hover:bg-ai hover:shadow"
          >
            <Plus size={18} />
            创建第一个合集
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {collections.map((collection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              deleting={deletingId === collection.id}
              expandedMenu={expandedMenu === collection.id}
              onOpen={() => navigate(`/collections/${collection.id}`)}
              onDelete={() => setDeleteTarget(collection.id)}
              onToggleMenu={() => setExpandedMenu(expandedMenu === collection.id ? null : collection.id)}
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
        <div className="fixed bottom-6 right-6 z-50 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger shadow-lg">
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
  expandedMenu,
  onOpen,
  onDelete,
  onToggleMenu,
}: {
  collection: CollectionOverview;
  deleting: boolean;
  expandedMenu: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onToggleMenu: () => void;
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
      className="cursor-pointer overflow-hidden rounded-lg border border-line bg-panel transition-all hover:border-ai-line/40 hover:shadow-md"
    >
      {/* 身份区：博主头像 + 名称 */}
      <div className="flex items-center gap-4 p-5">
        <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-canvas ring-2 ring-ai/20">
          {showAvatar ? (
            <img
              src={collection.avatarUrl}
              alt={displayNickname(collection.nickname)}
              className="h-full w-full object-cover"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-xl font-bold text-ai">
              {displayNickname(collection.nickname).charAt(0)}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lg font-semibold text-ink">
            {displayNickname(collection.nickname)}
          </h3>
          <p className="mt-0.5 text-sm text-ink-muted">
            {collection.crawlResult.totalCollected} 个作品 · {progress.total > 0 ? `${progress.rendered} 部成片` : '待处理'}
          </p>
        </div>
      </div>

      {/* 内容库摘要 */}
      <div className="border-t border-line px-5 py-3">
        {/* 进度条 */}
        {progress.total > 0 ? (
          <>
            <div className="flex items-center justify-between mb-2 text-xs text-ink-muted">
              <span className="font-medium">处理进度</span>
              <span>{overallPercent}%</span>
            </div>
            <div className="h-2 rounded-full bg-canvas overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-ai to-accent transition-all"
                style={{ width: `${overallPercent}%` }}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              <ProgressChip label="转录" count={progress.transcribed} total={progress.total} />
              <ProgressChip label="洗稿" count={progress.cleaned} total={progress.total} />
              <ProgressChip label="分镜" count={progress.scripted} total={progress.total} />
              <ProgressChip label="成片" count={progress.rendered} total={progress.total} />
              {progress.failed > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 font-medium text-danger">
                  <AlertCircle size={10} />
                  {progress.failed} 失败
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2 text-sm text-ink-muted">
            <AlertCircle size={14} />
            <span>尚未创建子任务</span>
          </div>
        )}
      </div>

      {/* 底部操作 */}
      <div className="flex items-center justify-between border-t border-line px-5 py-3">
        <span className="text-xs text-ink-muted">
          {collection.skillName ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-ai-soft px-2 py-0.5 text-xs font-medium text-ai">
              <Sparkles size={10} />
              {collection.skillName}
            </span>
          ) : progress.rendered > 0 ? (
            `${progress.rendered} 部成片可发布`
          ) : (
            '点击查看详情'
          )}
        </span>
        <div className="relative">
          <button
            type="button"
            disabled={deleting}
            onClick={(event) => {
              event.stopPropagation();
              onToggleMenu();
            }}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-muted transition-all hover:bg-elevated disabled:opacity-50"
            aria-label="更多操作"
          >
            <MoreHorizontal size={15} />
          </button>
          {expandedMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); onToggleMenu(); }} />
              <div className="absolute right-0 top-full mt-1 z-20 rounded-lg border border-line bg-panel shadow-lg py-1 min-w-[120px]">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleMenu();
                    onDelete();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm text-danger hover:bg-danger-soft disabled:opacity-50"
                >
                  <Trash2 size={14} />
                  删除合集
                </button>
              </div>
            </>
          )}
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
        done ? 'bg-success-soft text-success' : 'bg-canvas text-ink-muted'
      }`}
    >
      {done ? <CheckCircle2 size={10} /> : <Clock size={10} />}
      {label}: {count}/{total}
    </span>
  );
}
