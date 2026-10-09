import { useEffect, useState } from 'react';
import type { VideoAudioOptions, AssetRecord } from '../../types';
import type { LocalSpeechCapabilities } from '../../../../src/lib/video-audio';
import { apiClient } from '../../services/api';

export function VideoAudioOptionsPanel({ value, onChange, disabled, canRegenerate, onRegenerate }: {
  value: VideoAudioOptions;
  onChange: (value: VideoAudioOptions) => void;
  disabled: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
}) {
  const [capabilities, setCapabilities] = useState<LocalSpeechCapabilities | null>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([apiClient.getVideoAudioCapabilities(), apiClient.getAssets('audio')]).then(([speech, audio]) => {
      if (active) { setCapabilities(speech); setAssets(audio); }
    }).catch(() => { if (active) setError('音频选项加载失败，当前选择已保留，请刷新后重试。'); });
    return () => { active = false; };
  }, []);
  return <details className="mb-5 rounded-lg border border-line bg-panel p-4">
    <summary className="cursor-pointer font-medium text-ink">成片配音与音乐{value.voiceover ? ' · 中文配音' : ''}{value.backgroundAssetId ? ' · 背景音乐' : ''}</summary>
    <p className="mt-3 text-sm text-ink-muted">选项在生成视频时应用。中文配音在本机合成，字幕跟随实际配音时间；音乐仅使用已入库素材。</p>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    <fieldset disabled={disabled} className="mt-4 grid gap-4 sm:grid-cols-2">
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={value.voiceover} disabled={!capabilities?.available}
          onChange={event => onChange({ ...value, voiceover: event.target.checked })} />生成中文配音与同步字幕</label>
        {capabilities?.reason && <p className="text-sm text-ink-muted">{capabilities.reason}</p>}
        {value.voiceover && <>
          <label className="block text-sm text-ink">中文系统语音<select className="mt-1 h-10 w-full rounded-lg border border-line-ui bg-panel px-2" value={value.voice ?? ''}
            onChange={event => onChange({ ...value, voice: event.target.value || undefined })}>
            <option value="">默认中文语音</option>{capabilities?.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.id}</option>)}
          </select></label>
          <label className="block text-sm text-ink">配音速度<select className="mt-1 h-10 w-full rounded-lg border border-line-ui bg-panel px-2" value={value.rate ?? 210}
            onChange={event => onChange({ ...value, rate: Number(event.target.value) })}>
            <option value={180}>舒缓</option><option value={210}>正常</option><option value={240}>较快</option>
          </select></label>
        </>}
      </div>
      <div className="space-y-3">
        <label className="block text-sm text-ink">背景音乐<select className="mt-1 h-10 w-full rounded-lg border border-line-ui bg-panel px-2" value={value.backgroundAssetId ?? ''}
          onChange={event => onChange({ ...value, backgroundAssetId: event.target.value || undefined })}>
          <option value="">不使用背景音乐</option>
          {value.backgroundAssetId && !assets.some(asset => asset.id === value.backgroundAssetId) && <option value={value.backgroundAssetId}>原音乐不可用，请重新选择</option>}
          {assets.map(asset => <option key={asset.id} value={asset.id}>{asset.originalName}{asset.audioSource?.previewOnly ? '（试听片段）' : ''}</option>)}
        </select></label>
        {value.backgroundAssetId && <label className="block text-sm text-ink">背景音乐音量 {Math.round((value.backgroundVolume ?? .12) * 100)}%
          <input className="mt-2 block w-full" type="range" min="0" max="50" step="1" value={Math.round((value.backgroundVolume ?? .12) * 100)}
            onChange={event => onChange({ ...value, backgroundVolume: Number(event.target.value) / 100 })} />
        </label>}
        <p className="text-xs text-ink-muted">配音时自动压低音乐，首尾淡入淡出。请选用有权使用的音频；试听片段只会循环该片段。</p>
      </div>
    </fieldset>
    {canRegenerate && <button type="button" disabled={disabled} onClick={onRegenerate} className="mt-4 rounded-lg border border-accent-line px-4 py-2 text-sm text-accent disabled:opacity-50">按当前音频选项重新生成视频</button>}
  </details>;
}
