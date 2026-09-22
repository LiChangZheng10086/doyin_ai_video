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
        className={`relative z-10 ${showImage ? 'bg-gradient-to-t from-black/75 via-black/20 to-transparent' : ''} ${
          compact ? 'flex h-full w-full items-center p-1.5' : 'w-full p-4'
        }`}
      >
        <p
          /*
           * ⚠️ 有图时文字必须**浅色**：它压在 `from-black/75` 的深色蒙版上。
           *
           * 这里原本是 `text-white`，在「品牌色底上的白字统一换成近黑字」那次批量替换里
           * 被改成了 `text-on-accent`（#0D0F12 近黑）—— 但这一处的底是**图片 + 黑色蒙版**，
           * 不是饱和色填充。结果作品列表里每个封面的标题都成了**黑字压黑底**：
           * 真机实测对比度 **1:1**，完全看不见（只有在真实数据下才暴露）。
           *
           * 用 `text-ink`（浅色主文字令牌）而不是 raw `text-white`：语义正确，也不引入原生调色板。
           */
          className={`line-clamp-2 font-semibold leading-tight ${showImage ? 'text-ink' : 'text-ink-muted'} ${
            compact ? 'text-[10px]' : 'text-sm'
          }`}
        >
          {title || '视频作品'}
        </p>
      </div>
    </div>
  );
}
