import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, AudioLines, Images, Loader2, Music4, Trash2, Upload } from 'lucide-react';
import { Layout } from '../components/Layout';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { apiClient } from '../services/api';
import type { AssetKind, AssetRecord } from '../types';

const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp';
const AUDIO_ACCEPT = '.mp3,.wav,.m4a,.aac';
const MAX_FILES_PER_UPLOAD = 20;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return '—';
  const totalSeconds = Math.round(durationMs / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN');
}

export function AssetsPage() {
  const [images, setImages] = useState<AssetRecord[]>([]);
  const [audio, setAudio] = useState<AssetRecord[]>([]);
  const [rawUrls, setRawUrls] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<AssetKind | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssetRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [loadedImages, loadedAudio] = await Promise.all([
        apiClient.getAssets('image'),
        apiClient.getAssets('audio'),
      ]);
      setImages(loadedImages);
      setAudio(loadedAudio);
      const urls: Record<string, string> = {};
      for (const record of [...loadedImages, ...loadedAudio]) {
        urls[record.id] = await apiClient.getAssetRawUrl(record.id);
      }
      setRawUrls(urls);
    } catch (err) {
      /*
       * 改造前这里直接取 `err.message`，于是用户看到的是
       * 「Request failed with status code 502」这种 axios 英文原文。
       * 各页口径也不一致（作品列表用的是中文友好文案）。
       */
      console.error('加载素材失败:', err);
      setError('素材加载失败，请检查后端服务是否正常运行');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUpload = useCallback(async (kind: AssetKind, fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setUploadError(null);

    if (files.length > MAX_FILES_PER_UPLOAD) {
      setUploadError(`单次最多上传 ${MAX_FILES_PER_UPLOAD} 个文件，当前选了 ${files.length} 个`);
      return;
    }

    setUploading(kind);
    try {
      await apiClient.uploadAssets(kind, files);
      await load();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploading(null);
    }
  }, [load]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiClient.deleteAsset(deleteTarget.id);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, load]);

  const renderUploadButton = (kind: AssetKind, label: string) => (
    <button
      type="button"
      disabled={uploading !== null}
      onClick={() => (kind === 'image' ? imageInput.current : audioInput.current)?.click()}
      className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-on-accent transition-all hover:bg-accent-hover disabled:opacity-50"
    >
      {uploading === kind ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
      {uploading === kind ? '上传中…' : label}
    </button>
  );

  const renderEmpty = (icon: typeof Images, title: string, hint: string) => (
    <div className="rounded-lg border border-dashed border-line bg-panel px-6 py-14 text-center">
      <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-lg border border-line bg-canvas text-ink-muted">
        {icon === Images ? <Images size={28} /> : <AudioLines size={28} />}
      </div>
      <h3 className="text-lg font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm text-ink-muted">{hint}</p>
    </div>
  );

  return (
    <Layout>
      <PageHeader title="素材" description="手动上传图片与音频，供后续创作选用。" />

      {/* ⚠️ 只在已有素材时显示横幅；一份都没有时改由下面的整页错误态独占。 */}
      {error && (images.length > 0 || audio.length > 0) && (
        <div className="mb-4 rounded-lg border border-danger-line bg-danger-soft p-4 text-sm text-danger" role="alert">{error}</div>
      )}
      {uploadError && (
        <div className="mb-4 rounded-lg border border-warning-line bg-warning-soft p-4 text-sm text-warning">{uploadError}</div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-24 text-ink-muted">
          <Loader2 size={20} className="mr-2 animate-spin" aria-hidden="true" />
          正在加载素材…
        </div>
      ) : error && images.length === 0 && audio.length === 0 ? (
        <div className="rounded-xl border border-line bg-panel">
          <EmptyState
            icon={AlertCircle}
            title="素材加载失败"
            description={error}
            action={<Button variant="outline" onClick={() => void load()}>重新加载</Button>}
          />
        </div>
      ) : (
        <div className="space-y-8">
          {/* 图片 */}
          <section>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 font-semibold text-ink">
                  <Images size={18} className="text-ink-muted" />
                  图片 <span className="text-sm font-normal text-ink-muted">({images.length})</span>
                </h2>
                <p className="mt-1 text-xs text-ink-muted">支持 jpg / png / webp，单张不超过 20MB。建议 9:16 竖版。</p>
              </div>
              {renderUploadButton('image', '上传图片')}
              <input
                ref={imageInput}
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                className="hidden"
                onChange={(event) => {
                  void handleUpload('image', event.target.files);
                  event.target.value = '';
                }}
              />
            </div>

            {images.length === 0 ? (
              renderEmpty(Images, '还没有图片素材', '上传图片后，创建图文发布时可以从这里挑选。')
            ) : (
              /*
               * 自适应密排：改造前是 `lg:grid-cols-4`，在 1440px 下每格 ~332px 宽，
               * 而缩略图是 9:16 ⇒ 每张 332×590px，一个几十张的素材库要滚好几屏，
               * 完全不是素材浏览器该有的密度。改成按最小宽度自动排：
               * 同一屏从 4 张变 8 张，且窄窗口自动降列。
               */
              <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
                {images.map((record) => (
                  <figure key={record.id} className="overflow-hidden rounded-lg border border-line bg-panel">
                    <div className="aspect-[9/16] w-full bg-canvas">
                      {rawUrls[record.id] && (
                        <img
                          src={rawUrls[record.id]}
                          alt={record.originalName}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      )}
                    </div>
                    <figcaption className="space-y-1 p-2.5">
                      <div className="flex items-center gap-1">
                        <p className="min-w-0 flex-1 truncate text-sm text-ink" title={record.originalName}>
                          {record.originalName}
                        </p>
                        {/*
                          删除改成 32×32 的图标按钮。
                          改造前是一行 12px 的文字链，热区约 18px 高 —— 而它是每张卡片上
                          唯一的破坏性操作，既难点中也容易误点（审查 M13）。
                          无障碍名带上文件名，读屏不会只念「删除」。
                        */}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`删除「${record.originalName}」`}
                          onClick={() => setDeleteTarget(record)}
                          className="text-danger hover:bg-danger-soft"
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </Button>
                      </div>
                      <p
                        className="truncate text-xs tabular text-ink-muted"
                        title={`${record.width && record.height ? `${record.width}×${record.height} · ` : ''}${formatBytes(record.bytes)} · ${formatDate(record.createdAt)}`}
                      >
                        {record.width && record.height ? `${record.width}×${record.height} · ` : ''}
                        {formatBytes(record.bytes)}
                      </p>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </section>

          {/* 音频 */}
          <section>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 font-semibold text-ink">
                  <Music4 size={18} className="text-ink-muted" />
                  音频 <span className="text-sm font-normal text-ink-muted">({audio.length})</span>
                </h2>
                <p className="mt-1 text-xs text-ink-muted">支持 mp3 / wav / m4a / aac，单个不超过 50MB。</p>
              </div>
              {renderUploadButton('audio', '上传音频')}
              <input
                ref={audioInput}
                type="file"
                accept={AUDIO_ACCEPT}
                multiple
                className="hidden"
                onChange={(event) => {
                  void handleUpload('audio', event.target.files);
                  event.target.value = '';
                }}
              />
            </div>

            {/* 这条提示是刻意的：上传的音频目前不会混进成片 */}
            <div className="mb-4 rounded-lg border border-line bg-elevated px-4 py-3 text-sm text-ink-muted">
              音频暂未接入成片，本轮仅支持上传与试听。
            </div>

            {audio.length === 0 ? (
              renderEmpty(AudioLines, '还没有音频素材', '上传后可以在这里试听与管理。')
            ) : (
              <ul className="space-y-3">
                {audio.map((record) => (
                  <li key={record.id} className="rounded-lg border border-line bg-panel p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink" title={record.originalName}>
                          {record.originalName}
                        </p>
                        <p className="mt-1 text-xs text-ink-muted">
                          {formatDuration(record.durationMs)} · {formatBytes(record.bytes)} · {formatDate(record.createdAt)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(record)}
                        className="inline-flex items-center gap-1 text-xs text-danger hover:underline"
                      >
                        <Trash2 size={13} />
                        删除
                      </button>
                    </div>
                    {rawUrls[record.id] && (
                      <audio src={rawUrls[record.id]} controls preload="none" className="mt-3 w-full" />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除素材"
        description={`确定删除「${deleteTarget?.originalName ?? ''}」吗？此操作不可恢复。`}
        confirmLabel="删除"
        tone="danger"
        busy={deleting}
        onConfirm={() => void handleDelete()}
        onClose={() => setDeleteTarget(null)}
      />
    </Layout>
  );
}
