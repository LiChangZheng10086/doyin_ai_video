import React from 'react';
import type { RawTranscript } from '../../../types/index';

export interface TranscriptArtifactProps {
  transcript: RawTranscript | null;
  fallbackText?: string;
  transcriptError?: string | null;
}

export function TranscriptArtifact({ transcript, fallbackText, transcriptError }: TranscriptArtifactProps) {
  if (transcript) {
    return <TranscriptContent transcriptData={transcript} source="视频音频转录" />;
  }
  if (transcriptError) {
    return (
      <Notice tone="warning" title="视频转录不可用">
        {transcriptError}
      </Notice>
    );
  }
  if (fallbackText) {
    return (
      <div className="space-y-4">
        <Notice tone="info" title="使用分享文本作为后备">
          这是您输入的分享文本，不是视频的实际音频转录。
        </Notice>
        <TranscriptContent transcriptData={{ transcript: fallbackText }} source="分享文本（非转录）" />
      </div>
    );
  }
  return <EmptyContent title="暂无转录内容" description="完成视频转录后，这里会显示原始文案和分段。" />;
}

function TranscriptContent({ transcriptData, source }: { transcriptData: RawTranscript; source: string }) {
  const segments = transcriptData.segments ?? [];

  return (
    <div>
      <h3 className="text-lg font-semibold text-tech-text">{source}</h3>
      <p className="mt-1 text-xs text-tech-muted">
        {source === '视频音频转录'
          ? '这是从视频音频提取并转录的真实内容'
          : '这是从分享文本解析的内容，非实际音频转录'}
      </p>
      {(transcriptData.provider || transcriptData.model || transcriptData.duration) && (
        <div className="my-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {transcriptData.provider && <Metric label="服务" value={transcriptData.provider} />}
          {transcriptData.model && <Metric label="模型" value={transcriptData.model} />}
          {transcriptData.duration && <Metric label="时长" value={formatSeconds(transcriptData.duration)} />}
        </div>
      )}
      <div className="mt-4 rounded-lg bg-gray-50 p-4">
        <p className="whitespace-pre-wrap leading-relaxed text-tech-text">{transcriptData.transcript}</p>
      </div>
      {segments.length > 0 && (
        <div className="mt-5">
          <h4 className="mb-3 text-base font-semibold text-tech-text">转录分段</h4>
          <div className="space-y-2">
            {segments.map((segment, index) => (
              <div key={index} className="rounded-lg border border-tech-border bg-gray-50 p-3">
                <p className="mb-1 font-mono text-xs text-tech-muted">{formatRange(segment.start, segment.end)}</p>
                <p className="text-sm leading-relaxed text-tech-text">{segment.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-4 py-3">
      <label className="mb-1 block text-xs text-tech-muted">{label}</label>
      <p className="text-sm text-tech-text">{value}</p>
    </div>
  );
}

function Notice({ tone, title, children }: { tone: 'info' | 'warning' | 'danger'; title: string; children: React.ReactNode }) {
  const config = {
    info: 'border-blue-200 bg-blue-50 text-blue-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-700',
    danger: 'border-red-200 bg-red-50 text-red-700',
  }[tone];
  return (
    <div className={`rounded-lg border p-4 ${config}`}>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm">{children}</p>
    </div>
  );
}

function EmptyContent({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-tech-border bg-gray-50 py-14 text-center">
      <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-4 text-tech-muted"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <h3 className="font-semibold text-tech-text">{title}</h3>
      <p className="mt-2 text-sm text-tech-muted">{description}</p>
    </div>
  );
}

function formatSeconds(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatRange(start?: number, end?: number) {
  if (typeof start !== 'number' && typeof end !== 'number') return '时间未标记';
  return `${typeof start === 'number' ? formatSeconds(start) : '--'} - ${typeof end === 'number' ? formatSeconds(end) : '--'}`;
}
