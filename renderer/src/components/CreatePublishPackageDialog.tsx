import { useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, Loader2, Send, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiClient, parseApiError } from '../services/api';
import type { HyperframesVideoOutput, PublishPlatform, PublishingAssetInspection, PublishingPackageDetail } from '../types';
import {
  buildCreatePublishingInput,
  createPublishingWizardState,
  getPublishingScheduleStatus,
  PUBLISHING_PLATFORMS,
  publishingWizardReducer,
  type PublishingWizardStep,
} from '../utils/publishing';

const STEP_LABELS: Array<{ id: PublishingWizardStep; label: string }> = [
  { id: 'asset', label: '成片' },
  { id: 'platforms', label: '平台' },
  { id: 'copy', label: '文案' },
  { id: 'schedule', label: '排期' },
  { id: 'confirm', label: '确认' },
];

interface Props {
  jobId: string;
  title: string;
  output: HyperframesVideoOutput;
  onClose: () => void;
}

export function CreatePublishPackageDialog({ jobId, title, output, onClose }: Props) {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(publishingWizardReducer, undefined, () => createPublishingWizardState());
  const [activePlatform, setActivePlatform] = useState<PublishPlatform>('douyin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<PublishingPackageDetail | null>(null);
  const [assetInspection, setAssetInspection] = useState<PublishingAssetInspection | null>(null);
  const [assetLoading, setAssetLoading] = useState(true);
  const [assetError, setAssetError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById('root');
    appRoot?.setAttribute('aria-hidden', 'true');
    appRoot?.setAttribute('inert', '');
    dialogRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCloseRef.current();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      appRoot?.removeAttribute('aria-hidden');
      appRoot?.removeAttribute('inert');
      document.removeEventListener('keydown', onKeyDown);
      requestAnimationFrame(() => previousFocus.current?.focus());
    };
  }, []);

  useEffect(() => {
    let active = true;
    setAssetLoading(true);
    setAssetError('');
    void apiClient.inspectPublishingAssets(jobId)
      .then((assets) => { if (active) setAssetInspection(assets); })
      .catch((requestError) => { if (active) setAssetError(parseApiError(requestError).message); })
      .finally(() => { if (active) setAssetLoading(false); });
    return () => { active = false; };
  }, [jobId]);

  const advance = async () => {
    setError('');
    if (state.step !== 'platforms') {
      dispatch({ type: 'advance' });
      return;
    }
    if (state.selectedPlatforms.length === 0) {
      dispatch({ type: 'advance' });
      return;
    }
    setBusy(true);
    try {
      const preview = await apiClient.previewPublishing(jobId, state.selectedPlatforms);
      dispatch({ type: 'load-preview', preview, step: 'copy' });
      setActivePlatform(state.selectedPlatforms[0]);
    } catch (requestError) {
      setError(parseApiError(requestError).message);
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (platform: PublishPlatform) => {
    setBusy(true);
    setError('');
    try {
      const preview = await apiClient.previewPublishing(jobId, [platform]);
      const generated = preview.copies[platform];
      if (!generated) throw new Error('未生成该平台文案');
      dispatch({
        type: 'replace-draft',
        platform,
        draft: {
          copy: { title: generated.title, description: generated.description, hashtags: [...generated.hashtags] },
          copySource: generated.copySource,
          scheduledAt: state.drafts[platform]?.scheduledAt ?? '',
        },
      });
    } catch (requestError) {
      setError(parseApiError(requestError).message);
    } finally {
      setBusy(false);
    }
  };

  const createPackage = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await apiClient.createPublishingPackage(
        buildCreatePublishingInput(state, jobId, title),
      );
      setCreated(result);
    } catch (requestError) {
      setError(parseApiError(requestError).message);
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="publish-dialog-title" className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-tech-border bg-tech-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-tech-border px-5 py-4">
          <div>
            <h2 id="publish-dialog-title" className="text-lg font-semibold text-tech-text">加入发布中心</h2>
            <p className="mt-1 text-sm text-tech-muted">准备本地交付包，发布仍由你在平台完成。</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭" className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-tech-muted hover:bg-tech-bg hover:text-tech-text disabled:opacity-50">
            <X size={18} />
          </button>
        </header>

        {!created && (
          <div className="border-b border-tech-border px-5 py-3">
            <ol className="grid grid-cols-5 gap-2">
              {STEP_LABELS.map((step, index) => {
                const current = STEP_LABELS.findIndex((item) => item.id === state.step);
                const active = index === current;
                const done = index < current;
                return (
                  <li key={step.id} className={`flex min-w-0 items-center gap-2 text-xs ${active ? 'font-semibold text-tech-blue' : done ? 'text-emerald-600' : 'text-tech-muted'}`}>
                    <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${active ? 'border-tech-blue bg-blue-50' : done ? 'border-emerald-300 bg-emerald-50' : 'border-tech-border'}`}>
                      {done ? <Check size={13} /> : index + 1}
                    </span>
                    <span className="truncate">{step.label}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {created ? (
            <SuccessView detail={created} onClose={onClose} onOpen={() => navigate('/publishing')} />
          ) : state.step === 'asset' ? (
            <AssetStep output={output} inspection={assetInspection} loading={assetLoading} />
          ) : state.step === 'platforms' ? (
            <PlatformStep selected={state.selectedPlatforms} error={state.platformError} onToggle={(platform) => dispatch({ type: 'toggle-platform', platform })} />
          ) : state.step === 'copy' ? (
            <CopyStep state={state} active={activePlatform} onActive={setActivePlatform} onEdit={(platform, field, value) => dispatch({ type: 'edit-draft', platform, field, value })} onRegenerate={regenerate} busy={busy} />
          ) : state.step === 'schedule' ? (
            <ScheduleStep state={state} onChange={(platform, value) => dispatch({ type: 'set-schedule', platform, value })} />
          ) : (
            <ConfirmStep title={title} state={state} />
          )}
          {state.preview?.warning && <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{state.preview.warning.message}</p>}
          {assetError && state.step === 'asset' && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">资产检查失败：{assetError}</p>}
          {error && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>}
        </div>

        {!created && (
          <footer className="flex items-center justify-between border-t border-tech-border px-5 py-4">
            <button type="button" onClick={() => state.step === 'asset' ? onClose() : dispatch({ type: 'back' })} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-tech-border px-4 py-2 text-sm font-medium text-tech-text hover:bg-tech-bg disabled:opacity-50">
              <ChevronLeft size={16} /> {state.step === 'asset' ? '取消' : '上一步'}
            </button>
            {state.step === 'confirm' ? (
              <button type="button" onClick={() => void createPackage()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-tech-purple px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} 创建发布包
              </button>
            ) : (
              <button type="button" onClick={() => void advance()} disabled={busy || (state.step === 'asset' && assetLoading)} className="inline-flex items-center gap-2 rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white hover:bg-tech-blue-dark disabled:opacity-50">
                {busy || (state.step === 'asset' && assetLoading) ? <Loader2 size={16} className="animate-spin" /> : <ChevronRight size={16} />} 下一步
              </button>
            )}
          </footer>
        )}
      </section>
    </div>
  );
  return typeof document === 'undefined' ? null : createPortal(dialog, document.body);
}

function AssetStep({ output, inspection, loading }: { output: HyperframesVideoOutput; inspection: PublishingAssetInspection | null; loading: boolean }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-tech-text">确认成片资产</h3>
        <p className="mt-1 text-sm text-tech-muted">发布包会保存独立 MP4，删除源作品不会影响它。</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border border-tech-border p-4 sm:grid-cols-3">
        <Info label="文件" value={inspection?.filename ?? output.videoPath.split(/[\\/]/u).pop() ?? 'video.mp4'} />
        <Info label="尺寸" value={`${inspection?.width ?? output.width} x ${inspection?.height ?? output.height}`} />
        <Info label="时长" value={`${Math.round(inspection?.duration ?? output.duration)} 秒`} />
        <Info label="比例" value={output.aspectRatio} />
        <Info label="文件大小" value={inspection ? formatBytes(inspection.size) : loading ? '检查中...' : '-'} />
        <Info label="预计额外占用" value={inspection ? `最多 ${formatBytes(inspection.estimatedAdditionalBytes)}` : loading ? '检查中...' : '-'} />
        <Info label="封面候选" value={inspection ? inspection.coverAvailable ? '已找到本地封面' : '未找到，将尝试抽帧' : loading ? '检查中...' : '-'} />
      </dl>
      {inspection?.warnings.map((warning) => <p key={warning.code} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning.message}</p>)}
    </div>
  );
}

function PlatformStep({ selected, error, onToggle }: { selected: PublishPlatform[]; error?: string; onToggle: (platform: PublishPlatform) => void }) {
  return (
    <div>
      <h3 className="text-base font-semibold text-tech-text">选择发布平台</h3>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {PUBLISHING_PLATFORMS.map((platform) => (
          <label key={platform.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-4 ${selected.includes(platform.id) ? 'border-tech-purple bg-purple-50' : 'border-tech-border hover:bg-tech-bg'}`}>
            <input type="checkbox" checked={selected.includes(platform.id)} onChange={() => onToggle(platform.id)} className="h-4 w-4 accent-tech-purple" />
            <span className="font-medium text-tech-text">{platform.label}</span>
          </label>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
    </div>
  );
}

function CopyStep({ state, active, onActive, onEdit, onRegenerate, busy }: {
  state: ReturnType<typeof createPublishingWizardState>;
  active: PublishPlatform;
  onActive: (platform: PublishPlatform) => void;
  onEdit: (platform: PublishPlatform, field: 'title' | 'description' | 'hashtags', value: string | string[]) => void;
  onRegenerate: (platform: PublishPlatform) => Promise<void>;
  busy: boolean;
}) {
  const platform = state.selectedPlatforms.includes(active) ? active : state.selectedPlatforms[0];
  const draft = state.drafts[platform];
  const policy = PUBLISHING_PLATFORMS.find((item) => item.id === platform)!;
  const errors = state.fieldErrors.filter((item) => item.platform === platform);
  if (!draft) return <p className="text-sm text-tech-muted">正在准备平台文案...</p>;
  return (
    <div>
      <div className="flex gap-2 overflow-x-auto border-b border-tech-border pb-3">
        {state.selectedPlatforms.map((id) => (
          <button key={id} type="button" onClick={() => onActive(id)} className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ${id === platform ? 'bg-purple-50 text-tech-purple' : 'text-tech-muted hover:bg-tech-bg'}`}>
            {PUBLISHING_PLATFORMS.find((item) => item.id === id)?.label}
          </button>
        ))}
      </div>
      <div className="mt-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-tech-muted">来源：{draft.copySource === 'ai' ? 'AI 生成' : draft.copySource === 'user_edited' ? '已编辑' : '洗稿回退'}</span>
          <button type="button" onClick={() => void onRegenerate(platform)} disabled={busy} className="text-sm font-medium text-tech-blue disabled:opacity-50">重新生成此平台</button>
        </div>
        <TextField label="标题" value={draft.copy.title} count={[...draft.copy.title].length} limit={policy.titleMax} onChange={(value) => onEdit(platform, 'title', value)} />
        <label className="block text-sm font-medium text-tech-text">正文 <span className="float-right text-xs font-normal text-tech-muted">{[...draft.copy.description].length}/{policy.descriptionMax}</span>
          <textarea value={draft.copy.description} onChange={(event) => onEdit(platform, 'description', event.target.value)} rows={7} className="mt-2 w-full resize-y rounded-lg border border-tech-border px-3 py-2 text-sm outline-none focus:border-tech-blue focus:ring-2 focus:ring-blue-100" />
        </label>
        <TextField label="标签（空格分隔）" value={draft.copy.hashtags.join(' ')} count={draft.copy.hashtags.length} limit={policy.hashtagMax} onChange={(value) => onEdit(platform, 'hashtags', value.split(/\s+/u).filter(Boolean))} />
        {errors.map((item) => <p key={`${item.field}-${item.message}`} className="text-sm text-red-600">{item.message}</p>)}
      </div>
    </div>
  );
}

function ScheduleStep({ state, onChange }: { state: ReturnType<typeof createPublishingWizardState>; onChange: (platform: PublishPlatform, value: string) => void }) {
  return <div className="space-y-3"><h3 className="text-base font-semibold text-tech-text">设置平台排期</h3>{state.selectedPlatforms.map((platform) => {
    const draft = state.drafts[platform]!;
    return <div key={platform} className="grid gap-3 rounded-lg border border-tech-border p-4 sm:grid-cols-[1fr_1.4fr] sm:items-center"><div><p className="font-medium text-tech-text">{PUBLISHING_PLATFORMS.find((item) => item.id === platform)?.label}</p><p className="text-xs text-tech-muted">{getPublishingScheduleStatus(draft.scheduledAt) === 'scheduled' ? '到期后提醒发布' : '立即进入待发布'}</p></div><input type="datetime-local" value={draft.scheduledAt} onChange={(event) => onChange(platform, event.target.value)} className="rounded-lg border border-tech-border px-3 py-2 text-sm outline-none focus:border-tech-blue focus:ring-2 focus:ring-blue-100" /></div>;
  })}<p className="text-xs text-tech-muted">清空或选择当前/过去时间，会立即进入待发布。</p></div>;
}

function ConfirmStep({ title, state }: { title: string; state: ReturnType<typeof createPublishingWizardState> }) {
  const schedules = state.selectedPlatforms.map((id) => {
    const label = PUBLISHING_PLATFORMS.find((item) => item.id === id)?.label;
    const value = state.drafts[id]?.scheduledAt;
    return `${label}：${value && getPublishingScheduleStatus(value) === 'scheduled' ? new Date(value).toLocaleString('zh-CN') : '立即待发布'}`;
  }).join('；');
  const video = state.preview?.video;
  return <div className="space-y-4"><h3 className="text-base font-semibold text-tech-text">确认发布包</h3><dl className="divide-y divide-tech-border rounded-lg border border-tech-border px-4"><InfoRow label="作品" value={title} /><InfoRow label="版本" value={`v${state.preview?.nextVersion ?? '-'}`} /><InfoRow label="平台" value={state.selectedPlatforms.map((id) => PUBLISHING_PLATFORMS.find((item) => item.id === id)?.label).join('、')} /><InfoRow label="视频大小" value={video ? formatBytes(video.size) : '-'} /><InfoRow label="真实封面" value={video?.coverAvailable ? '已找到，将复制到发布包' : '未找到，请在发布平台内选择封面'} /><InfoRow label="排期" value={schedules} /><InfoRow label="保存位置" value={state.preview?.expectedPackagePath ?? '-'} /></dl><p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">创建后请在发布中心复制文案、打开官方平台并手动发布。本应用不会保存平台账号或自动上传。</p></div>;
}

function SuccessView({ detail, onClose, onOpen }: { detail: PublishingPackageDetail; onClose: () => void; onOpen: () => void }) {
  return <div className="py-8 text-center"><span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><Check size={24} /></span><h3 className="mt-4 text-xl font-semibold text-tech-text">发布包已创建</h3><p className="mt-2 text-sm text-tech-muted">v{detail.package.version} · {detail.tasks.length} 个平台任务</p><div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row"><button type="button" onClick={onClose} className="rounded-lg border border-tech-border px-4 py-2 text-sm font-medium text-tech-text hover:bg-tech-bg">继续查看成片</button><button type="button" onClick={onOpen} className="rounded-lg bg-tech-purple px-4 py-2 text-sm font-medium text-white hover:opacity-90">前往发布中心</button></div></div>;
}

function Info({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs text-tech-muted">{label}</dt><dd className="mt-1 break-all text-sm font-medium text-tech-text">{value}</dd></div>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div className="grid gap-1 py-3 sm:grid-cols-[7rem_1fr]"><dt className="text-sm text-tech-muted">{label}</dt><dd className="break-all text-sm font-medium text-tech-text">{value}</dd></div>; }
function TextField({ label, value, count, limit, onChange }: { label: string; value: string; count: number; limit: number; onChange: (value: string) => void }) { return <label className="block text-sm font-medium text-tech-text">{label}<span className={`float-right text-xs font-normal ${count > limit ? 'text-red-600' : 'text-tech-muted'}`}>{count}/{limit}</span><input value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 w-full rounded-lg border border-tech-border px-3 py-2 text-sm outline-none focus:border-tech-blue focus:ring-2 focus:ring-blue-100" /></label>; }
function formatBytes(value: number) { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`; }
