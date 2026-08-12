import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  ExternalLink,
  FolderOpen,
  ImageIcon,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Trash2,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { desktop } from '../electron-bridge';
import { apiClient, parseApiError } from '../services/api';
import { useOperatorStore } from '../store/operator';
import type { PublishPlatform, PublishTask, PublishingListFilters, PublishingListStatus, PublishingPackageDetail } from '../types';
import {
  formatPublishingCopy,
  formatDueNotification,
  getPublishingActionIds,
  groupPublishingPackages,
  PUBLISH_FILTERS,
  PUBLISH_STATUS_LABELS,
  PUBLISHING_PLATFORMS,
} from '../utils/publishing';
import { PublishingActionDialog } from '../features/publishing/PublishingActionDialog';

interface ActionDialogConfig {
  type: 'confirm' | 'prompt' | 'edit-content' | 'withdraw';
  title: string;
  description?: string;
  confirmLabel?: string;
  tone?: 'danger' | 'warning' | 'info';
  inputLabel?: string;
  inputPlaceholder?: string;
  defaultValue?: string;
  defaultValues?: { title: string; description: string; hashtags: string };
}

export function PublishingPage() {
  const currentUser = useOperatorStore((state) => state.currentUser);
  const [params, setParams] = useSearchParams();
  const requestedStatus = params.get('status') as PublishingListStatus | null;
  const status = PUBLISH_FILTERS.some((item) => item.id === requestedStatus) ? requestedStatus! : 'action';
  const [platform, setPlatform] = useState<PublishPlatform | ''>('');
  const [sourceJobId, setSourceJobId] = useState('');
  const [version, setVersion] = useState('');
  const [createdBy, setCreatedBy] = useState('');
  const [search, setSearch] = useState('');
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [packages, setPackages] = useState<PublishingPackageDetail[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const loadSequence = useRef(0);
  const actionLock = useRef(false);

  // ── Action dialog state ──
  const [actionDialog, setActionDialog] = useState<ActionDialogConfig & { open: boolean; busy?: boolean; resolve: ((value: any) => void) | null }>({
    type: 'confirm',
    title: '',
    open: false,
    resolve: null,
  });

  const showDialog = useCallback(<T = any,>(config: ActionDialogConfig): Promise<T | null> => {
    return new Promise<T | null>((resolve) => {
      setActionDialog({ ...config, open: true, resolve });
    });
  }, []);

  const filters = useMemo<PublishingListFilters>(() => ({
    status,
    ...(platform ? { platform } : {}),
    ...(sourceJobId.trim() ? { sourceJobId: sourceJobId.trim() } : {}),
    ...(Number(version) > 0 ? { version: Number(version) } : {}),
    ...(createdBy.trim() ? { createdBy: createdBy.trim() } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  }), [createdBy, platform, search, sourceJobId, status, version]);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!currentUser) {
      setPackages([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await apiClient.listPublishingPackages(filters);
      if (sequence === loadSequence.current) setPackages(result);
    } catch (requestError) {
      if (sequence === loadSequence.current) setError(parseApiError(requestError).message);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [currentUser, filters]);

  useEffect(() => { void load(); }, [load]);

  const run = async <T,>(operation: () => Promise<T>, success: string): Promise<T | undefined> => {
    if (actionLock.current) return undefined;
    actionLock.current = true;
    setBusyAction(true);
    setError('');
    setFeedback('');
    try {
      const result = await operation();
      setFeedback(success);
      await load();
      return result;
    } catch (requestError) {
      setError(parseApiError(requestError).message);
      return undefined;
    } finally {
      actionLock.current = false;
      setBusyAction(false);
    }
  };

  const recordDesktopError = async (task: PublishTask, action: 'open_platform' | 'show_in_finder', message: string) => {
    setError(message);
    await apiClient.recordPublishingActionError(task.id, action, message).catch(() => undefined);
  };

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback(`${label}已复制`);
    } catch {
      setError('复制失败，请检查系统剪贴板权限');
    }
  };

  const handleTaskAction = async (detail: PublishingPackageDetail, task: PublishTask, action: string) => {
    const copy = formatPublishingCopy(task);
    if (action.startsWith('copy-')) {
      const values = { 'copy-title': copy.title, 'copy-description': copy.description, 'copy-hashtags': copy.hashtags, 'copy-full': copy.full } as const;
      await copyText(values[action as keyof typeof values], '发布文案');
      return;
    }
    if (action === 'show-in-finder') {
      try {
        const result = await desktop.showItemInFolder(detail.package.videoPath!);
        if (!result.available) await recordDesktopError(task, 'show_in_finder', '当前环境不支持在 Finder 中显示文件');
      } catch {
        await recordDesktopError(task, 'show_in_finder', '无法在 Finder 中显示发布视频');
      }
      return;
    }
    if (action === 'open-platform') {
      if (!detail.package.coverPath) {
        const confirmed = await showDialog({ type: 'confirm', title: '缺少封面', description: '当前发布包没有封面，仍然打开平台吗？', tone: 'warning' });
        if (!confirmed) return;
      }
      const policy = PUBLISHING_PLATFORMS.find((item) => item.id === task.platform)!;
      try {
        const result = await desktop.openExternal(policy.creatorUrl);
        if (!result.available) await recordDesktopError(task, 'open_platform', '当前环境不支持打开外部发布平台');
      } catch {
        await recordDesktopError(task, 'open_platform', '无法打开官方发布平台');
      }
      return;
    }
    if (action === 'edit-content') {
      const result = await showDialog<{ title: string; description: string; hashtags: string[] }>({
        type: 'edit-content',
        title: '编辑文案',
        defaultValues: { title: task.title, description: task.description, hashtags: task.hashtags.join(' ') },
      });
      if (!result) return;
      await run(
        () => apiClient.updatePublishingContent(task.id, { ...result, expectedRevision: task.contentRevision }),
        '文案已更新',
      );
      return;
    }
    if (action === 'schedule' || action === 'restore') {
      const value = await showDialog<string>({
        type: 'prompt',
        title: action === 'restore' ? '恢复任务' : '修改排期',
        inputLabel: '输入未来排期时间（YYYY-MM-DDTHH:mm），留空表示立即待发布',
        defaultValue: task.scheduledAt ? toLocalDateTimeValue(task.scheduledAt) : '',
      });
      if (value === null) return;
      await run(
        () => action === 'restore' ? apiClient.restorePublishingTask(task.id, value || null) : apiClient.updatePublishingSchedule(task.id, value || null),
        action === 'restore' ? '任务已恢复' : '排期已更新',
      );
      return;
    }
    if (action === 'mark-published') {
      const confirmed = await showDialog({ type: 'confirm', title: '标记已发布', description: '确认已在平台完成发布？' });
      if (!confirmed) return;
      await run(() => apiClient.markPublishingTaskPublished(task.id, { confirmation: true }), '已标记为发布');
      return;
    }
    if (action === 'record-failure') {
      const reason = await showDialog<string>({
        type: 'prompt',
        title: '记录失败',
        inputLabel: '填写发布失败原因',
        inputPlaceholder: '描述失败原因...',
      });
      if (!reason?.trim()) return;
      await run(() => apiClient.recordPublishingFailure(task.id, reason), '失败原因已记录');
      return;
    }
    if (action === 'cancel') {
      const confirmed = await showDialog({ type: 'confirm', title: '取消任务', description: '确认取消这个平台任务？', tone: 'warning' });
      if (!confirmed) return;
      await run(() => apiClient.cancelPublishingTask(task.id, { confirmation: true }), '任务已取消');
      return;
    }
    if (action === 'create-version') {
      const confirmed = await showDialog({ type: 'confirm', title: '创建新版本', description: '基于当前发布包创建一个独立新版本？' });
      if (!confirmed) return;
      await run(() => apiClient.createPublishingVersion(detail.package.id, {}), '新版本已创建');
      return;
    }
    if (action === 'withdraw') {
      const result = await showDialog<{ reason: string }>({ type: 'withdraw', title: '撤回本地状态' });
      if (!result?.reason) return;
      await run(() => apiClient.withdrawPublishingTask(task.id, { confirmation: true, reason: result.reason }), '本地发布状态已撤回');
      return;
    }
    if (action === 'trash-package') {
      const hasPublished = detail.tasks.some((item) => item.status === 'published');
      const description = hasPublished
        ? '发布包含已发布任务。删除只影响本地资产，不影响平台视频。确认移入发布垃圾桶？'
        : '确认将整个发布包移入发布垃圾桶？';
      const confirmed = await showDialog({ type: 'confirm', title: '移入发布垃圾桶', description, tone: 'danger' });
      if (!confirmed) return;
      await run(() => apiClient.trashPublishingPackage(detail.package.id, { confirmation: true }), '发布包已移入垃圾桶');
      return;
    }
    if (action === 'restore-package') {
      const result = await run(() => apiClient.restorePublishingPackage(detail.package.id), '发布包已恢复');
      if (!result?.notifications.length) return;
      if (!desktop.capabilities.showNotification) {
        setFeedback(`发布包已恢复，${result.notifications.length} 个任务已经到期`);
        return;
      }
      for (const notification of result.notifications) {
        await desktop.showNotification(
          `${notification.platformLabel} 待发布`,
          `${notification.title}，${formatDueNotification(notification)}`,
        ).catch(() => undefined);
      }
    }
  };

  const groups = groupPublishingPackages(packages);

  // ── Mobile bottom bar: primary actions for expanded packages ──
  const mobileBarActions = useMemo(() => {
    if (expanded.size === 0 || !currentUser) return [];
    for (const group of groups) {
      for (const detail of group.versions) {
        if (!expanded.has(detail.package.id)) continue;
        if (detail.package.state === 'trashed') continue;
        for (const task of detail.tasks) {
          if (task.status === 'ready' && detail.package.assetHealth !== 'broken_video') {
            return [
              { label: '打开平台', action: 'open-platform', detail, task },
              { label: '标记已发布', action: 'mark-published', detail, task },
              { label: '复制全文', action: 'copy-full', detail, task },
            ];
          }
        }
      }
    }
    return [];
  }, [expanded, groups, currentUser]);

  return (
    <Layout>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="mt-2 text-3xl font-semibold text-tech-text">发布中心</h1>
          <p className="mt-2 text-tech-muted">整理交付包、复制文案并跟踪人工发布状态。</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading || !currentUser} className="inline-flex items-center justify-center gap-2 rounded-lg border border-tech-border px-4 py-2.5 text-sm font-medium text-tech-text hover:bg-tech-surface disabled:opacity-50">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> 刷新
        </button>
      </div>

      {!desktop.capabilities.showNotification && <div className="mb-4 flex items-start gap-2 border-l-4 border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-800"><AlertTriangle size={17} className="mt-0.5 shrink-0" />浏览器模式不会显示系统排期通知，任务状态仍会正常更新。</div>}
      {!currentUser ? (
        <div className="border-y border-tech-border py-16 text-center"><p className="text-lg font-semibold text-tech-text">请选择操作者</p><p className="mt-2 text-sm text-tech-muted">在顶部选择发布者或管理员后查看发布任务。</p></div>
      ) : (
        <>
          {/* Status filter chips with counts */}
          <div className="mb-3 flex gap-2 overflow-x-auto border-b border-tech-border pb-3">
            {PUBLISH_FILTERS.map((item) => {
              const count = item.id === 'all'
                ? packages.length
                : packages.reduce((n, pkg) => n + pkg.tasks.filter((t) => t.status === item.id).length, 0);
              return (
                <button key={item.id} type="button" onClick={() => setParams(item.id === 'action' ? {} : { status: item.id })} className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ${status === item.id ? 'bg-blue-50 text-tech-blue' : 'text-tech-muted hover:bg-tech-surface'}`}>
                  {item.label}
                  {count > 0 && <span className="ml-1.5 text-xs opacity-70">{count}</span>}
                </button>
              );
            })}
          </div>
          {/* Primary filters: always visible */}
          <div className="mb-3 grid gap-3 md:grid-cols-2">
            <FilterInput icon={<Search size={15} />} value={search} onChange={setSearch} placeholder="搜索标题/文案" />
            <select value={platform} onChange={(event) => setPlatform(event.target.value as PublishPlatform | '')} className="rounded-lg border border-tech-border bg-tech-surface px-3 py-2 text-sm text-tech-text"><option value="">全部平台</option>{PUBLISHING_PLATFORMS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
          </div>
          {/* More filters toggle */}
          <div className="mb-3">
            <button
              type="button"
              onClick={() => setShowMoreFilters((v) => !v)}
              className="inline-flex items-center gap-1.5 text-sm text-tech-muted hover:text-tech-text transition-colors"
            >
              {showMoreFilters ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              更多筛选
            </button>
          </div>
          {/* Extended filters: collapsed by default */}
          {showMoreFilters && (
            <div className="mb-6 grid gap-3 border-t border-tech-border pt-4 md:grid-cols-3">
              <FilterInput value={sourceJobId} onChange={setSourceJobId} placeholder="源任务 ID" />
              <FilterInput value={version} onChange={setVersion} placeholder="版本号" type="number" />
              <FilterInput value={createdBy} onChange={setCreatedBy} placeholder="创建者 ID" />
              <button type="button" onClick={() => { setPlatform(''); setSourceJobId(''); setVersion(''); setCreatedBy(''); setSearch(''); }} className="rounded-lg border border-tech-border px-3 py-2 text-sm text-tech-muted hover:bg-tech-surface self-end">清空筛选</button>
            </div>
          )}

          {error && <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</p>}
          {feedback && <p className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"><Check size={16} />{feedback}</p>}
          {loading ? <div className="flex justify-center py-20"><Loader2 className="animate-spin text-tech-blue" size={32} /></div> : groups.length === 0 ? <div className="border-y border-tech-border py-16 text-center"><p className="font-semibold text-tech-text">没有符合条件的发布包</p><p className="mt-2 text-sm text-tech-muted">可从已生成成片的作品详情加入发布中心。</p></div> : (
            <div className="space-y-6 pb-20 md:pb-0">
              {groups.map((group) => <section key={group.sourceJobId} className="overflow-hidden rounded-lg border border-tech-border bg-tech-surface"><header className="flex flex-col gap-1 border-b border-tech-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-semibold text-tech-text">{group.title}</h2></div><span className="text-sm text-tech-muted">{group.versions.length} 个版本</span></header><div className="divide-y divide-tech-border">{group.versions.map((detail) => <PackageRow key={detail.package.id} detail={detail} sourceJobId={group.sourceJobId} role={currentUser.role} expanded={expanded.has(detail.package.id)} busy={busyAction} onToggle={() => setExpanded((value) => { const next = new Set(value); next.has(detail.package.id) ? next.delete(detail.package.id) : next.add(detail.package.id); return next; })} onAction={handleTaskAction} />)}</div></section>)}
            </div>
          )}
        </>
      )}

      {/* Mobile bottom action bar */}
      {mobileBarActions.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 border-t border-tech-border bg-white px-4 py-3 md:hidden">
          <div className="flex gap-2">
            {mobileBarActions.map(({ label, action, detail, task }) => (
              <button
                key={action}
                type="button"
                disabled={busyAction}
                onClick={() => void handleTaskAction(detail, task, action)}
                className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-medium disabled:opacity-50 ${
                  action === 'mark-published' || action === 'open-platform'
                    ? 'bg-tech-blue text-white'
                    : 'border border-tech-border text-tech-text'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Publishing action dialog — replaces all window.confirm/prompt */}
      <PublishingActionDialog
        open={actionDialog.open}
        type={actionDialog.type}
        title={actionDialog.title}
        description={actionDialog.description}
        confirmLabel={actionDialog.confirmLabel}
        tone={actionDialog.tone}
        inputLabel={actionDialog.inputLabel}
        inputPlaceholder={actionDialog.inputPlaceholder}
        defaultValue={actionDialog.defaultValue}
        defaultValues={actionDialog.defaultValues}
        busy={actionDialog.busy}
        onConfirm={(value) => {
          actionDialog.resolve?.(value ?? true);
          setActionDialog((prev) => ({ ...prev, open: false, resolve: null }));
        }}
        onClose={() => {
          actionDialog.resolve?.(null);
          setActionDialog((prev) => ({ ...prev, open: false, resolve: null }));
        }}
      />
    </Layout>
  );
}

function PackageRow({ detail, sourceJobId, role, expanded, busy, onToggle, onAction }: { detail: PublishingPackageDetail; sourceJobId: string; role: 'admin' | 'publisher'; expanded: boolean; busy: boolean; onToggle: () => void; onAction: (detail: PublishingPackageDetail, task: PublishTask, action: string) => Promise<void> }) {
  const pkg = detail.package;
  return <div><button type="button" onClick={onToggle} className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-tech-bg"><CoverThumbnail packageId={pkg.id} title={pkg.title} hasCover={Boolean(pkg.coverPath)} /><span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-sm font-bold text-tech-purple">v{pkg.version}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-tech-text">{pkg.title}</span><AssetBadge health={pkg.assetHealth} />{pkg.state === 'trashed' && <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600">垃圾桶</span>}</div><p className="mt-1 text-xs text-tech-muted">{pkg.createdBy.displayName} · {new Date(pkg.createdAt).toLocaleString('zh-CN')}</p><p className="mt-1 text-xs font-medium text-tech-blue">下一步：{publishingNextStep(detail)}</p></div><div className="hidden flex-wrap gap-2 sm:flex">{detail.tasks.map((task) => <StatusBadge key={task.id} task={task} />)}</div>{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>{expanded && <div className="border-t border-tech-border bg-tech-bg/60 px-5 py-4"><div className="space-y-3">{detail.tasks.map((task) => <TaskRow key={task.id} detail={detail} task={task} role={role} busy={busy} onAction={onAction} />)}</div><details className="mt-4 border-t border-tech-border pt-4"><summary className="cursor-pointer text-sm font-medium text-tech-muted">审计记录（{detail.audit.length}）</summary><ol className="mt-3 space-y-2">{detail.audit.slice().reverse().map((event) => <li key={event.id} className="grid gap-1 text-xs sm:grid-cols-[10rem_1fr]"><time className="text-tech-muted">{new Date(event.createdAt).toLocaleString('zh-CN')}</time><span className="text-tech-text">{event.actor.displayName} · {event.action}{event.reason ? ` · ${event.reason}` : ''}</span></li>)}</ol></details>{sourceJobId && <p className="mt-3 text-xs text-tech-muted">源任务 {sourceJobId}</p>}</div>}</div>;
}

function CoverThumbnail({ packageId, title, hasCover }: { packageId: string; title: string; hasCover: boolean }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!hasCover) return;
    let active = true;
    let objectUrl = '';
    void apiClient.getPublishingCover(packageId).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasCover, packageId]);
  return <span className="flex h-16 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-tech-bg text-tech-muted">{url ? <img src={url} alt={`${title}封面`} className="h-full w-full object-cover" /> : <ImageIcon size={18} aria-hidden="true" />}</span>;
}

function publishingNextStep(detail: PublishingPackageDetail): string {
  if (detail.package.state === 'trashed') return '由管理员恢复发布包';
  if (detail.package.assetHealth === 'broken_video') return '创建新版本并修复视频';
  if (detail.tasks.some((task) => task.status === 'ready')) return '打开平台并完成发布';
  if (detail.tasks.some((task) => task.status === 'failed')) return '处理失败原因并恢复任务';
  if (detail.tasks.some((task) => task.status === 'scheduled')) return '等待排期提醒';
  if (detail.tasks.every((task) => task.status === 'published')) return '已完成，可创建新版本';
  return '恢复已取消任务或创建新版本';
}

function TaskRow({ detail, task, role, busy, onAction }: { detail: PublishingPackageDetail; task: PublishTask; role: 'admin' | 'publisher'; busy: boolean; onAction: (detail: PublishingPackageDetail, task: PublishTask, action: string) => Promise<void> }) {
  const policy = PUBLISHING_PLATFORMS.find((item) => item.id === task.platform)!;
  const actions = getPublishingActionIds(detail, task, role);
  const labels: Record<string, string> = { 'copy-title': '复制标题', 'copy-description': '复制正文', 'copy-hashtags': '复制标签', 'copy-full': '复制全部', 'show-in-finder': 'Finder', 'open-platform': '打开平台', 'edit-content': '编辑文案', schedule: '修改排期', 'mark-published': '标记已发布', 'record-failure': '记录失败', cancel: '取消任务', restore: '恢复任务', 'create-version': '创建新版本', withdraw: '撤回本地状态', 'trash-package': '删除发布包', 'restore-package': '恢复发布包' };
  return <div className="rounded-lg border border-tech-border bg-tech-surface p-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-tech-text">{policy.label}</span><StatusBadge task={task} /><span className="text-xs text-tech-muted">版本 {task.contentRevision} · {task.copySource === 'user_edited' ? '已编辑' : task.copySource === 'ai' ? 'AI' : '洗稿回退'}</span></div><p className="mt-2 font-medium text-tech-text">{task.title}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-tech-muted">{task.description}</p><p className="mt-2 text-sm text-tech-purple">{formatPublishingCopy(task).hashtags}</p>{task.scheduledAt && <p className="mt-2 text-xs text-tech-muted">计划 {new Date(task.scheduledAt).toLocaleString('zh-CN')}</p>}{task.publishedAt && <p className="mt-1 text-xs text-emerald-600">发布于 {new Date(task.publishedAt).toLocaleString('zh-CN')}</p>}{task.lastError && <p className="mt-2 text-sm text-red-600">{task.lastError}</p>}</div><div className="flex max-w-md flex-wrap gap-2 lg:justify-end">{actions.map((action) => <button key={action} type="button" title={labels[action]} disabled={busy} onClick={() => void onAction(detail, task, action)} className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${action === 'mark-published' || action === 'open-platform' ? 'border-tech-blue bg-blue-50 text-tech-blue' : action === 'trash-package' || action === 'withdraw' ? 'border-red-200 text-red-600 hover:bg-red-50' : 'border-tech-border text-tech-muted hover:bg-tech-bg hover:text-tech-text'}`}>{action.startsWith('copy-') ? <Clipboard size={14} aria-label={labels[action]} /> : action === 'show-in-finder' ? <FolderOpen size={14} aria-label={labels[action]} /> : action === 'open-platform' ? <ExternalLink size={14} aria-label={labels[action]} /> : action === 'trash-package' ? <Trash2 size={14} aria-label={labels[action]} /> : action === 'restore-package' || action === 'restore' ? <RotateCcw size={14} aria-label={labels[action]} /> : labels[action]}</button>)}</div></div></div>;
}

function StatusBadge({ task }: { task: PublishTask }) { const colors = { scheduled: 'bg-cyan-50 text-cyan-700', ready: 'bg-blue-50 text-blue-700', published: 'bg-emerald-50 text-emerald-700', failed: 'bg-red-50 text-red-700', cancelled: 'bg-gray-100 text-gray-600' }; return <span className={`rounded-full px-2 py-1 text-xs font-medium ${colors[task.status]}`}>{PUBLISH_STATUS_LABELS[task.status]}</span>; }
function AssetBadge({ health }: { health: PublishingPackageDetail['package']['assetHealth'] }) { const text = health === 'healthy' ? '资产正常' : health === 'missing_cover' ? '缺少封面' : '视频异常'; return <span className={`rounded-full px-2 py-1 text-xs ${health === 'broken_video' ? 'bg-red-50 text-red-700' : health === 'missing_cover' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>{text}</span>; }
function FilterInput({ icon, value, onChange, placeholder, type = 'text' }: { icon?: ReactNode; value: string; onChange: (value: string) => void; placeholder: string; type?: string }) { return <label className="flex items-center gap-2 rounded-lg border border-tech-border bg-tech-surface px-3"><span className="text-tech-muted">{icon}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-tech-text outline-none" /></label>; }
function toLocalDateTimeValue(value: string): string { const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
