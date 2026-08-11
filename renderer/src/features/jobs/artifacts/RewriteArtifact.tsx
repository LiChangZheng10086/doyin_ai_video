import React from 'react';
import type { CleanedScript } from '../../../types/index';

export interface RewriteArtifactProps {
  cleaned: CleanedScript | null;
  cleanedError: string | null;
}

export function RewriteArtifact({ cleaned, cleanedError }: RewriteArtifactProps) {
  if (cleanedError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
        <p className="font-semibold">AI 洗稿失败</p>
        <p className="mt-1 text-sm">{cleanedError}</p>
      </div>
    );
  }

  const output = cleaned?.output;

  if (!output || (!output.cleanScript && !output.summary)) {
    return <EmptyContent title="AI 成果还没生成" description="完成 AI 洗稿后，这里会展示标题、摘要、核心要点和成稿。" />;
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-tech-text">AI 洗稿成果</h3>
        <p className="mt-1 text-sm text-tech-muted">面向二次创作的标题、摘要、要点和成稿。</p>
      </div>
      {output.title && <ContentBlock label="标题" value={output.title} strong />}
      {output.summary && <ContentBlock label="摘要" value={output.summary} />}
      {output.keyPoints && output.keyPoints.length > 0 && (
        <div>
          <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">核心要点</label>
          <div className="space-y-2">
            {output.keyPoints.map((point, index) => (
              <p key={index} className="rounded-lg bg-gray-50 px-4 py-3 text-sm text-tech-text">{point}</p>
            ))}
          </div>
        </div>
      )}
      {output.cleanScript && <ContentBlock label="清洗后的脚本" value={output.cleanScript} multiline />}
      {output.qualityNotes && output.qualityNotes.length > 0 && (
        <div className="space-y-2">
          {output.qualityNotes.map((note, index) => (
            <p key={index} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">{note}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function ContentBlock({ label, value, strong = false, multiline = false }: { label: string; value: string; strong?: boolean; multiline?: boolean }) {
  return (
    <div>
      <label className="mb-2 block text-xs font-medium uppercase text-tech-muted">{label}</label>
      <div className="rounded-lg bg-gray-50 px-4 py-3">
        <p className={`${strong ? 'text-xl font-semibold' : 'text-sm'} ${multiline ? 'whitespace-pre-wrap leading-7' : ''} text-tech-text`}>
          {value}
        </p>
      </div>
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
