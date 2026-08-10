import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  ExternalLink,
  FolderOpen,
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
  getPublishingActionIds,
  groupPublishingPackages,
  PUBLISH_FILTERS,
  PUBLISH_STATUS_LABELS,
  PUBLISHING_PLATFORMS,
} from '../utils/publishing';

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
  const [packages, setPackages] = useState<PublishingPackageDetail[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');

  const filters = useMemo<PublishingListFilters>(() => ({
    status,
    ...(platform ? { platform } : {}),
    ...(sourceJobId.trim() ? { sourceJobId: sourceJobId.trim() } : {}),
    ...(Number(version) > 0 ? { version: Number(version) } : {}),
    ...(createdBy.trim() ? { createdBy: createdBy.trim() } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  }), [createdBy, platform, search, sourceJobId, status, version]);

  const load = useCallback(async () => {
    if (!currentUser) {
      setPackages([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      setPackages(await apiClient.listPublishingPackages(filters));
    } catch (requestError) {
      setError(parseApiError(requestError).message);
    } finally {
      setLoading(false);
    }
  }, [currentUser, filters]);

  useEffect(() => { void load(); }, [load]);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setError('');
    setFeedback('');
    try {
      await operation();
      setFeedback(success);
      await load();
    } catch (requestError) {
      setError(parseApiError(requestError).message);
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
      if (!detail.package.coverPath && !window.confirm('当前发布包没有封面，仍然打开平台吗？')) return;
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
      const title = window.prompt('标题', task.title);
      if (title === null) return;
      const description = window.prompt('正文', task.description);
      if (description === null) return;
      const hashtags = window.prompt('标签，用空格分隔', task.hashtags.join(' '));
      if (hashtags === null) return;
      await run(() => apiClient.updatePublishingContent(task.id, { title, description, hashtags: hashtags.split(/\s+/u).filter(Boolean), expectedRevision: task.contentRevision }), '文案已更新');
      return;
    }
    if (action === 'schedule' || action === 'restore') {
      const value = window.prompt('输入未来排期时间（YYYY-MM-DDTHH:mm），留空表示立即待发布', task.scheduledAt?.slice(0, 16) ?? '');
      if (value === null) return;
      await run(
        () => action === 'restore' ? apiClient.restorePublishingTask(task.id, value || null) : apiClient.updatePublishingSchedule(task.id, value || null),
        action === 'restore' ? '任务已恢复' : '排期已更新',
      );
      return;
    }
    if (action === 'mark-published' && window.confirm('确认已在平台完成发布？')) {
      await run(() => apiClient.markPublishingTaskPublished(task.id, { confirmation: true }), '已标记为发布');
      return;
    }
    if (action === 'record-failure') {
      const reason = window.prompt('填写发布失败原因');
      if (reason?.trim()) await run(() => apiClient.recordPublishingFailure(task.id, reason), '失败原因已记录');
      return;
    }
    if (action === 'cancel' && window.confirm('确认取消这个平台任务？')) {
      await run(() => apiClient.cancelPublishingTask(task.id, { confirmation: true }), '任务已取消');
      return;
    }
    if (action === 'create-version' && window.confirm('基于当前发布包创建一个独立新版本？')) {
      await run(() => apiClient.createPublishingVersion(detail.package.id, {}), '新版本已创建');
      return;
    }
    if (action === 'withdraw') {
      const reason = window.prompt('填写撤回本地已发布状态的原因');
      if (reason?.trim() && window.confirm('只撤回本地状态，不会删除平台视频。确认继续？')) {
        await run(() => apiClient.withdrawPublishingTask(task.id, { confirmation: true, reason }), '本地发布状态已撤回');
      }
      return;
    }
    if (action === 'trash-package') {
      const hasPublished = detail.tasks.some((item) => item.status === 'published');
      const message = hasPublished ? '发布包含已发布任务。删除只影响本地资产，不影响平台视频。确认移入发布垃圾桶？' : '确认将整个发布包移入发布垃圾桶？';
      if (window.confirm(message)) await run(() => apiClient.trashPublishingPackage(detail.package.id, { confirmation: true }), '发布包已移入垃圾桶');
      return;
    }
    if (action === 'restore-package') {
      await run(() => apiClient.restorePublishingPackage(detail.package.id), '发布包已恢复');
    }
  };

  const groups = groupPublishingPackages(packages);

  return (
    <Layout>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-tech-purple"><Send size={16} /> Publishing Center</div>
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
          <div className="mb-4 flex gap-2 overflow-x-auto border-b border-tech-border pb-3">
            {PUBLISH_FILTERS.map((item) => <button key={item.id} type="button" onClick={() => setParams(item.id === 'action' ? {} : { status: item.id })} className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ${status === item.id ? 'bg-blue-50 text-tech-blue' : 'text-tech-muted hover:bg-tech-surface'}`}>{item.label}</button>)}
          </div>
          <div className="mb-6 grid gap-3 border-b border-tech-border pb-5 md:grid-cols-3 xl:grid-cols-6">
            <FilterInput icon={<Search size={15} />} value={search} onChange={setSearch} placeholder="搜索标题/文案" />
            <select value={platform} onChange={(event) => setPlatform(event.target.value as PublishPlatform | '')} className="rounded-lg border border-tech-border bg-tech-surface px-3 py-2 text-sm text-tech-text"><option value="">全部平台</option>{PUBLISHING_PLATFORMS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
            <FilterInput value={sourceJobId} onChange={setSourceJobId} placeholder="源任务 ID" />
            <FilterInput value={version} onChange={setVersion} placeholder="版本号" type="number" />
            <FilterInput value={createdBy} onChange={setCreatedBy} placeholder="创建者 ID" />
            <button type="button" onClick={() => { setPlatform(''); setSourceJobId(''); setVersion(''); setCreatedBy(''); setSearch(''); }} className="rounded-lg border border-tech-border px-3 py-2 text-sm text-tech-muted hover:bg-tech-surface">清空筛选</button>
          </div>

          {error && <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</p>}
          {feedback && <p className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"><Check size={16} />{feedback}</p>}
          {loading ? <div className="flex justify-center py-20"><Loader2 className="animate-spin text-tech-blue" size={32} /></div> : groups.length === 0 ? <div className="border-y border-tech-border py-16 text-center"><p className="font-semibold text-tech-text">没有符合条件的发布包</p><p className="mt-2 text-sm text-tech-muted">可从已生成成片的作品详情加入发布中心。</p></div> : (
            <div className="space-y-6">
              {groups.map((group) => <section key={group.sourceJobId} className="overflow-hidden rounded-lg border border-tech-border bg-tech-surface"><header className="flex flex-col gap-1 border-b border-tech-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-semibold text-tech-text">{group.title}</h2><p className="text-xs text-tech-muted">源任务 {group.sourceJobId}</p></div><span className="text-sm text-tech-muted">{group.versions.length} 个版本</span></header><div className="divide-y divide-tech-border">{group.versions.map((detail) => <PackageRow key={detail.package.id} detail={detail} role={currentUser.role} expanded={expanded.has(detail.package.id)} onToggle={() => setExpanded((value) => { const next = new Set(value); next.has(detail.package.id) ? next.delete(detail.package.id) : next.add(detail.package.id); return next; })} onAction={handleTaskAction} />)}</div></section>)}
            </div>
          )}
        </>
      )}
    </Layout>
  );
}

function PackageRow({ detail, role, expanded, onToggle, onAction }: { detail: PublishingPackageDetail; role: 'admin' | 'publisher'; expanded: boolean; onToggle: () => void; onAction: (detail: PublishingPackageDetail, task: PublishTask, action: string) => Promise<void> }) {
  const pkg = detail.package;
  return <div><button type="button" onClick={onToggle} className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-tech-bg"><span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-purple-50 text-sm font-bold text-tech-purple">v{pkg.version}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-tech-text">{pkg.title}</span><AssetBadge health={pkg.assetHealth} />{pkg.state === 'trashed' && <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600">垃圾桶</span>}</div><p className="mt-1 text-xs text-tech-muted">{pkg.createdBy.displayName} · {new Date(pkg.createdAt).toLocaleString('zh-CN')}</p></div><div className="hidden flex-wrap gap-2 sm:flex">{detail.tasks.map((task) => <StatusBadge key={task.id} task={task} />)}</div>{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>{expanded && <div className="border-t border-tech-border bg-tech-bg/60 px-5 py-4"><div className="space-y-3">{detail.tasks.map((task) => <TaskRow key={task.id} detail={detail} task={task} role={role} onAction={onAction} />)}</div><details className="mt-4 border-t border-tech-border pt-4"><summary className="cursor-pointer text-sm font-medium text-tech-muted">审计记录（{detail.audit.length}）</summary><ol className="mt-3 space-y-2">{detail.audit.slice().reverse().map((event) => <li key={event.id} className="grid gap-1 text-xs sm:grid-cols-[10rem_1fr]"><time className="text-tech-muted">{new Date(event.createdAt).toLocaleString('zh-CN')}</time><span className="text-tech-text">{event.actor.displayName} · {event.action}{event.reason ? ` · ${event.reason}` : ''}</span></li>)}</ol></details></div>}</div>;
}

function TaskRow({ detail, task, role, onAction }: { detail: PublishingPackageDetail; task: PublishTask; role: 'admin' | 'publisher'; onAction: (detail: PublishingPackageDetail, task: PublishTask, action: string) => Promise<void> }) {
  const policy = PUBLISHING_PLATFORMS.find((item) => item.id === task.platform)!;
  const actions = getPublishingActionIds(detail, task, role);
  const labels: Record<string, string> = { 'copy-title': '复制标题', 'copy-description': '复制正文', 'copy-hashtags': '复制标签', 'copy-full': '复制全部', 'show-in-finder': 'Finder', 'open-platform': '打开平台', 'edit-content': '编辑文案', schedule: '修改排期', 'mark-published': '标记已发布', 'record-failure': '记录失败', cancel: '取消任务', restore: '恢复任务', 'create-version': '创建新版本', withdraw: '撤回本地状态', 'trash-package': '删除发布包', 'restore-package': '恢复发布包' };
  return <div className="rounded-lg border border-tech-border bg-tech-surface p-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-tech-text">{policy.label}</span><StatusBadge task={task} /><span className="text-xs text-tech-muted">revision {task.contentRevision} · {task.copySource === 'user_edited' ? '已编辑' : task.copySource === 'ai' ? 'AI' : '洗稿回退'}</span></div><p className="mt-2 font-medium text-tech-text">{task.title}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-tech-muted">{task.description}</p><p className="mt-2 text-sm text-tech-purple">{formatPublishingCopy(task).hashtags}</p>{task.scheduledAt && <p className="mt-2 text-xs text-tech-muted">计划 {new Date(task.scheduledAt).toLocaleString('zh-CN')}</p>}{task.publishedAt && <p className="mt-1 text-xs text-emerald-600">发布于 {new Date(task.publishedAt).toLocaleString('zh-CN')}</p>}{task.lastError && <p className="mt-2 text-sm text-red-600">{task.lastError}</p>}</div><div className="flex max-w-md flex-wrap gap-2 lg:justify-end">{actions.map((action) => <button key={action} type="button" title={labels[action]} onClick={() => void onAction(detail, task, action)} className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium ${action === 'mark-published' || action === 'open-platform' ? 'border-tech-blue bg-blue-50 text-tech-blue' : action === 'trash-package' || action === 'withdraw' ? 'border-red-200 text-red-600 hover:bg-red-50' : 'border-tech-border text-tech-muted hover:bg-tech-bg hover:text-tech-text'}`}>{action.startsWith('copy-') ? <Clipboard size={14} aria-label={labels[action]} /> : action === 'show-in-finder' ? <FolderOpen size={14} aria-label={labels[action]} /> : action === 'open-platform' ? <ExternalLink size={14} aria-label={labels[action]} /> : action === 'trash-package' ? <Trash2 size={14} aria-label={labels[action]} /> : action === 'restore-package' || action === 'restore' ? <RotateCcw size={14} aria-label={labels[action]} /> : labels[action]}</button>)}</div></div></div>;
}

function StatusBadge({ task }: { task: PublishTask }) { const colors = { scheduled: 'bg-cyan-50 text-cyan-700', ready: 'bg-blue-50 text-blue-700', published: 'bg-emerald-50 text-emerald-700', failed: 'bg-red-50 text-red-700', cancelled: 'bg-gray-100 text-gray-600' }; return <span className={`rounded-full px-2 py-1 text-xs font-medium ${colors[task.status]}`}>{PUBLISH_STATUS_LABELS[task.status]}</span>; }
function AssetBadge({ health }: { health: PublishingPackageDetail['package']['assetHealth'] }) { const text = health === 'healthy' ? '资产正常' : health === 'missing_cover' ? '缺少封面' : '视频异常'; return <span className={`rounded-full px-2 py-1 text-xs ${health === 'broken_video' ? 'bg-red-50 text-red-700' : health === 'missing_cover' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>{text}</span>; }
function FilterInput({ icon, value, onChange, placeholder, type = 'text' }: { icon?: ReactNode; value: string; onChange: (value: string) => void; placeholder: string; type?: string }) { return <label className="flex items-center gap-2 rounded-lg border border-tech-border bg-tech-surface px-3"><span className="text-tech-muted">{icon}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-tech-text outline-none" /></label>; }
