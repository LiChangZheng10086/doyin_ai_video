import React from 'react';
import { createRoot } from 'react-dom/client';

/*
 * 设计夹具（Design Fixture）。
 *
 * 为什么需要它：本应用的数据全在后端，**后端没起来时所有页面都是空态/错误态**，
 * 于是「有数据时的布局与密度」既做不了取舍、也没法验证 —— 项目里也没有任何
 * 可以在无后端条件下看界面的地方（既没有 Storybook 也没有设计夹具）。
 *
 * 渲染的是**真实组件 + mock 数据**，不是复制一份界面：
 *   - 发布中心：PackageRow / TaskRow / StatusBadge / AssetBadge（从 PublishingPage 导出）
 *   - 作品列表：JobListView（真实行结构，含 4 步链路轨）
 *   - 设计原语：Button 全变体、ProgressRail 全状态、PlatformLogo、EmptyState
 *
 * 它**不进生产包**：入口是独立的 renderer/design.html，只有显式访问 /design.html 才加载。
 * 视觉回归见 scripts/probe-ui-design.mjs。
 */
import '../index.css';
import { PackageRow, StatusBadge, AssetBadge } from '../pages/PublishingPage';
import { PublishingChannelTabs } from '../components/PublishingChannelTabs';
import { JobListView } from '../features/jobs/JobListView';
import { WorkflowConsole } from '../features/jobs/WorkflowConsole';
import { ArtifactNavigator } from '../features/jobs/artifacts/ArtifactNavigator';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { PlatformLogo } from '../components/ui/PlatformLogo';
import { ProgressRail, type RailSegment } from '../components/ui/ProgressRail';
import type { JobOverview, PublishTask, PublishingPackageDetail } from '../types/index';
import { Inbox, Trash2 } from 'lucide-react';

const publisher = { userId: 'u1', displayName: '本机用户', role: 'admin' as const };
const NOW = '2026-09-21T02:00:00.000Z';

function makeTask(id: string, platform: PublishTask['platform'], status: PublishTask['status'], extra: Partial<PublishTask> = {}): PublishTask {
  return {
    id, packageId: 'pkg', platform, status,
    title: '三个被高估的剪辑技巧',
    description: '模板不是创作。真正的效率来自把重复劳动交给机器，把判断留给自己。',
    hashtags: ['剪辑', '效率'],
    copySource: 'ai', contentRevision: 2,
    createdAt: NOW, updatedAt: NOW,
    ...extra,
  } as PublishTask;
}

function makePackage(
  sourceJobId: string,
  version: number,
  pkgOverrides: Partial<PublishingPackageDetail['package']> = {},
  tasks?: PublishTask[],
): PublishingPackageDetail {
  const packageId = `${sourceJobId}-v${version}`;
  const createdAt = `2026-09-${String(10 + version).padStart(2, '0')}T02:00:00.000Z`;
  return {
    package: {
      id: packageId,
      sourceJobId,
      version,
      state: 'active',
      title: '三个被高估的剪辑技巧',
      packagePath: `/storage/output/publishing/${sourceJobId}/v${version}-${packageId}`,
      videoPath: `/storage/output/publishing/${sourceJobId}/video.mp4`,
      videoSha256: 'a'.repeat(64),
      videoSize: 12_345_678,
      videoMethod: 'clone',
      assetHealth: 'healthy',
      createdBy: publisher,
      createdAt,
      updatedAt: createdAt,
      ...pkgOverrides,
    },
    tasks: tasks ?? [makeTask(`${packageId}-douyin`, 'douyin', 'ready')],
    audit: [],
  };
}

