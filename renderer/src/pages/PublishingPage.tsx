import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PublishPreviewDialog } from '../components/PublishPreviewDialog.js';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  ExternalLink,
  FolderOpen,
  ImageIcon,
  RefreshCw,
  Search,
  Send,
  Trash2,
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { stripAnsi } from '../utils/display';
import { desktop } from '../electron-bridge';
import { apiClient, parseApiError } from '../services/api';
import { useOperatorStore } from '../store/operator';
import type { PublishTask, PublishingListFilters, PublishingListStatus, PublishingPackageDetail, PublishingPackagePreview } from '../types';
import {
  formatPublishingCopy,
  formatDueNotification,
  getAutoPublishConfirmLabel,
  publishingPlatformLabel,
  getPublishingActionIds,
  getPublishingAutoPublishBlocker,
  getPublishingAutoPublishHint,
  publishingNextStep,
  publishingOpenPlatformTarget,
  groupPublishingPackages,
  PUBLISH_FILTERS,
  PUBLISH_STATUS_LABELS,
  PUBLISHING_PLATFORMS,
  PUBLISH_CHANNELS,
  channelContentTypes,
  channelEmptyHint,
  contentTypeAfterChannelChange,
  countChannelContentTypes,
  countChannelPackages,
  countStatusesInChannel,
  findPublishChannel,
  selectChannelPackages,
  type PublishChannelId,
} from '../utils/publishing';
import type { PackageContentType } from '../types';
import { PublishingActionDialog } from '../features/publishing/PublishingActionDialog';
import { PublishingChannelTabs } from '../components/PublishingChannelTabs';
import { RuntimeOverviewStrip } from '../components/RuntimeOverviewStrip';
import { PlatformLogo } from '../components/ui/PlatformLogo';
import { EmptyState } from '../components/ui/EmptyState';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';

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
  const navigate = useNavigate();
  const requestedStatus = params.get('status') as PublishingListStatus | null;
  const status = PUBLISH_FILTERS.some((item) => item.id === requestedStatus) ? requestedStatus! : 'action';
  // 一级「渠道」：与状态页签一样持久化在 URL 里（刷新/返回/分享链接都能还原同一视图）。
  // 非法值回落到缺省渠道，而不是抛错 —— 旧书签不该把页面打不开。
  const requestedChannel = params.get('channel');
  const channelId: PublishChannelId = PUBLISH_CHANNELS.some((item) => item.id === requestedChannel)
    ? (requestedChannel as PublishChannelId)
    : 'douyin';
  const channel = findPublishChannel(channelId);
  // 二级「内容类型」子页签（`''` = 全部）。它只在真实数据多于一种时才渲染 —— 但 URL 里
  // 可以留着一个当前不存在的值（比如包被删了），所以下面还要按实际类型收窄一次。
  const requestedContentType = params.get('contentType');
  const contentTypeParam: PackageContentType | '' = requestedContentType === 'note'
    || requestedContentType === 'video'
    || requestedContentType === 'article'
    ? requestedContentType
    : '';
  const [sourceJobId, setSourceJobId] = useState('');
  const [version, setVersion] = useState('');
  const [createdBy, setCreatedBy] = useState('');
  const [search, setSearch] = useState('');
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [packages, setPackages] = useState<PublishingPackageDetail[]>([]);
  /** 渠道页签的数字（来自不带状态筛选的那次请求）。 */
  const [channelCounts, setChannelCounts] = useState<Record<PublishChannelId, number>>({
    douyin: 0,
    xiaohongshu: 0,
    toutiao: 0,
    'wechat-mp': 0,
    other: 0,
  });
  /** 同一份「不带状态筛选」的结果，用来算当前渠道的状态页签计数。 */
  const [allForCounts, setAllForCounts] = useState<PublishingPackageDetail[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const loadSequence = useRef(0);
  const actionLock = useRef(false);

  // ── Action dialog state ──
  // 「发布图文到抖音」必经预览：先取包级预览（它产出 previewRevision），确认后才真正提交。
  const [publishPreview, setPublishPreview] = useState<{
    open: boolean;
    busy: boolean;
    preview: PublishingPackagePreview | null;
    taskId: string;
    /** `publish` = 必经确认（可提交）；`preview` = 只读查看（无确认按钮）。 */
    mode: 'preview' | 'publish';
    /** 成片流的绝对 URL：相对路径在 Electron 里会打到 Vite 的开发代理（错误的后端）。 */
    videoUrl: string;
    /**
     * 小红书专用：`true` = 只填到草稿（服务端强制不点发布）。
     * 由「填写到小红书（不提交）」这个动作置位，随预览态一起传到确认提交那一步。
     */
    dryRun: boolean;
  }>({ open: false, busy: false, preview: null, taskId: '', mode: 'preview', videoUrl: '', dryRun: false });
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

  /**
   * 改视图只动该动的参数：此前状态页签用 `setParams({status})` 整体替换 query，
   * 加了渠道之后那会把 `?channel=` 一起冲掉（点一下状态就跳回抖音）。
   * 缺省值不写进 URL，链接保持干净。
   */
  const setView = useCallback((next: {
    channel?: PublishChannelId;
    status?: PublishingListStatus;
    contentType?: PackageContentType | '';
  }) => {
    const merged = new URLSearchParams(params);
    if (next.channel !== undefined) merged.set('channel', next.channel);
    if (next.status !== undefined) merged.set('status', next.status);
    if (next.contentType !== undefined) {
      if (next.contentType) merged.set('contentType', next.contentType);
      else merged.delete('contentType');
    }
    if (merged.get('channel') === 'douyin') merged.delete('channel');
    if (merged.get('status') === 'action') merged.delete('status');
    setParams(merged);
  }, [params, setParams]);

  // ⚠️ 渠道**不**在这里下发给服务端：渠道 = 平台，而服务端的 `platform` 是单值过滤，
  // 表达不了「其它平台（视频号 + B站）」这种多平台页签；`contentType` 过滤同理被内容类型
  // 子页签取代。所以这里只保留状态（语义只有服务端一份）与那几个正交筛选，
  // 渠道维度由下面的 `selectChannelPackages()` 在客户端收窄（见 utils/publishing.ts 顶部说明）。
  const filters = useMemo<PublishingListFilters>(() => ({
    status,
    ...(sourceJobId.trim() ? { sourceJobId: sourceJobId.trim() } : {}),
    ...(Number(version) > 0 ? { version: Number(version) } : {}),
    ...(createdBy.trim() ? { createdBy: createdBy.trim() } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  }), [createdBy, search, sourceJobId, status, version]);

  // 计数用的那一次请求**不带 status**：否则「失败」在「待处理」视图里永远显示 0
  // （这就是改动前那版「局部计数」的毛病）。渠道/内容类型同样不在服务端筛 ——
  // 这份结果必须覆盖全部渠道，否则别的渠道的包数会跟着当前视图一起塌掉。
  const countFilters = useMemo<PublishingListFilters>(() => ({
    status: 'all',
    ...(sourceJobId.trim() ? { sourceJobId: sourceJobId.trim() } : {}),
    ...(Number(version) > 0 ? { version: Number(version) } : {}),
    ...(createdBy.trim() ? { createdBy: createdBy.trim() } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  }), [createdBy, search, sourceJobId, version]);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!currentUser) {
      setPackages([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [result, all] = await Promise.all([
        apiClient.listPublishingPackages(filters),
        apiClient.listPublishingPackages(countFilters),
      ]);
      if (sequence === loadSequence.current) {
        setPackages(result);
        setChannelCounts(countChannelPackages(all));
        setAllForCounts(all);
      }
    } catch (requestError) {
      if (sequence === loadSequence.current) setError(parseApiError(requestError).message);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [countFilters, currentUser, filters]);

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
      // 封面只对**视频 / 文章**包有意义；图文包的资产是图片，对它弹「缺少封面」纯属虚惊
      // （2026-09-21 顺手修：小红书图文包点「打开平台」时会先被问一句莫名其妙的封面）。
      if (!detail.package.coverPath && (detail.package.contentType ?? 'video') !== 'note') {
        const confirmed = await showDialog({ type: 'confirm', title: '缺少封面', description: '当前发布包没有封面，仍然打开平台吗？', tone: 'warning' });
        if (!confirmed) return;
      }
      // ⚠️ 开哪个地址由**内容类型 + 平台**决定：小红书图文要去的是草稿箱所在的创作中心首页，
      // 而不是平台表里的「发布新笔记」页（见 `publishingOpenPlatformTarget` 的说明）。
      const target = publishingOpenPlatformTarget(detail, task);
      try {
        const result = await desktop.openExternal(target.url);
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
    if (action === 'preview') {
      await openPackagePreview(detail.package.id, 'preview', '');
      return;
    }
    if (action === 'download-article') {
      // 降级通路：把包内 article.html 存成本地文件（用户可粘进头条编辑器）。
      // 走带会话的 blob 请求 —— `<a href>` 不会带 `X-Local-Session` 头。
      const blob = await run(() => apiClient.getPublishingArticleHtml(detail.package.id), '');
      if (blob) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `article-v${detail.package.version}.html`;
        anchor.click();
        URL.revokeObjectURL(url);
      }
      return;
    }

    // 小红书两个动作都走「必经预览」：`fill-xhs` 带 `dryRun`（服务端强制不点发布），
    // `submit-xhs` 不带（由包上的 `xhsOptions.submit` 决定，那份声明已进 previewRevision）。
    if (action === 'fill-xhs' || action === 'submit-xhs') {
      const blocker = getPublishingAutoPublishBlocker(detail, task);
      if (blocker) {
        setError(blocker);
        return;
      }
      await openPackagePreview(detail.package.id, 'publish', task.id, action === 'fill-xhs');
      return;
    }
    if (action === 'auto-publish') {
      const blocker = getPublishingAutoPublishBlocker(detail, task);
      if (blocker) {
        setError(blocker);
        return;
      }
      await openPackagePreview(detail.package.id, 'publish', task.id);
      return;
    }
    if (action === 'submit-code') {
      const code = await showDialog<string>({
        type: 'prompt',
        title: '提交短信验证码',
        inputLabel: '填写手机收到的验证码',
        inputPlaceholder: '如 123456',
      });
      if (!code?.trim()) return;
      await run(() => apiClient.submitPublishingAutoPublishCode(task.id, code.trim()), '验证码已提交');
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

  /** 打开预览弹窗：先取包级预览，视频包再把成片流解析成绝对 URL。 */
  const openPackagePreview = async (
    packageId: string,
    mode: 'preview' | 'publish',
    taskId: string,
    dryRun = false,
  ) => {
    const preview = await run(() => apiClient.getPublishingPackagePreview(packageId), '');
    if (!preview) return;
    const videoUrl = preview.package.contentType === 'note'
      ? ''
      : await apiClient.getJobVideoStreamUrl(preview.package.sourceJobId).catch(() => '');
    setPublishPreview({ open: true, busy: false, preview, taskId, mode, videoUrl, dryRun });
  };

  const confirmPublish = async () => {
    const { preview, taskId, dryRun } = publishPreview;
    if (!preview) return;
    setPublishPreview((current) => ({ ...current, busy: true }));
    // 成功提示也要按平台取文案（头条任务说「抖音后台」是误导）。
    const platform = preview.tasks.find((item) => item.id === taskId)?.platform
      ?? preview.tasks[0]?.platform
      ?? 'douyin';
    const task = await run(
      () => apiClient.autoPublishPublishingTask(taskId, preview.previewRevision, dryRun ? { dryRun: true } : {}),
      dryRun
        ? `已填写到${publishingPlatformLabel(platform)}草稿，请到 App 里核对后自行发布`
        : `已提交，请在${publishingPlatformLabel(platform)}后台确认后点「标记已发布」`,
    );
    setPublishPreview({ open: false, busy: false, preview: null, taskId: '', mode: 'preview', videoUrl: '', dryRun: false });
    // 提交后落在 awaiting_code 时，直接把验证码入口摆出来（图文通路当前不触发，见 spec §7）
    if (task?.autoPublish?.status === 'awaiting_code') {
      const code = await showDialog<string>({
        type: 'prompt',
        title: '提交短信验证码',
        inputLabel: '抖音要求短信验证，请填写手机收到的验证码',
        inputPlaceholder: '如 123456',
      });
      if (code?.trim()) {
        await run(() => apiClient.submitPublishingAutoPublishCode(task.id, code.trim()), '验证码已提交');
      }
    }
  };

  // ── 渠道维度在客户端收窄（服务端只管 status 与那几个正交筛选）──
  // 子页签只在**实际出现多于一种内容类型**时才渲染；URL 里那个值若在当前渠道已经不存在
  // （包被删了、或换了渠道），就按「全部」处理 —— 否则会出现一屏空列表却看不出原因。
  const contentTypes = useMemo(() => channelContentTypes(allForCounts, channelId), [allForCounts, channelId]);
  const contentTypeCounts = useMemo(() => countChannelContentTypes(allForCounts, channelId), [allForCounts, channelId]);
  const activeContentType: PackageContentType | '' = contentTypeParam && contentTypes.includes(contentTypeParam)
    ? contentTypeParam
    : '';
  const visiblePackages = useMemo(
    () => selectChannelPackages(packages, channelId, activeContentType),
    [packages, channelId, activeContentType],
  );
  const groups = groupPublishingPackages(visiblePackages);
  const statusCounts = useMemo(
    () => countStatusesInChannel(allForCounts, channelId, activeContentType),
    [allForCounts, channelId, activeContentType],
  );
  const hasExtraFilters = Boolean(
    sourceJobId.trim() || version.trim() || createdBy.trim() || search.trim(),
  );
  /** 该渠道下的包数（不含垃圾桶）：用来区分「这个渠道真的没有包」与「只是当前状态/筛选下没有」。 */
  const channelTotal = channelCounts[channelId] ?? 0;

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
      <PageHeader
        title="发布中心"
        description={
          <>
            按渠道整理交付包。抖音图文、小红书图文与头条文章可自动提交，公众号文章仅存草稿；提交前必经预览。视频与其它平台由你手动发布。
          </>
        }
        actions={
          <Button variant="outline" onClick={() => void load()} disabled={loading || !currentUser}>
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
            刷新
          </Button>
        }
      />

      {/*
        运行环境概览条（spec §6.1）。全部来自**零副作用**的免费检查，打开发布中心即可见（AC-1）；
        会开浏览器的深检留在设置页手动触发 —— 它要与发布抢同一个浏览器 profile。
      */}
      <RuntimeOverviewStrip onOpenSettings={() => navigate('/settings?section=runtime')} />

      {/* 说明：本页副标题曾写作「人工交付」，而 2026-09-21 之后这里已能自动提交
          三条通路 —— 把「自动发布」说成「人工交付」会让用户低估小红书的账号风险。 */}

      {!desktop.capabilities.showNotification && <div className="mb-4 flex items-start gap-2 border-l-4 border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning"><AlertTriangle size={17} className="mt-0.5 shrink-0" />浏览器模式不会显示系统排期通知，任务状态仍会正常更新。</div>}
      {!currentUser ? (
        <div className="border-y border-line py-16 text-center"><p className="text-lg font-semibold text-ink">本机操作者未就绪</p><p className="mt-2 text-sm text-ink-muted">请重试后再查看发布任务。</p></div>
      ) : (
        <>
          {/* 一级「渠道」= 平台；二级「内容类型」子页签只在真的有多种类型时出现 */}
          <PublishingChannelTabs
            active={channelId}
            counts={channelCounts}
            contentTypes={contentTypes}
            contentTypeCounts={contentTypeCounts}
            activeContentType={activeContentType}
            onSelect={(next) => {
              // 换渠道时顺手把内容类型子页签收进合法范围：新渠道里还有这个类型就留着，
              // 没有就回到「全部」—— 与旧版「换渠道清掉平台筛选」同一个意图：不制造必然筛空的视图。
              setView({ channel: next, contentType: contentTypeAfterChannelChange(allForCounts, next, activeContentType) });
            }}
            onSelectContentType={(next) => setView({ contentType: next })}
          />
          {/* Status filter chips with counts（计数取自不带状态筛选的那次请求，不再只数当前视图） */}
          <div className="mb-3 flex gap-2 overflow-x-auto border-b border-line pb-3">
            {PUBLISH_FILTERS.map((item) => {
              const count = statusCounts[item.id];
              return (
                <button key={item.id} type="button" onClick={() => setView({ status: item.id })} className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ${status === item.id ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-panel'}`}>
                  {item.label}
                  {count > 0 && <span className="ml-1.5 text-xs opacity-70">{count}</span>}
                </button>
              );
            })}
          </div>
          {/* Primary filters: always visible */}
          <div className="mb-3 grid gap-3 md:grid-cols-2">
            <FilterInput icon={<Search size={15} />} value={search} onChange={setSearch} placeholder="搜索标题/文案" />
            {/* 平台下拉已随改版移除：一级页签本身就是平台，再给一个平台筛选只会出现
                「在抖音页签里筛今日头条」这种自相矛盾的操作（旧版只在单平台渠道才隐藏它）。 */}
          </div>
          {/* More filters toggle */}
          <div className="mb-3">
            <button
              type="button"
              onClick={() => setShowMoreFilters((v) => !v)}
              className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors"
            >
              {showMoreFilters ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              更多筛选
            </button>
          </div>
          {/* Extended filters: collapsed by default */}
          {showMoreFilters && (
            <div className="mb-6 grid gap-3 border-t border-line pt-4 md:grid-cols-3">
              <FilterInput value={sourceJobId} onChange={setSourceJobId} placeholder="源任务 ID" />
              <FilterInput value={version} onChange={setVersion} placeholder="版本号" type="number" />
              <FilterInput value={createdBy} onChange={setCreatedBy} placeholder="创建者 ID" />
              <button type="button" onClick={() => { setSourceJobId(''); setVersion(''); setCreatedBy(''); setSearch(''); }} className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-panel self-end">清空筛选</button>
            </div>
          )}

          {error && groups.length > 0 && <p className="mb-4 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">{error}</p>}
          {feedback && <p className="mb-4 flex items-center gap-2 rounded-lg border border-success-line bg-success-soft px-4 py-3 text-sm text-success"><Check size={16} />{feedback}</p>}
          {loading && groups.length === 0 ? (
            /* 骨架屏（改造前全站只有整页转圈，内容到达时整块跳变） */
            <PackageListSkeleton />
          ) : error && groups.length === 0 ? (
            /*
             * ⚠️ 错误态与空态**必须互斥**。改造前这里只判断 `groups.length === 0`，
             * 于是后端挂掉时会同时显示「加载失败」和「还没有发布包」—— 用户会以为
             * 自己的发布包没了，而不是后端没连上。同一个写法在 JobListPage /
             * TrashPage / CollectionListPage 上都有（见审查报告 S4）。
             */
            <EmptyState
              icon={AlertTriangle}
              title="发布包列表加载失败"
              description={error}
              action={<Button variant="outline" onClick={() => void load()}>重试</Button>}
            />
          ) : groups.length === 0 ? (
            <EmptyState
              icon={Send}
              title={
                hasExtraFilters
                  ? '没有符合条件的发布包'
                  : channelTotal > 0
                    ? `${channel.label}下这个状态下没有发布包`
                    : `${channel.label}里还没有发布包`
              }
              description={
                hasExtraFilters
                  ? '换个筛选条件，或点「清空筛选」重来。'
                  : channelTotal > 0
                    ? '换个状态页签，或点「全部」看看这个渠道下的所有发布包。'
                    : channelEmptyHint(channelId)
              }
              action={
                hasExtraFilters ? (
                  <Button variant="outline" onClick={() => { setSourceJobId(''); setVersion(''); setCreatedBy(''); setSearch(''); }}>
                    清空筛选
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-6 pb-20 md:pb-0">
              {groups.map((group) => (
                <section key={group.sourceJobId} className="overflow-hidden rounded-xl border border-line bg-panel">
                  <header className="flex flex-col gap-1 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <h2 className="min-w-0 truncate font-display text-lg font-semibold text-ink">{group.title}</h2>
                    <span className="shrink-0 text-sm tabular text-ink-muted">{group.versions.length} 个版本</span>
                  </header>
                  <div className="divide-y divide-line">
                    {group.versions.map((detail) => <PackageRow key={detail.package.id} detail={detail} sourceJobId={group.sourceJobId} role={currentUser.role} expanded={expanded.has(detail.package.id)} busy={busyAction} onToggle={() => setExpanded((value) => { const next = new Set(value); next.has(detail.package.id) ? next.delete(detail.package.id) : next.add(detail.package.id); return next; })} onAction={handleTaskAction} />)}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {/* Mobile bottom action bar */}
      {mobileBarActions.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 border-t border-line bg-panel px-4 py-3 md:hidden">
          <div className="flex gap-2">
            {mobileBarActions.map(({ label, action, detail, task }) => (
              <button
                key={action}
                type="button"
                disabled={busyAction}
                onClick={() => void handleTaskAction(detail, task, action)}
                className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-medium disabled:opacity-50 ${
                  action === 'mark-published' || action === 'open-platform'
                    ? 'bg-accent text-on-accent'
                    : 'border border-line text-ink'
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
      <PublishPreviewDialog
        open={publishPreview.open}
        preview={publishPreview.preview}
        busy={publishPreview.busy}
        videoUrl={publishPreview.videoUrl}
        confirmLabel={getAutoPublishConfirmLabel(
          // 按**这次要提交的那个任务**的平台取文案：头条文章任务不该显示「确认发布到抖音」。
          publishPreview.preview?.tasks.find((task) => task.id === publishPreview.taskId)?.platform
            ?? publishPreview.preview?.tasks[0]?.platform
            ?? 'douyin',
        )}
        onClose={() => setPublishPreview({ open: false, busy: false, preview: null, taskId: '', mode: 'preview', videoUrl: '', dryRun: false })}
        onConfirm={publishPreview.mode === 'publish' ? () => void confirmPublish() : undefined}
      />
    </Layout>
  );
}

export function PackageRow({ detail, sourceJobId, role, expanded, busy, onToggle, onAction }: { detail: PublishingPackageDetail; sourceJobId: string; role: 'admin' | 'publisher'; expanded: boolean; busy: boolean; onToggle: () => void; onAction: (detail: PublishingPackageDetail, task: PublishTask, action: string) => Promise<void> }) {
  const pkg = detail.package;
  return <div><button type="button" onClick={onToggle} className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-elevated"><CoverThumbnail packageId={pkg.id} title={pkg.title} hasCover={Boolean(pkg.coverPath)} /><span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ai-soft text-sm font-bold text-ai">v{pkg.version}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">{pkg.title}</span><AssetBadge health={pkg.assetHealth} />{pkg.state === 'trashed' && <span className="rounded-full bg-elevated px-2 py-1 text-xs text-ink-muted">垃圾桶</span>}</div><p className="mt-1 text-xs text-ink-muted">{pkg.createdBy.displayName} · {new Date(pkg.createdAt).toLocaleString('zh-CN')}</p><p className="mt-1 text-xs font-medium text-accent">下一步：{publishingNextStep(detail)}</p></div><div className="hidden flex-wrap gap-2 sm:flex">{detail.tasks.map((task) => <StatusBadge key={task.id} task={task} />)}</div>{expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>{expanded && <div className="border-t border-line bg-canvas/60 px-5 py-4"><div className="space-y-3">{detail.tasks.map((task) => <TaskRow key={task.id} detail={detail} task={task} role={role} busy={busy} onAction={onAction} />)}</div><details className="mt-4 border-t border-line pt-4"><summary className="cursor-pointer text-sm font-medium text-ink-muted">审计记录（{detail.audit.length}）</summary><ol className="mt-3 space-y-2">{detail.audit.slice().reverse().map((event) => <li key={event.id} className="grid gap-1 text-xs sm:grid-cols-[10rem_1fr]"><time className="text-ink-muted">{new Date(event.createdAt).toLocaleString('zh-CN')}</time><span className="text-ink">{event.actor.displayName} · {event.action}{event.reason ? ` · ${stripAnsi(event.reason)}` : ''}</span></li>)}</ol></details>{sourceJobId && <p className="mt-3 text-xs text-ink-muted">源任务 {sourceJobId}</p>}</div>}</div>;
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
  return <span className="flex h-16 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-canvas text-ink-muted">{url ? <img src={url} alt={`${title}封面`} className="h-full w-full object-cover" /> : <ImageIcon size={18} aria-hidden="true" />}</span>;
}


export function TaskRow({ detail, task, role, busy, onAction }: { detail: PublishingPackageDetail; task: PublishTask; role: 'admin' | 'publisher'; busy: boolean; onAction: (detail: PublishingPackageDetail, task: PublishTask, action: string) => Promise<void> }) {
  const policy = PUBLISHING_PLATFORMS.find((item) => item.id === task.platform)!;
  const actions = getPublishingActionIds(detail, task, role);
  const labels: Record<string, string> = { 'copy-title': '复制标题', 'copy-description': '复制正文', 'copy-hashtags': '复制标签', 'copy-full': '复制全部', 'show-in-finder': 'Finder', 'open-platform': publishingOpenPlatformTarget(detail, task).label, 'edit-content': '编辑文案', schedule: '修改排期', 'mark-published': '标记已发布', 'record-failure': '记录失败', cancel: '取消任务', restore: '恢复任务', 'create-version': '创建新版本', withdraw: '撤回本地状态', 'trash-package': '删除发布包', 'restore-package': '恢复发布包', 'auto-publish': task.platform === 'wechat_mp' ? '提交到公众号草稿箱' : task.platform === 'toutiao' ? '提交到头条号' : '发布图文到抖音', 'submit-code': '提交验证码', preview: '预览', 'download-article': '下载文章 HTML', 'fill-xhs': '填写到小红书（不提交）', 'submit-xhs': '发布到小红书' };
  return <div className="rounded-lg border border-line bg-panel p-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><PlatformLogo platform={task.platform} size="sm" /><span className="font-semibold text-ink">{policy.label}</span><StatusBadge task={task} /><span className="text-xs text-ink-muted">版本 {task.contentRevision} · {task.copySource === 'user_edited' ? '已编辑' : task.copySource === 'ai' ? 'AI' : '洗稿回退'}</span></div><p className="mt-2 font-medium text-ink">{task.title}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-ink-muted">{task.description}</p><p className="mt-2 text-sm text-ai">{formatPublishingCopy(task).hashtags}</p>{task.scheduledAt && <p className="mt-2 text-xs text-ink-muted">计划 {new Date(task.scheduledAt).toLocaleString('zh-CN')}</p>}{task.publishedAt && <p className="mt-1 text-xs text-success">发布于 {new Date(task.publishedAt).toLocaleString('zh-CN')}</p>}{task.lastError && <p className="mt-2 text-sm text-danger">{task.lastError}</p>}<AutoPublishHint task={task} /></div><div className="flex max-w-md flex-wrap gap-1.5 lg:justify-end">{actions.map((action) => {
    /*
     * 改用 Button 原语。改造前这里是 148 个手写 button 中的一处，且：
     *   - 点击目标 ≈26px 高（`px-2.5 py-1.5` + 14px 图标），低于桌面 32px 下限，
     *     而「复制标题/正文/标签」是高频操作；
     *   - 图标按钮的 `aria-label` 挂在 <svg> 上而不是 <button> 上，读屏拿不到按钮名。
     */
    const variant = action === 'mark-published' || action === 'open-platform' || action === 'auto-publish'
      ? 'accent'
      : action === 'trash-package' || action === 'withdraw'
        ? 'subtleDanger'
        : 'outline';
    const icon = action.startsWith('copy-') ? <Clipboard size={14} aria-hidden="true" />
      : action === 'show-in-finder' ? <FolderOpen size={14} aria-hidden="true" />
        : action === 'open-platform' ? <ExternalLink size={14} aria-hidden="true" />
          : action === 'trash-package' ? <Trash2 size={14} aria-hidden="true" />
            : null;
    return (
      <Button
        key={action}
        size={icon ? 'icon' : 'sm'}
        variant={variant}
        title={labels[action]}
        aria-label={labels[action]}
        disabled={busy}
        onClick={() => void onAction(detail, task, action)}
      >
        {icon ?? labels[action]}
      </Button>
    );
  })}</div></div></div>;
}

export function AutoPublishHint({ task }: { task: PublishTask }) {
  const hint = getPublishingAutoPublishHint(task);
  if (!hint) return null;
  const tone = task.autoPublish?.status === 'failed'
    ? 'bg-danger-soft text-danger'
    : task.autoPublish?.status === 'succeeded'
      ? 'bg-success-soft text-success'
      : 'bg-warning-soft text-warning';
  return <p className={`mt-2 rounded-lg px-3 py-2 text-xs ${tone}`}>{hint}</p>;
}

export function StatusBadge({ task }: { task: PublishTask }) { const colors = { scheduled: 'bg-running-soft text-running', ready: 'bg-info-soft text-info', published: 'bg-success-soft text-success', failed: 'bg-danger-soft text-danger', cancelled: 'bg-elevated text-ink-muted' }; return <span className={`rounded-full px-2 py-1 text-xs font-medium ${colors[task.status]}`}>{PUBLISH_STATUS_LABELS[task.status]}</span>; }
/**
 * 资产健康徽章。
 *
 * 改造前这里只有 healthy / missing_cover 两个分支 + 一个兜底，而
 * `PublishAssetHealth` 有**四个**取值（见 types/index.ts）——于是 `missing_images`
 * （图文包缺图，是可达状态：frames 一张静帧都没有时不报错、只标 missing_images）
 * 掉进兜底，显示成**绿色的「视频异常」**：既说错了原因（图文包没有视频），
 * 又用绿色传达了「没事」。权威文案在 PublishPreviewDialog 里是「缺少图片」+ 红色。
 *
 * 改成穷尽的 Record：类型系统会保证四个取值都被覆盖，以后新增状态会**编译报错**，
 * 而不是再静默掉进兜底。
 */
const ASSET_HEALTH_BADGE: Record<
  PublishingPackageDetail['package']['assetHealth'],
  { text: string; tone: string }
> = {
  healthy: { text: '资产正常', tone: 'bg-success-soft text-success' },
  missing_cover: { text: '缺少封面', tone: 'bg-warning-soft text-warning' },
  missing_images: { text: '缺少图片', tone: 'bg-danger-soft text-danger' },
  broken_video: { text: '视频异常', tone: 'bg-danger-soft text-danger' },
};

export function AssetBadge({ health }: { health: PublishingPackageDetail['package']['assetHealth'] }) {
  const { text, tone } = ASSET_HEALTH_BADGE[health];
  return <span className={`rounded-full px-2 py-1 text-xs ${tone}`}>{text}</span>;
}
function FilterInput({ icon, value, onChange, placeholder, type = 'text' }: { icon?: ReactNode; value: string; onChange: (value: string) => void; placeholder: string; type?: string }) { return <label className="flex items-center gap-2 rounded-lg border border-line-ui bg-well px-3"><span className="text-ink-muted">{icon}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-ink outline-none" /></label>; }
function toLocalDateTimeValue(value: string): string { const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }

/**
 * 发布包列表的骨架屏。
 *
 * 改造前全站**没有任何骨架屏**：加载态一律是整页居中的 `animate-spin`，
 * 内容到达时整块插入 → 布局跳变、滚动位置丢失。骨架屏的行高按真实行取，
 * 让「正在加载」和「加载完成」占同样的空间。
 */
function PackageListSkeleton() {
  const rows = [0, 1, 2];
  return (
    <div className="space-y-6" aria-busy="true" aria-label="正在加载发布包">
      {[0, 1].map((section) => (
        <section key={section} className="overflow-hidden rounded-xl border border-line bg-panel">
          <header className="flex items-center justify-between border-b border-line px-5 py-4">
            <span className="h-5 w-48 rounded bg-elevated animate-pulse" />
            <span className="h-4 w-16 rounded bg-elevated animate-pulse" />
          </header>
          <div className="divide-y divide-line">
            {rows.map((row) => (
              <div key={row} className="flex items-center gap-4 px-5 py-4">
                <span className="h-16 w-11 shrink-0 rounded-md bg-elevated animate-pulse" />
                <div className="min-w-0 flex-1 space-y-2">
                  <span className="block h-4 w-1/3 rounded bg-elevated animate-pulse" />
                  <span className="block h-3 w-2/3 rounded bg-elevated animate-pulse" />
                </div>
                <span className="h-7 w-24 shrink-0 rounded-lg bg-elevated animate-pulse" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
