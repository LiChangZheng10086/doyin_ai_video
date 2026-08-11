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
      className={`shrink-0 overflow-hidden rounded-lg bg-gradient-to-br from-tech-blue via-tech-purple to-tech-purple-dark text-white ${
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
        <p className={`line-clamp-2 font-semibold leading-tight ${compact ? 'text-[10px]' : 'text-sm'}`}>
          {title || '视频作品'}
        </p>
      </div>
    </div>
  );
}
