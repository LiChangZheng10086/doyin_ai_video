import React from 'react';
import type { ShortVideoShot, ShotLayout, ShotType } from '../../../types/index';

export interface ShotArtifactProps {
  shot: ShortVideoShot;
}

export function ShotArtifact({ shot }: ShotArtifactProps) {
  const layers = shot.visualLayers ?? [];
  const captionLines = shot.captionLines?.length ? shot.captionLines : [shot.caption].filter(Boolean);
  const visualItems = shot.visualItems ?? [];

  return (
    <div className="rounded-lg border border-tech-border bg-gray-50 p-4">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold text-purple-600">镜头 {shot.index} · {formatShotType(shot.shotType)}</p>
          <h4 className="mt-1 text-base font-semibold text-tech-text">{shot.headline || shot.subject}</h4>
          {shot.supportingText && <p className="mt-1 text-sm text-tech-muted">{shot.supportingText}</p>}
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-tech-muted">
          <span className="rounded-full bg-white px-2 py-1">{formatSeconds(shot.duration)}</span>
          {shot.layout && <span className="rounded-full bg-white px-2 py-1">{formatLayout(shot.layout)}</span>}
          {shot.sourceKeyPoints?.length ? (
            <span className="rounded-full bg-white px-2 py-1">覆盖要点 {shot.sourceKeyPoints.map(i => i + 1).join('、')}</span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-purple-100 bg-white p-3">
        <label className="mb-1 block text-xs font-medium uppercase text-purple-500">字幕</label>
        {captionLines.map((line, index) => <p key={index} className="text-sm leading-6 text-tech-text">{line}</p>)}
      </div>

      {visualItems.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3">
          {visualItems.map((item, index) => (
            <div key={`${item.label}-${index}`} className="rounded-lg border border-tech-border bg-white p-3">
              <p className="text-xs text-tech-muted">{item.label}</p>
              {item.value && <p className="mt-1 font-semibold text-tech-text">{item.value}</p>}
            </div>
          ))}
        </div>
      )}

      <details className="mt-3 rounded-lg border border-tech-border bg-white p-3">
        <summary className="cursor-pointer text-sm font-medium text-tech-muted">制作信息</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <ProdMetric label="转场" value={shot.transition} />
          <ProdMetric label="节奏" value={shot.pacing} />
          <ProdMetric label="画面动作" value={shot.action} />
          <ProdMetric label="镜头运动" value={shot.cameraMotion} />
        </div>
        {layers.length > 0 && (
          <div className="mt-3 space-y-2">
            {layers.map((layer, index) => (
              <p key={`${layer.type}-${index}`} className="text-xs leading-5 text-tech-muted">
                {layer.type}: {[layer.content, layer.motion, layer.style].filter(Boolean).join(' · ')}
              </p>
            ))}
          </div>
        )}
        {shot.narration && <p className="mt-3 text-xs leading-5 text-tech-muted">内部口播稿：{shot.narration}</p>}
      </details>
    </div>
  );
}

function ProdMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 px-4 py-3">
      <label className="mb-1 block text-xs text-tech-muted">{label}</label>
      <p className="text-sm text-tech-text">{value}</p>
    </div>
  );
}

function formatShotType(type?: ShotType) {
  const labels: Record<ShotType, string> = {
    hook: '开场钩子', problem: '问题', explain: '解释', proof: '验证',
    contrast: '对比', process: '流程', summary: '总结', cta: '行动引导',
  };
  return type ? labels[type] : '内容镜头';
}

function formatLayout(layout: ShotLayout) {
  const labels: Record<ShotLayout, string> = {
    'kinetic-title': '动态标题', 'concept-map': '概念关系', 'process-flow': '流程图',
    comparison: '对比画面', metric: '数据状态', 'summary-stack': '总结收束',
  };
  return labels[layout];
}

function formatSeconds(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