function makeJob(
  id: string,
  nextActionLabel: string,
  statuses: [string, string, string, string],
  flags: Partial<JobOverview['preview']> = {},
  status: JobOverview['status'] = 'processing',
): JobOverview {
  const [t, c, s, v] = statuses;
  return {
    id,
    sourceUrl: 'https://v.douyin.com/xxxxxxx',
    topic: '三个被高估的剪辑技巧',
    status,
    stage: 'transcribing',
    storagePath: '/storage',
    createdAt: '2026-09-20T02:00:00.000Z',
    updatedAt: '2026-09-21T02:00:00.000Z',
    steps: {
      transcribe: { status: t },
      clean: { status: c },
      generate_video_prompts: { status: s },
      generate_video: { status: v },
    },
    preview: {
      displayTitle: '三个被高估的剪辑技巧',
      subtitle: '更新于 09-21 02:00',
      sourcePlatform: '抖音',
      authorName: '某某创作者',
      summary: '模板不是创作。真正的效率来自把重复劳动交给机器。',
      coverTitle: '三个被高估的剪辑技巧',
      hasTranscript: t === 'succeeded',
      hasRewrite: c === 'succeeded',
      hasVideoPrompts: s === 'succeeded',
      hasVideo: v === 'succeeded',
      nextActionLabel,
      ...flags,
    },
  } as JobOverview;
}

/** 工作流控制台的四种状态（这个产品的心脏：一眼要看出「走到哪一步、下一步做什么」）。 */
const CONSOLE_JOBS: Array<[string, JobOverview, 'pending' | 'running' | 'failed' | 'done']> = [
  ['刚提交，未开始', makeJob('c1', '执行 视频转录', ['pending', 'pending', 'pending', 'pending'], { hasTranscript: false, hasRewrite: false, hasVideoPrompts: false, hasVideo: false }, 'queued'), 'pending'],
  ['转录完成，正在洗稿', makeJob('c2', '暂停 洗稿', ['succeeded', 'running', 'pending', 'pending'], { hasVideoPrompts: false, hasVideo: false }, 'processing'), 'running'],
  ['分镜失败，可重试', makeJob('c3', '重试 生成分镜', ['succeeded', 'succeeded', 'failed', 'pending'], { hasVideoPrompts: false, hasVideo: false }, 'failed'), 'failed'],
  ['全部完成', makeJob('c4', '查看成片', ['succeeded', 'succeeded', 'succeeded', 'succeeded'], { hasVideoPrompts: true, hasVideo: true }, 'done'), 'done'],
];

const GROUPS = [
  {
    sourceJobId: 'job-a1b2c3',
    title: '三个被高估的剪辑技巧',
    versions: [
      makePackage('job-a1b2c3', 3, { contentType: 'note', assetHealth: 'healthy' }, [
        makeTask('t1', 'douyin', 'ready'),
      ]),
      makePackage('job-a1b2c3', 2, { contentType: 'note', assetHealth: 'missing_images' }, [
        makeTask('t2', 'xiaohongshu', 'failed', { lastError: '小红书图文最多 18 张图片', copySource: 'user_edited' }),
      ]),
    ],
  },
  {
    sourceJobId: 'job-d4e5f6',
    title: '一个人怎么做出有节奏的短视频',
    versions: [
      makePackage('job-d4e5f6', 1, { contentType: 'article', assetHealth: 'missing_cover' }, [
        makeTask('t3', 'toutiao', 'published', { publishedAt: '2026-09-20T10:00:00.000Z' }),
        makeTask('t4', 'bilibili', 'cancelled'),
      ]),
    ],
  },
];

const JOBS: JobOverview[] = [
  makeJob('job-1', '执行 生成分镜', ['succeeded', 'running', 'pending', 'pending']),
  makeJob('job-2', '重试 生成分镜', ['succeeded', 'succeeded', 'failed', 'pending'], { hasVideoPrompts: false }),
  makeJob('job-3', '查看成片', ['succeeded', 'succeeded', 'succeeded', 'succeeded'], { hasVideoPrompts: true, hasVideo: true }),
  makeJob('job-4', '执行 视频转录', ['pending', 'pending', 'pending', 'pending'], { hasTranscript: false, hasRewrite: false }),
];

