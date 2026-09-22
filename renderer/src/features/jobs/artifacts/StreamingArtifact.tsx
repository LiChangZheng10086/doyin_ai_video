import React from 'react';
import { Loader2 } from 'lucide-react';
import type { AiStreamPreview } from '../../../types/index';

export function StreamingArtifact({
  kind,
  preview,
}: {
  kind: 'clean' | 'shots';
  preview: AiStreamPreview;
}) {
  const title = kind === 'clean' ? '正在生成 AI 洗稿' : '正在生成分镜';
  const isActive = preview.status === 'connecting' || preview.status === 'streaming';
  const displayText = kind === 'clean' ? extractCleanStreamText(preview.text) : preview.text;
  const stateLabel = preview.status === 'paused'
    ? '已暂停，未保存'
    : preview.status === 'error'
      ? '生成失败，未保存'
      : preview.status === 'completed'
        ? '正在整理正式成果'
        : '生成中，尚未保存';

  return (
    <section className="rounded-lg border border-ai-line bg-ai-soft/60 p-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {isActive && <Loader2 size={17} className="animate-spin text-ai" />}
          <h3 className="font-semibold text-ink">{title}</h3>
          <span className="rounded-md border border-ai-line bg-panel px-2 py-1 text-xs text-ai">
            {stateLabel}
          </span>
        </div>
        <div className="flex gap-3 text-xs text-ink-muted">
          {preview.model && <span>{preview.model}</span>}
          <span>{preview.receivedLength} 个字符</span>
        </div>
      </div>
      {preview.message && <p className="mt-3 text-sm text-warning">{preview.message}</p>}
      <div className={`mt-4 max-h-80 overflow-auto rounded-lg border text-ai bg-panel p-4 text-sm leading-7 text-ink ${kind === 'shots' ? 'whitespace-pre-wrap font-mono' : 'whitespace-pre-wrap'}`}>
        {displayText || '正在等待模型返回内容...'}
      </div>
    </section>
  );
}

function extractCleanStreamText(raw: string) {
  for (const field of ['short_video_script', 'clean_script', 'summary', 'hook', 'title']) {
    const value = readJsonStringField(raw, field);
    if (value) return value;
  }
  return raw.trim().startsWith('{') ? '' : raw;
}

function readJsonStringField(raw: string, field: string) {
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(raw);
  if (!match) return '';
  let value = '';
  let escaped = false;
  for (let index = match.index + match[0].length; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '"' && !escaped) break;
    value += character;
    escaped = character === '\\' && !escaped;
    if (character !== '\\') escaped = false;
  }
  try {
    return JSON.parse(`"${value.replace(/\\$/u, '')}"`) as string;
  } catch {
    return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}
