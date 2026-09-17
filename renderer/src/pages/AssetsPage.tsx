import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Images, Loader2, Music4, Trash2, Upload } from 'lucide-react';
import { Layout } from '../components/Layout';
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
      setError(err instanceof Error ? err.message : '素材加载失败');
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
      className="inline-flex items-center gap-2 rounded-lg bg-tech-blue px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-tech-blue-dark disabled:opacity-50"
    >
      {uploading === kind ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
      {uploading === kind ? '上传中…' : label}
    </button>
  );

  const renderEmpty = (icon: typeof Images, title: string, hint: string) => (
    <div className="rounded-lg border border-dashed border-tech-border bg-tech-surface px-6 py-14 text-center">
      <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-lg border border-tech-border bg-tech-bg text-tech-muted">
        {icon === Images ? <Images size={28} /> : <AudioLines size={28} />}
      </div>
      <h3 className="text-lg font-semibold text-tech-text">{title}</h3>
      <p className="mt-2 text-sm text-tech-muted">{hint}</p>
    </div>
  );

  return (
    <Layout>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-tech-text">素材</h1>
          <p className="mt-1 text-sm text-tech-muted">
            手动上传图片与音频，供后续创作选用。
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      )}
      {uploadError && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">{uploadError}</div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-24 text-tech-muted">
          <Loader2 size={20} className="mr-2 animate-spin" />
          正在加载素材…
        </div>
      ) : (
        <div className="space-y-8">
          {/* 图片 */}
          <section>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 font-semibold text-tech-text">
                  <Images size={18} className="text-tech-muted" />
                  图片 <span className="text-sm font-normal text-tech-muted">({images.length})</span>
                </h2>
                <p className="mt-1 text-xs text-tech-muted">支持 jpg / png / webp，单张不超过 20MB。建议 9:16 竖版。</p>
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
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {images.map((record) => (
                  <figure key={record.id} className="overflow-hidden rounded-lg border border-tech-border bg-tech-surface">
                    <div className="aspect-[9/16] w-full bg-tech-bg">
                      {rawUrls[record.id] && (
                        <img
                          src={rawUrls[record.id]}
                          alt={record.originalName}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      )}
                    </div>
                    <figcaption className="space-y-1 p-3">
                      <p className="truncate text-sm text-tech-text" title={record.originalName}>{record.originalName}</p>
                      <p className="text-xs text-tech-muted">
                        {record.width && record.height ? `${record.width}×${record.height} · ` : ''}
                        {formatBytes(record.bytes)} · {formatDate(record.createdAt)}
                      </p>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(record)}
                        className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline"
                      >
                        <Trash2 size={13} />
                        删除
                      </button>
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
                <h2 className="flex items-center gap-2 font-semibold text-tech-text">
                  <Music4 size={18} className="text-tech-muted" />
                  音频 <span className="text-sm font-normal text-tech-muted">({audio.length})</span>
                </h2>
                <p className="mt-1 text-xs text-tech-muted">支持 mp3 / wav / m4a / aac，单个不超过 50MB。</p>
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
            <div className="mb-4 rounded-lg border border-tech-border bg-gray-50 px-4 py-3 text-sm text-tech-muted">
              音频暂未接入成片，本轮仅支持上传与试听。
            </div>

            {audio.length === 0 ? (
              renderEmpty(AudioLines, '还没有音频素材', '上传后可以在这里试听与管理。')
            ) : (
              <ul className="space-y-3">
                {audio.map((record) => (
                  <li key={record.id} className="rounded-lg border border-tech-border bg-tech-surface p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-tech-text" title={record.originalName}>
                          {record.originalName}
                        </p>
                        <p className="mt-1 text-xs text-tech-muted">
                          {formatDuration(record.durationMs)} · {formatBytes(record.bytes)} · {formatDate(record.createdAt)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(record)}
                        className="inline-flex items-center gap-1 text-xs text-red-600 hover:underline"
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