const RAIL_SAMPLES: Array<[string, RailSegment[]]> = [
  ['刚提交，还没跑', [{ label: '转录', state: 'pending' }, { label: '洗稿', state: 'pending' }, { label: '分镜', state: 'pending' }, { label: '成片', state: 'pending' }]],
  ['转录完成，正在洗稿', [{ label: '转录', state: 'succeeded' }, { label: '洗稿', state: 'running' }, { label: '分镜', state: 'pending' }, { label: '成片', state: 'pending' }]],
  ['分镜失败', [{ label: '转录', state: 'succeeded' }, { label: '洗稿', state: 'succeeded' }, { label: '分镜', state: 'failed' }, { label: '成片', state: 'pending' }]],
  ['全部完成', [{ label: '转录', state: 'succeeded' }, { label: '洗稿', state: 'succeeded' }, { label: '分镜', state: 'succeeded' }, { label: '成片', state: 'succeeded' }]],
];

const VARIANTS = ['primary', 'accent', 'outline', 'ghost', 'subtleDanger', 'danger'] as const;
const STATUSES = ['scheduled', 'ready', 'published', 'failed', 'cancelled'] as const;
const HEALTHS = ['healthy', 'missing_cover', 'missing_images', 'broken_video'] as const;
const PLATFORMS = ['douyin', 'xiaohongshu', 'toutiao', 'wechat_mp', 'wechat_channels', 'bilibili'] as const;

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-14">
      <h2 className="font-display text-2xl font-semibold text-ink">{title}</h2>
      {note ? <p className="mt-1 max-w-2xl text-sm text-ink-muted">{note}</p> : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

const noop = async () => {};

function Fixture() {
  const [channel, setChannel] = React.useState<'douyin' | 'xiaohongshu' | 'toutiao' | 'wechat-mp' | 'other'>('douyin');
  const [contentType, setContentType] = React.useState<'note' | 'video' | 'article' | ''>('note');
  const channelCounts = { douyin: 3, xiaohongshu: 2, toutiao: 1, 'wechat-mp': 0, other: 4 } as Record<typeof channel, number>;
  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
      <Section
        title="发布中心 · 渠道页签"
        note="一级是平台、二级是内容类型。两级都是 WAI-ARIA tabs：整组只占一个 Tab 停靠点，组内用 ←/→ 切换（Home/End 跳首尾）。"
      >
        <PublishingChannelTabs
          active={channel}
          counts={channelCounts}
          contentTypes={['note', 'video']}
          contentTypeCounts={{ note: 2, video: 1 }}
          activeContentType={contentType}
          onSelect={(id) => setChannel(id)}
          onSelectContentType={(id) => setContentType(id)}
        />
      </Section>

      <Section
        title="发布中心 · 有数据状态"
        note="真实的 PackageRow / TaskRow / StatusBadge / AssetBadge。第二行是展开态。缺图包现在显示红色的「缺少图片」，不再是绿色「视频异常」。"
      >
        <div className="space-y-6">
          {GROUPS.map((group) => (
            <section key={group.sourceJobId} className="overflow-hidden rounded-xl border border-line bg-panel">
              <header className="flex flex-col gap-1 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="min-w-0 truncate font-display text-lg font-semibold text-ink">{group.title}</h3>
                <span className="shrink-0 text-sm tabular text-ink-muted">{group.versions.length} 个版本</span>
              </header>
              <div className="divide-y divide-line">
                {group.versions.map((detail, index) => (
                  <PackageRow
                    key={detail.package.id}
                    detail={detail}
                    sourceJobId={group.sourceJobId}
                    role="admin"
                    expanded={index === 1}
                    busy={false}
                    onToggle={() => {}}
                    onAction={noop}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </Section>

      <Section title="作品列表 · 有数据状态" note="真实 JobListView（桌面表格视图）。每行标题下方是 4 步链路进度轨。">
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <JobListView jobs={JOBS} deletingId={null} onOpen={() => {}} onRequestDelete={() => {}} />
        </div>
      </Section>

      <Section
        title="按钮原语"
        note="品牌红底配近黑字（5.21:1）。白字压品牌红只有 3.68:1，不达 AA，所以本设计系统不允许那样用。"
      >
        <div className="space-y-4">
          {VARIANTS.map((variant) => (
            <div key={variant} className="flex flex-wrap items-center gap-3">
              <span className="w-24 shrink-0 font-mono text-xs text-ink-subtle">{variant}</span>
              <Button variant={variant} size="sm">小按钮</Button>
              <Button variant={variant} size="md">中按钮</Button>
              <Button variant={variant} size="lg">大按钮</Button>
              <Button variant={variant} size="icon" aria-label="图标按钮">★</Button>
              <Button variant={variant} disabled>禁用</Button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="状态与标识" note="徽章都带文字，不靠颜色单独表意；标识用真 logo（小红书 / B站）与 monogram 混合。">
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            {STATUSES.map((status) => (
              <StatusBadge key={status} task={makeTask(status, 'douyin', status)} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {HEALTHS.map((health) => (
              <AssetBadge key={health} health={health} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {PLATFORMS.map((platform) => (
              <div key={platform} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
                <PlatformLogo platform={platform} size="md" />
                <span className="text-sm text-ink">{platform}</span>
              </div>
            ))}
          </div>
          <div className="space-y-2 rounded-lg border border-line bg-panel p-4">
            {RAIL_SAMPLES.map(([label, segments]) => (
              <div key={label} className="flex items-center justify-between gap-4">
                <span className="text-sm text-ink">{label}</span>
                <ProgressRail segments={segments} />
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="作品详情 · 工作流控制台"
        note="四种状态：未开始 / 进行中 / 失败可重试 / 全部完成。禁用态直接把原因写在按钮上（「等待 视频转录 完成」），不靠灰掉不说原因。"
      >
        <div className="space-y-6">
          {CONSOLE_JOBS.map(([label, mockJob, status]) => (
            <div key={label}>
              <p className="mb-2 font-mono text-xs text-ink-subtle">{status} · {label}</p>
              <WorkflowConsole
                job={mockJob}
                runningStep={status === 'running' ? 'clean' : null}
                actionError={status === 'failed' ? 'AI 分镜生成失败：上游返回 429（请求过于频繁），请稍后重试' : null}
                onRunStep={() => {}}
                onPauseStep={() => {}}
                onReClean={() => {}}
              />
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="作品详情 · 成果页签"
        note="4 个成果格子的状态徽章（可用 / 处理中 / 等待中 / 失败）。整组是一个 Tab 停靠点，←/→ 切换。"
      >
        <div className="rounded-xl border border-line bg-panel">
          <ArtifactNavigator
            active="transcript"
            items={[
              { key: 'transcript', label: '视频转录', state: 'ready' },
              { key: 'script', label: 'AI 洗稿', state: 'processing' },
              { key: 'shots', label: '分镜提示词', state: 'failed' },
              { key: 'video', label: '成片', state: 'waiting' },
            ]}
            onChange={() => {}}
          />
          <p className="p-6 text-sm text-ink-muted">（此处是成果内容区）</p>
        </div>
      </Section>

      <Section
        title="素材网格 · 密度"
        note="自适应密排（minmax(160px,1fr)）。同一屏从改造前的 4 张变 8 张；删除按钮是 32×32 图标按钮并带文件名无障碍名。"
      >
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
          {Array.from({ length: 10 }).map((_, index) => (
            <figure key={index} className="overflow-hidden rounded-lg border border-line bg-panel">
              <div className="flex aspect-[9/16] w-full items-center justify-center bg-canvas text-xs text-ink-subtle">
                9:16
              </div>
              <figcaption className="space-y-1 p-2.5">
                <div className="flex items-center gap-1">
                  <p className="min-w-0 flex-1 truncate text-sm text-ink" title={`素材-${index + 1}.png`}>
                    素材-{index + 1}.png
                  </p>
                  <Button variant="ghost" size="icon" aria-label={`删除「素材-${index + 1}.png」`} className="text-danger hover:bg-danger-soft">
                    <Trash2 size={14} aria-hidden="true" />
                  </Button>
                </div>
                <p className="truncate text-xs tabular text-ink-muted">1080×1920 · 1.4 MB</p>
              </figcaption>
            </figure>
          ))}
        </div>
      </Section>

      <Section title="空态" note="空态只用于「确实为空」；失败要用带重试的错误态，两者互斥。">
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState
            icon={Inbox}
            title="这个渠道里还没有发布包"
            description="到作品详情页的成果画布点「创建图文包」，或点「加入发布中心」准备视频交付包。"
            action={<Button variant="outline">创建第一个发布包</Button>}
          />
        </div>
      </Section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
