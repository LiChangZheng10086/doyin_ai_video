/**
 * 发布中心的一级「渠道」页签（抖音 / 小红书 / 今日头条 / 微信公众号 / 其它平台）
 * 与二级「内容类型」子页签（图文 / 视频 / 文章）。
 *
 * 立项理由（spec `2026-09-18-publishing-channel-tabs-design.md`）：此前一条列表把
 * 「抖音图文（自动提交）」「今日头条文章（自动提交）」「视频（纯人工交付）」混在一屏，
 * 只能靠平台下拉过滤，状态计数也混在一起。
 *
 * 2026-09-21 按用户实测反馈改版：原版一级分栏是**内容类型**，于是「抖音」在一级界面上
 * 根本不存在（抖音图文与抖音视频被拆进两个页签），而「今日头条文章」这种平台+类型混写的
 * 标签又和另外两个不同构。现在**平台做一级**，内容类型做二级。
 *
 * 设计要点：
 * - 一级页签带**该渠道的包数**（垃圾桶里的不算），计数为 0 时不显示数字；
 * - 二级子页签**只在「该渠道真的出现了多于一种内容类型」时才渲染** —— 只含一项的选择是假选择，
 *   而且会让「抖音」这种本来很清楚的页签平白多一行；
 * - 二级默认停在「全部」（`activeContentType === ''`），所以进入某个渠道永远看得到全貌；
 * - 选中项用 `aria-selected` 暴露（不靠颜色判断）；
 * - 选中渠道的 `hint` 摊在下方一行：说清谁在提交、需要什么前置条件 ——
 *   「不会自动上传」这件事必须写在界面上，不能让操作者以为它会自己发。
 */
import React from 'react';
import {
  PACKAGE_CONTENT_TYPE_LABELS,
  PUBLISH_CHANNELS,
  type PublishChannelId,
} from '../utils/publishing.js';
import type { PackageContentType } from '../types/index.js';
import { ChannelLogo } from './ui/PlatformLogo.js';
import { useRovingTabs } from './ui/useRovingTabs.js';

export function PublishingChannelTabs({
  active,
  counts,
  contentTypes,
  contentTypeCounts,
  activeContentType,
  onSelect,
  onSelectContentType,
}: {
  active: PublishChannelId;
  counts: Record<PublishChannelId, number>;
  /** 该渠道**当前实际出现**的内容类型（`channelContentTypes()` 的结果）；≤1 项时不渲染子页签。 */
  contentTypes: PackageContentType[];
  /** 子页签上的包数。 */
  contentTypeCounts: Partial<Record<PackageContentType, number>>;
  /** `''` = 全部内容类型（默认）。 */
  activeContentType: PackageContentType | '';
  onSelect: (channelId: PublishChannelId) => void;
  onSelectContentType: (contentType: PackageContentType | '') => void;
}) {
  const current = PUBLISH_CHANNELS.find((channel) => channel.id === active) ?? PUBLISH_CHANNELS[0]!;
  const showContentTypes = contentTypes.length > 1;
  const allCount = contentTypes.reduce((sum, type) => sum + (contentTypeCounts[type] ?? 0), 0);
  const tabs: Array<[PackageContentType | '', string]> = [
    ['', '全部'],
    ...contentTypes.map((type) => [type, PACKAGE_CONTENT_TYPE_LABELS[type]] as [PackageContentType, string]),
  ];

  // 两级页签各自一个「单一 Tab 停靠点」：组内用方向键切换，而不是让 Tab 一个个穿过
  const channelRoving = useRovingTabs(PUBLISH_CHANNELS.map((channel) => channel.id), active, (id) =>
    onSelect(id as PublishChannelId),
  );
  const contentTypeRoving = useRovingTabs(tabs.map(([id]) => id), activeContentType, (id) =>
    onSelectContentType(id as PackageContentType | ''),
  );

  return (
    <div className="mb-4 border-b border-line pb-3">
      <div
        role="tablist"
        aria-label="发布渠道"
        onKeyDown={channelRoving.onKeyDown}
        className="flex gap-2 overflow-x-auto"
      >
        {PUBLISH_CHANNELS.map((channel) => {
          const selected = channel.id === active;
          const count = counts[channel.id] ?? 0;
          return (
            <button
              key={channel.id}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={channelRoving.tabIndexFor(channel.id)}
              ref={(node) => { channelRoving.refs.current[channel.id] = node; }}
              data-testid={`publish-channel-${channel.id}`}
              onClick={() => onSelect(channel.id)}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ${
                selected
                  ? 'bg-accent-soft text-accent ring-1 ring-inset ring-accent-line'
                  : 'text-ink-muted hover:bg-elevated hover:text-ink'
              }`}
            >
              <ChannelLogo platforms={channel.platforms} size={selected ? 'md' : 'sm'} />
              {channel.label}
              {count > 0 && <span className="text-xs opacity-70 tabular">{count}</span>}
            </button>
          );
        })}
      </div>
      {showContentTypes && (
        <div
          role="tablist"
          aria-label="内容类型"
          onKeyDown={contentTypeRoving.onKeyDown}
          className="mt-2 flex gap-1.5 overflow-x-auto"
        >
          {tabs.map(([id, label]) => {
            const selected = id === activeContentType;
            const count = id === '' ? allCount : contentTypeCounts[id] ?? 0;
            return (
              <button
                key={id || 'all'}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={contentTypeRoving.tabIndexFor(id)}
                ref={(node) => { contentTypeRoving.refs.current[id] = node; }}
                data-testid={`publish-content-type-${id || 'all'}`}
                onClick={() => onSelectContentType(id)}
                className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-medium ${
                  selected
                    ? 'bg-elevated text-ink ring-1 ring-inset ring-line-strong'
                    : 'text-ink-muted hover:bg-elevated hover:text-ink'
                }`}
              >
                {label}
                {count > 0 && <span className="ml-1 tabular opacity-70">{count}</span>}
              </button>
            );
          })}
        </div>
      )}
      <p
        className="mt-3 border-l-2 border-line-strong pl-3 text-xs leading-5 text-ink-muted"
        data-testid="publish-channel-hint"
      >
        {current.hint}
      </p>
    </div>
  );
}
