import React, { useState, useEffect } from 'react';

export interface ContentPreviewProps {
  title: string;
  imageUrl?: string;
  compact?: boolean;
}

export function ContentPreview({ title, imageUrl, compact = false }: ContentPreviewProps) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [imageUrl]);
  const showImage = Boolean(imageUrl) && !imageFailed;

  return (
    <div
      className={`shrink-0 overflow-hidden rounded-lg border border-line bg-canvas ${
        compact
          ? 'relative h-12 w-20'
          : 'relative flex aspect-[9/16] w-full max-w-[200px] items-end'
      }`}
    >
      {showImage && (
        <img
          src={imageUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      )}
      <div
        className={`relative z-10 ${showImage ? 'bg-black/70' : ''} ${
          compact ? 'flex h-full w-full items-center p-1.5' : 'w-full p-4'
        }`}
      >
        <p
          /*
           * 有图时标题区整体用 70% 黑蒙版，连白图上的紧凑标题也保持 AA。
           *
           * 这里原本是 `text-white`，在「品牌色底上的白字统一换成近黑字」那次批量替换里
           * 被改成了 `text-on-accent`（#0D0F12 近黑）—— 但这一处的底是**图片 + 黑色蒙版**，
           * 不是饱和色填充。结果作品列表里每个封面的标题都成了**黑字压黑底**：
           * 真机实测对比度 **1:1**，完全看不见（只有在真实数据下才暴露）。
           *
           * 用固定浅色 `text-on-media`：浅色主题也不能让蒙版上的标题变成深字。
           */
          className={`line-clamp-2 font-semibold leading-tight ${showImage ? 'text-on-media' : 'text-ink-muted'} ${
            compact ? 'text-[10px]' : 'text-sm'
          }`}
        >
          {title || '视频作品'}
        </p>
      </div>
    </div>
  );
}
