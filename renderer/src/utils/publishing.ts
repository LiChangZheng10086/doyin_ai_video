import type {
  CreatePublishingPackageInput,
  DueNotification,
  HyperframesVideoOutput,
  LocalUserRole,
  PackageContentType,
  PlatformCopy,
  PublishCopySource,
  PublishPlatform,
  PublishTask,
  PublishingListStatus,
  PublishingPackageDetail,
  PublishingPreview,
} from '../types/index.js';
import { stripAnsi } from './display.js';

export const PUBLISHING_PLATFORMS: Array<{
  id: PublishPlatform;
  label: string;
  titleMax: number;
  descriptionMax: number;
  hashtagMax: number;
  hashtagLengthMax: number;
  creatorUrl: string;
}> = [
  { id: 'douyin', label: '抖音', titleMax: 55, descriptionMax: 1000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://creator.douyin.com/creator-micro/content/upload' },
  { id: 'xiaohongshu', label: '小红书', titleMax: 20, descriptionMax: 1000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://creator.xiaohongshu.com/publish/publish' },
  { id: 'wechat_channels', label: '微信视频号', titleMax: 30, descriptionMax: 1000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://channels.weixin.qq.com/platform/post/create' },
  { id: 'bilibili', label: '哔哩哔哩', titleMax: 80, descriptionMax: 2000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://member.bilibili.com/platform/upload/video/frame' },
  { id: 'wechat_mp', label: '微信公众号', titleMax: 32, descriptionMax: 120, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://mp.weixin.qq.com/' },
  // 今日头条（文章通路）：标题 2~30 字是平台硬限制，这张表只放上限；
  // `description` 在头条文章语境里是正文文本，上限 = 服务端 `TOUTIAO_ARTICLE_LIMITS.bodyChars`。
  { id: 'toutiao', label: '今日头条', titleMax: 30, descriptionMax: 20000, hashtagMax: 10, hashtagLengthMax: 20, creatorUrl: 'https://mp.toutiao.com/profile_v4/graphic/publish' },
];

export const PUBLISH_FILTERS: Array<{ id: PublishingListStatus; label: string }> = [
  { id: 'action', label: '待处理' },
  { id: 'all', label: '全部' },
  { id: 'ready', label: '待发布' },
  { id: 'scheduled', label: '已排期' },
  { id: 'published', label: '已发布' },
  { id: 'failed', label: '失败' },
  { id: 'cancelled', label: '已取消' },
  { id: 'broken', label: '资产异常' },
  { id: 'trash', label: '发布垃圾桶' },
];

export type PublishingWizardStep = 'asset' | 'platforms' | 'copy' | 'schedule' | 'confirm';

export interface PublishingWizardDraft {
  copy: PlatformCopy;
  copySource: PublishCopySource;
  scheduledAt: string;
}

export interface PublishingWizardFieldError {
  platform: PublishPlatform;
  field: keyof PlatformCopy;
  actual: number;
  limit: number;
  message: string;
}

export interface PublishingWizardState {
  step: PublishingWizardStep;
  selectedPlatforms: PublishPlatform[];
  preview?: PublishingPreview;
  drafts: Partial<Record<PublishPlatform, PublishingWizardDraft>>;
  platformError?: string;
  fieldErrors: PublishingWizardFieldError[];
}

export type PublishingWizardAction =
  | { type: 'advance' }
  | { type: 'back' }
  | { type: 'toggle-platform'; platform: PublishPlatform }
  | { type: 'load-preview'; preview: PublishingPreview; step?: PublishingWizardStep }
  | { type: 'edit-draft'; platform: PublishPlatform; field: keyof PlatformCopy; value: string | string[] }
  | { type: 'replace-draft'; platform: PublishPlatform; draft: PublishingWizardDraft }
  | { type: 'set-schedule'; platform: PublishPlatform; value: string };

const WIZARD_STEPS: PublishingWizardStep[] = ['asset', 'platforms', 'copy', 'schedule', 'confirm'];

export function createPublishingWizardState(
  selectedPlatforms: PublishPlatform[] = [],
): PublishingWizardState {
  return {
    step: 'asset',
    selectedPlatforms: [...selectedPlatforms],
    drafts: {},
    fieldErrors: [],
  };
}

export function publishingWizardReducer(
  state: PublishingWizardState,
  action: PublishingWizardAction,
): PublishingWizardState {
  if (action.type === 'toggle-platform') {
    const selected = state.selectedPlatforms.includes(action.platform)
      ? state.selectedPlatforms.filter((platform) => platform !== action.platform)
      : [...state.selectedPlatforms, action.platform];
    return { ...state, selectedPlatforms: selected, platformError: undefined };
  }
  if (action.type === 'load-preview') {
    const drafts = { ...state.drafts };
    for (const platform of state.selectedPlatforms) {
      const generated = action.preview.copies[platform];
      if (generated) {
        drafts[platform] = {
          copy: {
            title: generated.title,
            description: generated.description,
            hashtags: [...generated.hashtags],
          },
          copySource: generated.copySource,
          scheduledAt: drafts[platform]?.scheduledAt ?? '',
        };
      }
    }
    return {
      ...state,
      preview: action.preview,
      drafts,
      step: action.step ?? state.step,
      platformError: undefined,
      fieldErrors: [],
    };
  }
  if (action.type === 'edit-draft') {
    const draft = state.drafts[action.platform];
    if (!draft) return state;
    return {
      ...state,
      drafts: {
        ...state.drafts,
        [action.platform]: {
          ...draft,
          copy: { ...draft.copy, [action.field]: action.value } as PlatformCopy,
          copySource: 'user_edited',
        },
      },
      fieldErrors: state.fieldErrors.filter((error) => (
        error.platform !== action.platform || error.field !== action.field
      )),
    };
  }
  if (action.type === 'replace-draft') {
    return {
      ...state,
      drafts: { ...state.drafts, [action.platform]: structuredClone(action.draft) },
      fieldErrors: state.fieldErrors.filter((error) => error.platform !== action.platform),
    };
  }
  if (action.type === 'set-schedule') {
    const draft = state.drafts[action.platform];
    if (!draft) return state;
    return {
      ...state,
      drafts: { ...state.drafts, [action.platform]: { ...draft, scheduledAt: action.value } },
    };
  }
  if (action.type === 'back') {
    const index = WIZARD_STEPS.indexOf(state.step);
    return { ...state, step: WIZARD_STEPS[Math.max(0, index - 1)], platformError: undefined };
  }

  if (state.step === 'platforms' && state.selectedPlatforms.length === 0) {
    return { ...state, platformError: '请至少选择一个发布平台' };
  }
  if (state.step === 'copy') {
    const fieldErrors = validatePublishingDrafts(state);
    if (fieldErrors.length > 0) return { ...state, fieldErrors };
  }
  const index = WIZARD_STEPS.indexOf(state.step);
  return { ...state, step: WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, index + 1)] };
}

export function validatePublishingDrafts(
  state: PublishingWizardState,
): PublishingWizardFieldError[] {
  const errors: PublishingWizardFieldError[] = [];
  for (const platform of state.selectedPlatforms) {
    const policy = PUBLISHING_PLATFORMS.find((item) => item.id === platform)!;
    const copy = state.drafts[platform]?.copy;
    if (!copy) continue;
    const titleLength = [...copy.title.trim()].length;
    const descriptionLength = [...copy.description.trim()].length;
    if (titleLength === 0) {
      errors.push({ platform, field: 'title', actual: 0, limit: 1, message: `${policy.label}标题不能为空` });
    } else if (titleLength > policy.titleMax) {
      errors.push({ platform, field: 'title', actual: titleLength, limit: policy.titleMax, message: `${policy.label}标题当前 ${titleLength} 字，最多 ${policy.titleMax} 字` });
    }
    if (descriptionLength > policy.descriptionMax) {
      errors.push({ platform, field: 'description', actual: descriptionLength, limit: policy.descriptionMax, message: `${policy.label}正文当前 ${descriptionLength} 字，最多 ${policy.descriptionMax} 字` });
    }
    if (copy.hashtags.length > policy.hashtagMax) {
      errors.push({ platform, field: 'hashtags', actual: copy.hashtags.length, limit: policy.hashtagMax, message: `${policy.label}标签当前 ${copy.hashtags.length} 个，最多 ${policy.hashtagMax} 个` });
    }
    for (const tag of copy.hashtags) {
      const length = [...tag.trim().replace(/^#+/u, '')].length;
      if (length > policy.hashtagLengthMax) {
        errors.push({ platform, field: 'hashtags', actual: length, limit: policy.hashtagLengthMax, message: `${policy.label}标签“${tag}”当前 ${length} 字，最多 ${policy.hashtagLengthMax} 字` });
      }
    }
  }
  return errors;
}

export function getPublishingScheduleStatus(
  value: string,
  now = new Date(),
): 'ready' | 'scheduled' {
  const time = new Date(value).getTime();
  return value && Number.isFinite(time) && time > now.getTime() ? 'scheduled' : 'ready';
}

export function buildCreatePublishingInput(
  state: PublishingWizardState,
  sourceJobId: string,
  title: string,
  now = new Date(),
): CreatePublishingPackageInput {
  if (!state.preview) throw new Error('发布预览尚未完成');
  return {
    sourceJobId,
    previewRevision: state.preview.previewRevision,
    title,
    platforms: state.selectedPlatforms.map((platform) => {
      const draft = state.drafts[platform];
      if (!draft) throw new Error('发布文案尚未完成');
      const scheduledAt = getPublishingScheduleStatus(draft.scheduledAt, now) === 'scheduled'
        ? new Date(draft.scheduledAt).toISOString()
        : undefined;
      return {
        platform,
        copy: structuredClone(draft.copy),
        scheduledAt,
      };
    }),
  };
}

export function isPublishingEligibleVideo(
  output: HyperframesVideoOutput | null,
): output is HyperframesVideoOutput {
  return Boolean(
    output?.videoPath
    && output.videoPath.toLowerCase().endsWith('.mp4')
    && output.width > 0
    && output.height > 0
    && output.duration > 0,
  );
}

export type PublishingActionId =
  | 'copy-title'
  | 'copy-description'
  | 'copy-hashtags'
  | 'copy-full'
  | 'show-in-finder'
  | 'open-platform'
  | 'edit-content'
  | 'schedule'
  | 'mark-published'
  | 'record-failure'
  | 'cancel'
  | 'restore'
  | 'create-version'
  | 'withdraw'
  | 'trash-package'
  | 'restore-package'
  | 'preview'
  | 'auto-publish'
  /**
   * 小红书图文：**只填到草稿**（自研执行器暂存并核实本地草稿，
   * 由真人在同一浏览器中点发布）。姿态乙，spec §10 的**默认姿态**。
   */
  | 'fill-xhs'
  /** 小红书图文：**真的点发布**（姿态甲；同一套闸门 + 频率限制，且点完不做读回）。 */
  | 'submit-xhs'
  | 'view-xhs-drafts'
  | 'submit-code'
  /** 文章包：下载/打开包内 `article.html`（降级通路，任何时候可用、零依赖）。 */
  | 'download-article';

export interface PublishingSourceGroup {
  sourceJobId: string;
  title: string;
  versions: PublishingPackageDetail[];
}

export const PUBLISH_STATUS_LABELS: Record<PublishTask['status'], string> = {
  scheduled: '已排期',
  ready: '待发布',
  published: '已发布',
  failed: '失败',
  cancelled: '已取消',
};

export function groupPublishingPackages(
  details: PublishingPackageDetail[],
): PublishingSourceGroup[] {
  const groups = new Map<string, PublishingSourceGroup>();
  for (const detail of details) {
    const sourceJobId = detail.package.sourceJobId;
    const group = groups.get(sourceJobId) ?? {
      sourceJobId,
      title: detail.package.title,
      versions: [],
    };
    group.versions.push(detail);
    groups.set(sourceJobId, group);
  }
  return [...groups.values()].map((group) => {
    const versions = group.versions.sort((a, b) => b.package.version - a.package.version);
    return { ...group, title: versions[0].package.title, versions };
  });
}

/** 文章包判定：`contentType` 缺省视为 video（存量包不变）。 */
export function isArticlePackage(detail: PublishingPackageDetail): boolean {
  return (detail.package.contentType ?? 'video') === 'article';
}

/**
 * 这个包的任务文案是不是**真源**（决定要不要给「编辑文案」）。
 *
 * - `video`（人工交付）→ `'task'`：任务文案就是你要复制到平台的那份，改了有用；
 * - `note`（图文）→ `'package'`：真源是**包级 `noteCopy`**，两条图文通路取文案的顺序都是
 *   `noteCopy ?? task.*`，所以改任务文案**发出去的还是旧包文案**；
 * - `article` → `'package'`：真源是包级 `article.html` 的渲染结果。
 *
 * ⚠️ 2026-09-21 补的：此前只有文章包隐藏了「编辑文案」，图文任务照给 ——
 * 那是个**假按钮**（点了显示变了，发出去的没变），正是「文案指错动作」那一类坑。
 */
export function publishingCopySourceOf(detail: PublishingPackageDetail): 'task' | 'package' {
  return (detail.package.contentType ?? 'video') === 'video' ? 'task' : 'package';
}

// ─── 发布中心「渠道」页签（spec: 2026-09-18-publishing-channel-tabs-design.md，
//     2026-09-21 按用户实测反馈改版：**渠道 = 平台**，内容类型降为子页签）────
//
// 改版理由（用户 2026-09-21 反馈）：原版把**内容类型**当一级分栏（图文 / 今日头条文章 /
// 视频人工交付），于是「抖音」在一级界面上根本不存在 —— 抖音图文与抖音视频被拆进两个页签；
// 而「今日头条文章」这种「平台+类型」混写的标签又和另外两个不同构。
// 现在一级 = 平台（抖音 / 小红书 / 今日头条 / 微信公众号 / 其它平台），
// 二级 = 内容类型，且**只在「该渠道真的出现了多于一种内容类型」时才出现**
// （只有图文包的抖音不长子页签 —— 只含一项的选择是假选择）。
//
// ⚠️ 四条必须守住的约定：
// 1. **状态语义仍然只有服务端一份**：前端只传 `status`，绝不在前端复刻「待处理 / 资产异常」的判定。
// 2. **渠道筛选在前端做**：服务端的 `platform` 过滤是**单值**的，表达不了「其它平台（视频号 + B站）」
//    这类多平台页签。所以列表口径 = 服务端按 `status` 过滤后的结果，再按「渠道平台集 + 子页签内容类型」
//    筛一遍。**计数必须来自那次不带 status 的请求**（`status=all`），否则「失败」在「待处理」视图里恒为 0。
// 3. **一个包可以出现在多个页签里**（同一份图文同时发抖音和小红书的包），因此
//    「这个包属于哪个渠道」这种**单值**函数已不存在：凡涉及渠道一律按**任务平台**判定，
//    计数也必须只数渠道内的任务（拿整个包的 `tasks` 去数会让别的平台的数字漏进这个页签）。
// 4. **渠道映射必须覆盖每一种可创建的组合**：视频包的平台向导是把 `PUBLISHING_PLATFORMS`
//    **全量**列出来的（含今日头条、微信公众号），所以「头条视频」「公众号视频」这类包真的存在，
//    对应渠道的 `contentTypes` 里必须有 `video` —— 漏一个，那些包就会在所有页签里都看不见。
//    用例 `every platform is reachable from a channel` 守这条。

export type PublishChannelId = 'douyin' | 'xiaohongshu' | 'toutiao' | 'wechat-mp' | 'other';

export interface PublishChannel {
  id: PublishChannelId;
  label: string;
  /** 渠道的唯一真源：**平台集合**。 */
  platforms: PublishPlatform[];
  /**
   * 该渠道**可能出现**的内容类型（同时决定子页签的顺序）。
   *
   * 这是**能力声明**，不是「现在有什么」：子页签是否出现由实际数据决定（`channelContentTypes`），
   * 所以声明比实际宽不会在界面上长出一个只有一项的假选择。
   */
  contentTypes: PackageContentType[];
  /** 是否已接入自动发布通路；`false` = 尚未实现，页签先把位置占好（空态必须写明这一点）。 */
  automation: boolean;
  /** 页签下方一句话：谁在提交、需要什么前置条件。 */
  hint: string;
  /** 空态里可照抄的入口。 */
  emptyHint: string;
}

/** 内容类型的中文名（子页签文案；`article` 只出现在头条 / 公众号这类文章渠道里）。 */
export const PACKAGE_CONTENT_TYPE_LABELS: Record<PackageContentType, string> = {
  note: '图文',
  video: '视频',
  article: '文章',
};

export const PUBLISH_CHANNELS: PublishChannel[] = [
  {
    id: 'douyin',
    label: '抖音',
    platforms: ['douyin'],
    contentTypes: ['note', 'video'],
    automation: true,
    hint:
      // ⚠️ 这里是**给用户看的纯文本**（React 原样渲染），所以不许出现 markdown 记号 ——
      // 写成 `**粗体**` 用户看到的就是两个星号（本项目在文案链路上踩过同类坑）。
      '图文由外部 sau 引擎自动提交（提交前必经预览）；视频不会自动上传，只准备交付包由人工发布。'
      + '自动提交后需你到抖音核实再点「标记已发布」。'
      + '⚠️ 自动化发布违反平台规则，风险由你的账号承担，平台可能警告、限流或封号。',
    emptyHint: '还没有抖音的发布包：到作品详情页的成果画布点「创建图文包」，或点「加入发布中心」准备视频交付包。',
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    platforms: ['xiaohongshu'],
    contentTypes: ['note', 'video'],
    automation: true,
    hint:
      '图文由自研执行器保存到专用浏览器的本地草稿，点「打开小红书草稿浏览器」核对并发布（可在建包时改成由程序提交）；'
      + '视频不会自动上传。⚠️ 这是风险最高的一条通路：平台明确点名「AI 托管代发」并封过号，风险由你的账号承担。',
    emptyHint: '还没有小红书的发布包：到作品详情页的成果画布点「创建图文包」，并勾选 AI 声明与是否由程序提交。',
  },
  {
    id: 'toutiao',
    label: '今日头条',
    platforms: ['toutiao'],
    // 视频向导是全平台列表，所以「头条视频交付包」是存在的（人工交付）。
    contentTypes: ['article', 'video'],
    automation: true,
    hint: '文章由自研执行器自动提交到头条号（先在「设置 → 今日头条」扫码登录，提交前必经预览）；视频不会自动上传。',
    emptyHint: '还没有头条的发布包：到作品详情页的成果画布点「创建头条文章包」（AI 成文 + 16:9 封面）。',
  },
  {
    id: 'wechat-mp',
    label: '微信公众号',
    platforms: ['wechat_mp'],
    contentTypes: ['article', 'video'],
    // 官方 API 只保存文章草稿，视频仍是人工交付。
    automation: true,
    hint: '文章仅通过官方 API 保存到草稿箱，不会正式发布或群发。先到「设置 → 微信公众号」配置并校验连接，最终由你在公众号后台检查和发布；视频不会自动上传。',
    emptyHint: '到作品详情页的成果画布点「创建公众号文章包」，选封面并编辑文章，再回这里预览并提交到草稿箱。',
  },
  {
    id: 'other',
    label: '其它平台',
    platforms: ['wechat_channels', 'bilibili'],
    contentTypes: ['video'],
    automation: false,
    hint: '微信视频号与哔哩哔哩都只能人工交付：这里只准备交付包，不会自动上传，复制文案后到平台发布，发完点「标记已发布」。',
    emptyHint: '还没有视频号 / B站的发布包：到作品详情页点「加入发布中心」，按向导选这两个平台并生成文案。',
  },
];

export function findPublishChannel(channelId: string): PublishChannel {
  return PUBLISH_CHANNELS.find((channel) => channel.id === channelId) ?? PUBLISH_CHANNELS[0]!;
}

/** 该渠道内的任务（按**任务平台**判定）。 */
export function channelTasksOf(detail: PublishingPackageDetail, channelId: PublishChannelId): PublishTask[] {
  const { platforms } = findPublishChannel(channelId);
  return detail.tasks.filter((task) => platforms.includes(task.platform));
}

function packageMatchesChannel(
  detail: PublishingPackageDetail,
  channelId: PublishChannelId,
  contentType?: PackageContentType | '',
): boolean {
  if (channelTasksOf(detail, channelId).length === 0) return false;
  if (contentType && (detail.package.contentType ?? 'video') !== contentType) return false;
  return true;
}

/**
 * 某个渠道（可再按内容类型收窄）下的包。
 *
 * **不**过滤垃圾桶里的包：桶是 `status` 维度的事，由服务端说了算 ——
 * 这里只做「属于哪个页签」这一个判断（历史 bug：前端自己判状态，于是「待处理」视图里失败数恒为 0）。
 */
export function selectChannelPackages(
  details: PublishingPackageDetail[],
  channelId: PublishChannelId,
  contentType?: PackageContentType | '',
): PublishingPackageDetail[] {
  return details.filter((detail) => packageMatchesChannel(detail, channelId, contentType));
}

/**
 * 渠道页签上的数字：各渠道的包数（**一个包可以同时计入多个渠道**）。
 *
 * 口径是「点进这个页签能看到几个包」，所以与列表长度一致；
 * **垃圾桶里的包不计入**（与后端 `status=all` 只回 active 的口径一致）——
 * 否则「删掉一个包」会让渠道数字忽上忽下。
 */
export function countChannelPackages(
  details: PublishingPackageDetail[],
): Record<PublishChannelId, number> {
  const counts = { douyin: 0, xiaohongshu: 0, toutiao: 0, 'wechat-mp': 0, other: 0 } as Record<PublishChannelId, number>;
  for (const detail of details) {
    if (detail.package.state === 'trashed') continue;
    for (const channel of PUBLISH_CHANNELS) {
      if (packageMatchesChannel(detail, channel.id)) counts[channel.id] += 1;
    }
  }
  return counts;
}

/**
 * 该渠道**当前实际出现**的内容类型（按渠道声明的顺序；声明外的类型追加在后面）。
 *
 * 界面据此决定**要不要显示子页签**：只有一种就不显示（避免假选择）。
 * ⚠️ 判定基于**全部包**（那次不带 status 的请求），不基于当前状态视图 ——
 * 否则切到「失败」页签可能让子页签忽隐忽现。
 * 把声明外的类型**追加**而不是丢弃：万一声明漏了，包最多是标签顺序不好看，绝不至于看不见。
 */
export function channelContentTypes(
  details: PublishingPackageDetail[],
  channelId: PublishChannelId,
): PackageContentType[] {
  const declared = findPublishChannel(channelId).contentTypes;
  const present = new Set<PackageContentType>();
  for (const detail of details) {
    if (detail.package.state === 'trashed') continue;
    if (channelTasksOf(detail, channelId).length === 0) continue;
    present.add(detail.package.contentType ?? 'video');
  }
  const known = declared.filter((type) => present.has(type));
  const extra = [...present].filter((type) => !declared.includes(type));
  return [...known, ...extra];
}

/** 内容类型子页签上的数字：当前渠道内按内容类型分的包数（只回出现的类型）。 */
export function countChannelContentTypes(
  details: PublishingPackageDetail[],
  channelId: PublishChannelId,
): Partial<Record<PackageContentType, number>> {
  const counts: Partial<Record<PackageContentType, number>> = {};
  for (const type of channelContentTypes(details, channelId)) {
    counts[type] = selectChannelPackages(details, channelId, type)
      .filter((detail) => detail.package.state !== 'trashed').length;
  }
  return counts;
}

/**
 * 换渠道后内容类型子页签该停在哪：新渠道里还会出现这个类型就留着，否则回到「全部」。
 *
 * 与「换渠道清掉平台筛选」同一个意图：**不制造一个必然筛空的视图**。
 */
export function contentTypeAfterChannelChange(
  details: PublishingPackageDetail[],
  nextChannelId: PublishChannelId,
  current: PackageContentType | '',
): PackageContentType | '' {
  if (!current) return '';
  return channelContentTypes(details, nextChannelId).includes(current) ? current : '';
}

/**
 * 状态页签的数字：**当前渠道（可再按内容类型收窄）内**的计数。
 *
 * 口径与页面既有实现一致：`all` 数**包**（与列表行数一致），其余状态数**任务**
 * （一个包在多个平台各有任务时各算一次）。**只数渠道内的任务** —— 拿整个包的 `tasks`
 * 去数会让其它平台的数字漏进这个页签。
 * 计数必须来自**不带状态筛选**的那一次请求，否则「失败」在「待处理」视图里永远显示 0。
 */
export function countStatusesInChannel(
  details: PublishingPackageDetail[],
  channelId: PublishChannelId,
  contentType?: PackageContentType | '',
): Record<PublishingListStatus, number> {
  const counts = {
    action: 0,
    all: 0,
    ready: 0,
    scheduled: 0,
    published: 0,
    failed: 0,
    cancelled: 0,
    broken: 0,
    trash: 0,
  } as Record<PublishingListStatus, number>;

  for (const detail of selectChannelPackages(details, channelId, contentType)) {
    if (detail.package.state === 'trashed') {
      // 垃圾桶是独立视图：桶里的包只计入 trash，不再计入常规状态。
      counts.trash += 1;
      continue;
    }
    counts.all += 1;
    if (detail.package.assetHealth !== 'healthy') counts.broken += 1;
    const tasks = channelTasksOf(detail, channelId);
    if (detail.package.assetHealth === 'broken_video'
      || tasks.some((task) => task.status === 'ready' || task.status === 'failed')) {
      counts.action += 1;
    }
    for (const task of tasks) counts[task.status] += 1;
  }
  return counts;
}

export function channelEmptyHint(channelId: PublishChannelId): string {
  return findPublishChannel(channelId).emptyHint;
}

/**
 * 小红书创作服务平台**首页** —— 草稿箱与「编辑最新笔记」都在这一页。
 *
 * 2026-09-21 只读侦察实测：首页文案里就有「草稿箱中有未发布的作品」与「编辑最新笔记」。
 */
export const XHS_CREATOR_HOME_URL = 'https://creator.xiaohongshu.com/';

/** 小红书图文的打开动作由本地草稿窗口 API 执行；其它平台沿用外部 URL。 */
export function publishingOpenPlatformTarget(
  detail: PublishingPackageDetail,
  task: PublishTask,
): { url: string; label: string } {
  if ((detail.package.contentType ?? 'video') === 'note' && task.platform === 'xiaohongshu') {
    return { url: XHS_CREATOR_HOME_URL, label: '打开小红书草稿浏览器' };
  }
  return {
    url: PUBLISHING_PLATFORMS.find((item) => item.id === task.platform)?.creatorUrl ?? '',
    label: '打开平台',
  };
}

export function getPublishingActionIds(
  detail: PublishingPackageDetail,
  task: PublishTask,
  role: LocalUserRole,
): PublishingActionId[] {
  if (detail.package.state === 'trashed') {
    return role === 'admin' ? ['restore-package'] : [];
  }
  if (detail.package.state !== 'active') return [];

  const actions: PublishingActionId[] = [
    'copy-title',
    'copy-description',
    'copy-hashtags',
    'copy-full',
  ];
  // 只读预览（spec §14.2）：随时能看一眼「将要发出去的内容」，视频包走这个入口。
  // 与任务状态无关（纯查看），垃圾桶里的包在上面的 early return 已经排除。
  actions.push('preview');
  if (task.platform === 'xiaohongshu') actions.push('view-xhs-drafts');
  const healthyVideo = detail.package.assetHealth !== 'broken_video';
  if (healthyVideo && detail.package.videoPath) actions.push('show-in-finder');

  if (task.status === 'published') {
    actions.push('create-version');
    if (role === 'admin') actions.push('withdraw');
  } else {
    // 文章包的正文是**包级** `article.html` 的渲染结果、图文包的文案是**包级** `noteCopy`：
    // 改任务文案只会让「预览看到的」与「发出去的」漂移，所以这两类任务都不提供「编辑文案」
    // （要改就重建包）。⚠️ 图文这条是 2026-09-21 补的：两条图文通路取文案的顺序都是
    // `noteCopy ?? task.*`，所以任务行上的编辑**根本影响不到发布**，那个按钮是假的。
    if (isArticlePackage(detail)) actions.push('download-article');
    if (publishingCopySourceOf(detail) === 'task') actions.push('edit-content');
    if (task.status === 'scheduled' || task.status === 'ready') {
      actions.push('schedule');
    }
    if (task.status === 'cancelled' || task.status === 'failed') actions.push('restore');
    if (task.status === 'scheduled' || task.status === 'ready') actions.push('record-failure');
    if (task.status === 'scheduled' || task.status === 'ready' || task.status === 'failed') actions.push('cancel');
    if (task.status === 'ready' && healthyVideo) {
      actions.push('open-platform', 'mark-published');
    }
    // 图文包的自动发布：只有「可以立刻提交」时才给动作，其余情况用 blocker 说明原因。
    // 小红书是**两个动作**（填草稿 / 真提交）—— 两者都过同一个 blocker，
    // 因为「填到草稿」同样会动这个账号（平台风控看的是自动化访问，不是提交与否）。
    if (!getPublishingAutoPublishBlocker(detail, task)) {
      if (task.platform === 'xiaohongshu') {
        // `fill-xhs` 永远可用：它带 `dryRun`，服务端**强制不点发布**，所以与包的设置无关。
        actions.push('fill-xhs');
        // `submit-xhs` **只在包自己声明了要提交时**才给 —— 因为「要不要真发出去」是
        // `xhsOptions.submit`，而它进 `previewRevision`。给一个「会真提交」的按钮去动一个
        // 声明了「只填草稿」的包，等于绕过预览指纹，也会让按钮文案撒谎。
        if (detail.package.xhsOptions?.submit === true) actions.push('submit-xhs');
      } else {
        actions.push('auto-publish');
      }
    }
    if (task.autoPublish?.status === 'awaiting_code') actions.push('submit-code');
  }

  if (role === 'admin') actions.push('trash-package');
  return actions;
}

/**
 * 图文自动发布当前是否可用；返回 `null` 表示可用，否则是给操作者看的中文原因。
 *
 * 做成「返回原因」而不是纯布尔：界面要能显示禁用态**为什么**灰掉，
 * 否则用户只会看到一个点不动的按钮（本项目在侧栏折叠上已经吃过一次这个亏）。
 */
/**
 * 与后端 `publishing-store.ts` 的 `AUTO_PUBLISH_STALE_MS` 保持一致。
 *
 * 超过这个时长仍停在 running/awaiting_code 视为「进程已死」：发布请求是同步的，
 * 进程被杀会留下永远 running 的记录，界面若一直按「进行中」灰掉按钮就再也点不动了。
 */
export const AUTO_PUBLISH_STALE_MS = 30 * 60 * 1000;

function autoPublishInFlight(task: PublishTask, now = Date.now()): boolean {
  const record = task.autoPublish;
  if (!record) return false;
  if (record.status !== 'running' && record.status !== 'awaiting_code') return false;
  const startedAt = new Date(record.startedAt).getTime();
  if (!Number.isFinite(startedAt)) return false;
  return now - startedAt < AUTO_PUBLISH_STALE_MS;
}

export function getPublishingAutoPublishBlocker(
  detail: PublishingPackageDetail,
  task: PublishTask,
): string | null {
  if (detail.package.state === 'trashed') return '发布包在垃圾桶中，先恢复后再发布';
  if (detail.package.state !== 'active') return '发布包已清理，无法发布';
  const contentType = detail.package.contentType ?? 'video';
  if (contentType === 'article') {
    // 与服务端文章通路对应：头条提交，公众号只存草稿。
    if (task.platform !== 'toutiao' && task.platform !== 'wechat_mp') return '该平台尚未接入文章提交';
    if (task.platform === 'wechat_mp' && (task.autoPublish?.draftMediaId || task.autoPublish?.outcomeUncertain
      || task.autoPublish?.status === 'succeeded' || task.autoPublish?.status === 'running')) {
      return '草稿已创建、正在创建或结果待核实，请先到公众号后台检查；确需另建时请人工重新建包';
    }
    // 头条封面必填：缺封面时在这里就说清楚，而不是等提交时才失败。
    if (detail.package.assetHealth === 'missing_cover') {
      return `缺少封面：${publishingPlatformLabel(task.platform)}要求文章必须有封面，请重新创建文章包并选择封面`;
    }
    if (detail.package.assetHealth !== 'healthy') return '文章包资产异常，请先修复后再发布';
    if (autoPublishInFlight(task)) return '自动发布正在进行中，请等本次结束后再试';
    if (task.status === 'published') return '任务已标记为发布，如需改动请先撤回';
    if (task.status === 'cancelled') return '任务已取消，先恢复任务再发布';
    if (task.status === 'scheduled') return '任务已排期，如需立即发布请先取消排期';
    if (task.status !== 'ready' && task.status !== 'failed') return '当前状态不允许自动发布';
    return null;
  }
  if (contentType !== 'note') {
    return '视频包仍走人工交付，不支持自动发布';
  }
  if (detail.package.assetHealth === 'missing_images') {
    return '图文包缺少图片素材，请重新生成视频静帧或从素材库选择图片';
  }
  if (detail.package.assetHealth !== 'healthy') {
    return '图文包资产异常，请先修复后再发布';
  }
  if (detail.package.imagePaths?.length === 0) return '图文包没有图片，无法发布';

  // 小红书专有闸门。**只检查渲染层本地就能知道的事实**（包里有没有勾 AI 声明）——
  // 张数上限（18）与频率上限（每日 1 篇）是**服务端的规则**，一律不在前端复刻：
  // 复刻就是必然漂移的第二真源，让服务端 422 把原因带回来即可。
  if (task.platform === 'xiaohongshu' && detail.package.xhsOptions?.aiDeclaration !== true) {
    return '小红书要求声明「笔记含AI合成内容」：请重建图文包并勾选该声明（未标识的内容会被平台限制分发）';
  }

  // 同步请求还在跑（或正在等验证码）时不给第二次动作，避免必然 409
  if (autoPublishInFlight(task)) return '自动发布正在进行中，请等本次结束后再试';
  if (task.status === 'published') return '任务已标记为发布，如需改动请先撤回';
  if (task.status === 'cancelled') return '任务已取消，先恢复任务再发布';
  // 排期中的任务不该被「立即发布」绕过；失败后人工重试是既定通路（spec §9：绝不自动重试）
  if (task.status === 'scheduled') return '任务已排期，如需立即发布请先取消排期';
  if (task.status !== 'ready' && task.status !== 'failed') return '当前状态不允许自动发布';
  return null;
}

/** 任务行上的一句话状态提示；没有自动发布记录时返回 `null`。 */
/**
 * 平台中文名（用于「提交到 X」这类用户可见文案）。
 *
 * 以前这些文案把「抖音」写死在字符串里 —— 头条文章任务会显示「正在提交到**抖音**…」，
 * 属于会误导操作者的错平台文案（本项目在「文案指错动作」上已经吃过一次亏）。
 */
export function publishingPlatformLabel(platform: PublishPlatform): string {
  return PUBLISHING_PLATFORMS.find((item) => item.id === platform)?.label ?? platform;
}

/** 自动发布的确认按钮文案（按平台取，不再写死「抖音」）。 */
export function getAutoPublishConfirmLabel(platform: PublishPlatform): string {
  if (platform === 'wechat_mp') return '确认提交到微信公众号草稿箱';
  return `确认发布到${publishingPlatformLabel(platform)}`;
}

export function getPublishingAutoPublishHint(task: PublishTask): string | null {
  const record = task.autoPublish;
  if (!record) return null;
  const label = publishingPlatformLabel(task.platform);
  if (record.status === 'running') return `正在提交到${label}…`;
  if (record.status === 'awaiting_code') {
    return '等待短信验证码：请点「提交验证码」填入手机收到的验证码';
  }
  if (record.status === 'succeeded') {
    if (task.platform === 'wechat_mp') return `公众号草稿已创建${record.draftMediaId ? `（${record.draftMediaId}）` : ''}，尚未发布。请到公众号后台检查并手动发布。`;
    // 老记录仅用文案识别未点发布，不把它当作保存证据。
    const legacyDraftOnly = record.draftOnly === undefined
      && /没有点「发布」|停在点「发布」之前/u.test(record.message ?? '');
    if (record.draftOnly || legacyDraftOnly) {
      if (task.platform === 'xiaohongshu') {
        return record.xhsDraftId
          ? '已保存并核实小红书浏览器本地图文草稿（本工具没有点发布）：点「打开小红书草稿浏览器」核对并发布；不会同步到手机或其它浏览器'
          : '旧记录未确认完整草稿已保存（本工具没有点发布）：点「打开小红书草稿浏览器」检查「图文笔记」，可能缺少正文；不要直接重复提交';
      }
      return `已填写到${label}草稿箱（本工具没有点发布），请核对内容后自行发布`;
    }
    // 「点了发布但没拿到成功判据」必须显示出来：这是「重复发布」这个最大风险的补偿手段
    //（服务端把原话写进了 message，此前只有展开审计记录才看得到）。
    if ((record.message ?? '').includes('未能')) {
      return `已提交，但未能自动确认：请务必先去${label}后台核实是否已发出，再决定要不要重试，最后点「标记已发布」`;
    }
    return `已提交，请在${label}后台确认后点「标记已发布」`;
  }
  // 外部 CLI 的原始输出带 ANSI 色码（历史记录里已经存了），展示前统一清掉
  return record.message ? `提交失败：${stripAnsi(record.message)}` : '提交失败，请查看审计记录后重试';
}

/**
 * 发布包那一行显示的「下一步」提示。
 *
 * 这段文案必须**只提真实可用的动作**：之前对已取消的任务写「恢复已取消任务或创建新版本」，
 * 但 `create-version` 只在任务处于 `published` 时才会出现在动作列表里 —— 提示词指向一个
 * 不存在的按钮，用户会照着找却找不到（用户实测反馈）。见下方 `canCreateVersion` 判定。
 */
export function publishingNextStep(detail: PublishingPackageDetail): string {
  if (detail.package.state === 'trashed') return '由管理员恢复发布包';
  if (detail.package.assetHealth === 'broken_video') return '视频资产异常，请查看资产说明';
  const readyTasks = detail.tasks.filter((task) => task.status === 'ready');
  if (readyTasks.length > 0) return readyNextStep(detail, readyTasks);
  if (detail.tasks.some((task) => task.status === 'failed')) return '处理失败原因并恢复任务';
  if (detail.tasks.some((task) => task.status === 'scheduled')) return '等待排期提醒';
  // 与 `getPublishingActionIds` 保持一致：只有存在已发布任务时「创建新版本」才真的可用
  const canCreateVersion = detail.tasks.some((task) => task.status === 'published');
  if (detail.tasks.every((task) => task.status === 'published')) return '已完成，可创建新版本';
  if (canCreateVersion) return '恢复已取消的任务，或基于已发布版本创建新版本';
  return '恢复已取消的任务后可继续人工发布';
}

/**
 * 「下一步」对**图文包**必须点名**真实存在**的那个按钮。
 *
 * 2026-09-21 用户实测反馈「没有找到发布小红书按钮」：那一行当时写的是「打开平台并完成发布」，
 * 而小红书图文包上真实存在的按钮是「填写到小红书（不提交）」—— 「要不要真发出去」是建包时
 * `xhsOptions.submit` 定的（默认只填草稿，`submit-xhs` 按钮因此**不存在**）。
 * 这与本文件既有的教训是同一类：**提示词指向一个不存在的按钮**（上一回是「恢复已取消任务或创建新版本」）。
 * 按钮被闸门拦下时（`getPublishingAutoPublishBlocker`），这里直接把**原因**写在这一行 ——
 * 否则那行会既没有按钮、也没有解释（图文包的发布按钮是「无阻断才出现」）。
 */
function readyNextStep(detail: PublishingPackageDetail, readyTasks: PublishTask[]): string {
  if ((detail.package.contentType ?? 'video') !== 'note') return '打开平台并完成发布';
  const xhs = readyTasks.find((task) => task.platform === 'xiaohongshu');
  if (xhs) {
    if (xhs.autoPublish?.status === 'succeeded' && xhs.autoPublish.draftOnly) return '点「打开小红书草稿浏览器」检查「图文笔记」，核对正文和图片后自行发布';
    const blocker = getPublishingAutoPublishBlocker(detail, xhs);
    if (blocker) return blocker;
    return detail.package.xhsOptions?.submit === true
      ? '点「发布到小红书」提交（点完请到小红书 App 核实），再点「标记已发布」'
      : '本包只存浏览器本地图文草稿：点「填写到小红书（不提交）」，再点「打开小红书草稿浏览器」核对并发布';
  }
  const douyin = readyTasks.find((task) => task.platform === 'douyin');
  if (douyin) {
    const blocker = getPublishingAutoPublishBlocker(detail, douyin);
    if (blocker) return blocker;
    return '点「发布图文到抖音」提交（必经预览），提交后到抖音核实再点「标记已发布」';
  }
  return '打开平台并完成发布';
}

export function formatDueNotification(notification: DueNotification): string {
  const planned = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(notification.scheduledAt));
  const roundedMinutes = Math.max(0, Math.round(notification.overdueMs / 60_000));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  const duration = [
    hours > 0 ? `${hours} 小时` : '',
    minutes > 0 || hours === 0 ? `${minutes} 分钟` : '',
  ].filter(Boolean).join(' ');
  return `原计划 ${planned}，已逾期 ${duration}`;
}

export function formatPublishingCopy(copy: PlatformCopy): {
  title: string;
  description: string;
  hashtags: string;
  full: string;
} {
  const title = copy.title.trim();
  const description = copy.description.trim();
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of copy.hashtags) {
    const tag = value.trim().replace(/^#+/u, '').trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  const hashtags = tags.map((tag) => `#${tag}`).join(' ');
  return {
    title,
    description,
    hashtags,
    full: [title, description, hashtags].filter(Boolean).join('\n\n'),
  };
}
