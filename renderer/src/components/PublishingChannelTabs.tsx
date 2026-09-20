/**
 * 发布中心的一级「渠道」页签（抖音图文 / 今日头条文章 / 视频人工交付）。
 *
 * 立项理由：此前一条列表把「抖音图文（自动提交）」「今日头条文章（自动提交）」
 * 「视频（纯人工交付）」混在一屏，只能靠平台下拉过滤，状态计数也混在一起
 * （见 spec `2026-09-18-publishing-channel-tabs-design.md`）。
 *
 * 设计要点：
 * - 页签带**该渠道的包数**（垃圾桶里的不算），计数为 0 时不显示数字；
 * - 选中项用 `aria-selected` 暴露（不靠颜色判断）；
 * - 选中渠道的 `hint` 摊在下方一行：说清谁在提交、需要什么前置条件 ——
 *   「视频人工交付不会自动上传」这件事必须写在界面上，不能让操作者以为它会自己发。
 */
import React from 'react';
import { PUBLISH_CHANNELS, type PublishChannelId } from '../utils/publishing.js';

export function PublishingChannelTabs({
  active,
  counts,
  onSelect,
}: {
  active: PublishChannelId;
  counts: Record<PublishChannelId, number>;
  onSelect: (channelId: PublishChannelId) => void;
}) {
  const current = PUBLISH_CHANNELS.find((channel) => channel.id === active) ?? PUBLISH_CHANNELS[0]!;

  return (
    <div className="mb-4 border-b border-tech-border pb-3">
      <div role="tablist" aria-label="发布渠道" className="flex gap-2 overflow-x-auto">
        {PUBLISH_CHANNELS.map((channel) => {
          const selected = channel.id === active;
          const count = counts[channel.id] ?? 0;
          return (
            <button
              key={channel.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`publish-channel-${channel.id}`}
              onClick={() => onSelect(channel.id)}
              className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold ${
                selected
                  ? 'bg-tech-blue/10 text-tech-blue ring-1 ring-tech-blue/30'
                  : 'text-tech-muted hover:bg-tech-surface hover:text-tech-text'
              }`}
            >
              {channel.label}
              {count > 0 && <span className="ml-1.5 text-xs opacity-70">{count}</span>}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs leading-5 text-tech-muted" data-testid="publish-channel-hint">
        {current.hint}
      </p>
    </div>
  );
}
