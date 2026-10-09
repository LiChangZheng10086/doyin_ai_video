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
      <h3 className="text-lg font-semibold text-ink">{source}</h3>
      <p className="mt-1 text-xs text-ink-muted">
        {source === '视频音频转录'
          ? '本地模型从视频音频识别的文字，可能有错字或漏识别，请结合原视频核对。'
          : '这是从分享文本解析的内容，非实际音频转录'}
      </p>
      {!!transcriptData.qualityIssues?.length && <div role="alert" className="mt-4 rounded-lg border border-warning-line bg-warning-soft p-4 text-sm text-warning">
        <p className="font-medium">检测到转录异常，旧文字仅供参考，请重新转录后再用于创作。</p>
        {transcriptData.qualityIssues.map((issue, i) => <p key={i} className="mt-1">{issue}</p>)}
      </div>}
      {(transcriptData.provider || transcriptData.model || transcriptData.duration) && (
        <div className="my-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {transcriptData.provider && <Metric label="服务" value={transcriptData.provider} />}
          {transcriptData.model && <Metric label="模型" value={transcriptData.model} />}
          {transcriptData.duration && <Metric label="时长" value={formatSeconds(transcriptData.duration)} />}
        </div>
      )}
      <div className="mt-4 rounded-lg bg-elevated p-4">
        <p className="whitespace-pre-wrap leading-relaxed text-ink">{transcriptData.transcript}</p>
      </div>
      {segments.length > 0 && (
        <div className="mt-5">
          <h4 className="mb-3 text-base font-semibold text-ink">转录分段</h4>
          <div className="space-y-2">
            {segments.map((segment, index) => (
              <div key={index} className="rounded-lg border border-line bg-elevated p-3">
                <p className="mb-1 font-mono text-xs text-ink-muted">{formatRange(segment.start, segment.end)}</p>
                <p className="text-sm leading-relaxed text-ink">{segment.text}</p>
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
    <div className="rounded-lg bg-elevated px-4 py-3">
      <label className="mb-1 block text-xs text-ink-muted">{label}</label>
      <p className="text-sm text-ink">{value}</p>
    </div>
  );
}

function Notice({ tone, title, children }: { tone: 'info' | 'warning' | 'danger'; title: string; children: React.ReactNode }) {
  const config = {
    info: 'border-info-line bg-info-soft text-info',
    warning: 'border-warning-line bg-warning-soft text-warning',
    danger: 'border-danger-line bg-danger-soft text-danger',
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
    <div className="rounded-lg border border-dashed border-line bg-elevated py-14 text-center">
      <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-4 text-ink-muted"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <h3 className="font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm text-ink-muted">{description}</p>
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
