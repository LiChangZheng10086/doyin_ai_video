import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText } from 'lucide-react';
import { apiClient, parseApiError } from '../services/api';
import type {
  AssetRecord,
  NoteImageSource,
  PlatformCopy,
  PublishingPreview,
  ToutiaoPublishOptions,
} from '../types/index';
import {
  TOUTIAO_DECLARATIONS,
  buildToutiaoArticleInput,
  defaultToutiaoOptions,
  getToutiaoCoverBlocker,
  toggleDeclaration,
  toutiaoArticleFieldErrors,
} from '../utils/toutiaoArticle';

/**
 * 创建「头条文章包」向导（与视频/图文向导相互独立）。
 *
 * 流程：AI 成文（服务端在预览里给出，含兜底提示）→ 选封面（**头条必填**，单选）→
 * 编辑标题/正文 → 勾选发布选项（首发 / 作品声明 / 同步微头条，默认全关）→ 建包。
 *
 * 三条纪律：
 * ① **AI 兜底必须显示**：`articleFallback` 存在时明确告诉用户「这不是 AI 写的」，
 *    否则用户会以为那就是模型产出（绝不静默）；
 * ② **封面必填**：静帧一张都没有时直接阻塞并说明替代方案，而不是等到提交才失败；
 * ③ **没有预览就不发请求**（组装函数里直接抛错）——`previewRevision` 是服务端硬约束。
 */
interface Props {
  jobId: string;
  title: string;
  onClose: () => void;
}

const EMPTY_OPTIONS: ToutiaoPublishOptions = defaultToutiaoOptions();

export function CreateToutiaoArticleDialog({ jobId, title, onClose }: Props) {
  const [source, setSource] = useState<NoteImageSource>('frames');
  const [libraryImages, setLibraryImages] = useState<AssetRecord[]>([]);
  const [libraryUrls, setLibraryUrls] = useState<Record<string, string>>({});
  const [libraryError, setLibraryError] = useState('');
  const [selectedCoverId, setSelectedCoverId] = useState('');
  const [articleTitle, setArticleTitle] = useState('');
  const [articleBody, setArticleBody] = useState('');
  const [options, setOptions] = useState<ToutiaoPublishOptions>(EMPTY_OPTIONS);
  const [preview, setPreview] = useState<PublishingPreview | undefined>(undefined);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ id: string; version: number } | undefined>(undefined);
  const copyTouched = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // 素材库图片（封面候选）：与图文向导同一套做法 —— 带会话取 blob 再转成绝对 URL。
  useEffect(() => {
    let cancelled = false;
    void apiClient.getAssets('image').then(async (records) => {
      if (cancelled) return;
      setLibraryImages(records);
      const entries = await Promise.all(records.map(async (record) => {
        const url = await apiClient.getAssetRawUrl(record.id).catch(() => '');
        return [record.id, url] as const;
      }));
      if (!cancelled) setLibraryUrls(Object.fromEntries(entries));
    }).catch((loadError: unknown) => {
      if (!cancelled) setLibraryError(parseApiError(loadError).message);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const runPreview = useCallback(async (nextSource: NoteImageSource, coverAssetId: string) => {
    if (nextSource === 'library' && !coverAssetId) {
      // 素材库还没选封面：不必发一个注定被拒的请求。
      setPreview(undefined);
      return;
    }
    setPreviewing(true);
    setPreviewError('');
    try {
      const result = await apiClient.previewPublishing(
        jobId,
        ['toutiao'],
        'article',
        nextSource === 'library' ? { imageSource: nextSource, imageAssetIds: [coverAssetId] } : { imageSource: nextSource },
      );
      setPreview(result);
      // 用户改过文字后不再被预览结果覆盖（否则编辑会被悄悄吞掉）。
      if (!copyTouched.current) {
        setArticleTitle(result.articleCopy?.title ?? '');
        setArticleBody(result.articleCopy?.body ?? '');
      }
    } catch (previewFailure) {
      setPreview(undefined);
      setPreviewError(parseApiError(previewFailure).message);
    } finally {
      setPreviewing(false);
    }
  }, [jobId]);

  useEffect(() => {
    void runPreview(source, selectedCoverId);
  }, [runPreview, source, selectedCoverId]);

  const limits = preview?.articleLimits;
  const framesCount = source === 'frames' ? (preview?.articleCover ? 1 : 0) : 0;
  const coverBlocker = getToutiaoCoverBlocker({
    source,
    framesCount: source === 'frames' ? (previewing ? 1 : framesCount) : 0,
    libraryCount: libraryImages.length,
    hasSelection: selectedCoverId.length > 0,
  });
  const fieldErrors = limits ? toutiaoArticleFieldErrors(articleTitle, articleBody, limits) : [];
  const canCreate = Boolean(preview) && !coverBlocker && fieldErrors.length === 0 && !previewing && !busy;

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const input = buildToutiaoArticleInput({
        sourceJobId: jobId,
        title,
        preview,
        articleTitle,
        articleBody,
        options,
        source,
        ...(selectedCoverId ? { coverAssetId: selectedCoverId } : {}),
      });
      const detail = await apiClient.createPublishingPackage(input);
      setCreated({ id: detail.package.id, version: detail.package.version });
    } catch (createError) {
      setError(parseApiError(createError).message);
    } finally {
      setBusy(false);
    }
  };

  if (typeof document === 'undefined') return null;

  const dialog = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="创建头条文章包"
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <header className="border-b border-tech-border px-5 py-4">
          <h2 className="text-base font-medium text-tech-text">创建头条文章包</h2>
          <p className="mt-1 text-xs text-tech-muted">
            AI 会把这条作品的转录与洗稿结果写成一篇头条文章。今日头条要求**必须有封面**（会裁成 16:9）。
          </p>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {created ? (
            <div className="space-y-2">
              <p className="text-sm text-emerald-700">
                已创建头条文章包 v{created.version}（封面 16:9、正文已渲染）。
              </p>
              <p className="text-sm text-tech-muted">
                接下来到「发布中心」预览这篇文章，确认后再点「提交到头条号」。
              </p>
            </div>
          ) : (
            <>
              {/* 封面（单选，必填） */}
              <section className="space-y-2">
                <p className="text-sm font-medium text-tech-text">封面（必填，单图）</p>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="toutiao-cover-source"
                      checked={source === 'frames'}
                      onChange={() => {
                        setSource('frames');
                        setSelectedCoverId('');
                      }}
                    />
                    用场景静帧
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="toutiao-cover-source"
                      checked={source === 'library'}
                      onChange={() => setSource('library')}
                    />
                    从素材库选
                  </label>
                </div>

                {source === 'frames' ? (
                  <p className="text-xs text-tech-muted">
                    使用该作品生成视频时的第一张场景静帧（1080×1920），服务端会裁成 16:9。
                  </p>
                ) : libraryImages.length === 0 ? (
                  <p className="text-xs text-tech-muted">
                    素材库里还没有图片，请先到左侧「素材」页上传（jpg/png/webp，单张 ≤20MB）。
                  </p>
                ) : (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                    {libraryImages.map((image) => (
                      <button
                        key={image.id}
                        type="button"
                        aria-pressed={selectedCoverId === image.id}
                        aria-label={selectedCoverId === image.id ? `已选封面：${image.originalName}` : `选择封面 ${image.originalName}`}
                        onClick={() => setSelectedCoverId(selectedCoverId === image.id ? '' : image.id)}
                        className={`overflow-hidden rounded-lg border ${selectedCoverId === image.id ? 'border-tech-blue ring-2 ring-tech-blue' : 'border-tech-border'}`}
                      >
                        {libraryUrls[image.id] ? (
                          <img src={libraryUrls[image.id]} alt={image.originalName} className="h-20 w-full object-cover" />
                        ) : (
                          <span className="block h-20 w-full bg-tech-bg" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {libraryError ? <p className="text-xs text-red-600">{libraryError}</p> : null}
                {coverBlocker ? (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{coverBlocker}</p>
                ) : null}
              </section>

              {/* AI 成文结果 */}
              <section className="space-y-2">
                <p className="text-sm font-medium text-tech-text">文章</p>
                {previewing ? <p className="text-xs text-tech-muted">正在生成文章…</p> : null}
                {previewError ? (
                  <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{previewError}</p>
                ) : null}
                {/* AI 走兜底时必须显眼：否则用户会以为这是模型写的（绝不静默）。 */}
                {preview?.articleFallback ? (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
                    {preview.articleFallback.message}
                  </p>
                ) : null}
                <label className="block text-xs text-tech-muted">
                  标题{limits ? `（${[...articleTitle].length}/${limits.titleMax}，至少 ${limits.titleMin}）` : ''}
                  <input
                    value={articleTitle}
                    onChange={(event) => {
                      copyTouched.current = true;
                      setArticleTitle(event.target.value);
                    }}
                    className="mt-1 w-full rounded-lg border border-tech-border px-3 py-2 text-sm text-tech-text"
                  />
                </label>
                <label className="block text-xs text-tech-muted">
                  正文（`## ` 开头的行会渲染成小标题）
                  <textarea
                    value={articleBody}
                    onChange={(event) => {
                      copyTouched.current = true;
                      setArticleBody(event.target.value);
                    }}
                    rows={12}
                    className="mt-1 w-full rounded-lg border border-tech-border px-3 py-2 font-mono text-sm text-tech-text"
                  />
                </label>
                {fieldErrors.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-xs text-red-600">
                    {fieldErrors.map((message) => <li key={message}>{message}</li>)}
                  </ul>
                ) : null}
              </section>

              {/* 发布选项 */}
              <section className="space-y-2">
                <p className="text-sm font-medium text-tech-text">发布选项</p>
                <label className="flex items-center gap-2 text-sm text-tech-text">
                  <input
                    type="checkbox"
                    checked={options.firstPublish}
                    onChange={(event) => setOptions({ ...options, firstPublish: event.target.checked })}
                  />
                  勾选「头条首发」
                </label>
                <label className="flex items-center gap-2 text-sm text-tech-text">
                  <input
                    type="checkbox"
                    checked={options.crossPostWeitoutiao}
                    onChange={(event) => setOptions({ ...options, crossPostWeitoutiao: event.target.checked })}
                  />
                  同时发布微头条（**默认不勾**：头条发布页默认是勾上的，我们会在发布前显式取消并校验）
                </label>
                <div className="space-y-1">
                  <p className="text-xs text-tech-muted">作品声明（可多选，不选即不声明）</p>
                  <div className="flex flex-wrap gap-2">
                    {TOUTIAO_DECLARATIONS.map((item) => {
                      const active = options.declarations.includes(item.value);
                      return (
                        <button
                          key={item.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setOptions({ ...options, declarations: toggleDeclaration(options.declarations, item.value) })}
                          className={`rounded-full border px-3 py-1 text-xs ${active ? 'border-tech-blue bg-blue-50 text-tech-blue' : 'border-tech-border text-tech-muted'}`}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>

              {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-tech-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-tech-border px-4 py-2 text-sm text-tech-muted"
          >
            {created ? '关闭' : '取消'}
          </button>
          {!created ? (
            <button
              type="button"
              onClick={() => void create()}
              disabled={!canCreate}
              className="inline-flex items-center gap-2 rounded-lg bg-tech-purple px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileText size={16} />
              创建文章包
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}

/** 供组件用例复用的纯净展示壳（避免为了渲染而真的去打接口）。 */
export interface ToutiaoArticleFormProps {
  source: NoteImageSource;
  articleTitle: string;
  articleBody: string;
  options: ToutiaoPublishOptions;
  limits?: { titleMin: number; titleMax: number; bodyChars: number };
  fallbackMessage?: string;
  coverBlocker?: string | null;
  fieldErrors?: string[];
  created?: { id: string; version: number };
  onClose: () => void;
  onCreate: () => void;
}

export function ToutiaoArticleFormView({
  source,
  articleTitle,
  articleBody,
  options,
  limits,
  fallbackMessage,
  coverBlocker,
  fieldErrors = [],
  created,
  onClose,
  onCreate,
}: ToutiaoArticleFormProps) {
  const blocked = Boolean(coverBlocker) || fieldErrors.length > 0;
  return (
    <div role="dialog" aria-label="创建头条文章包" className="space-y-4">
      <h2 className="text-base font-medium text-tech-text">创建头条文章包</h2>
      {created ? (
        <p className="text-sm text-emerald-700">已创建头条文章包 v{created.version}</p>
      ) : null}
      <p className="text-sm text-tech-muted">封面来源：{source === 'frames' ? '场景静帧' : '素材库'}</p>
      {fallbackMessage ? <p role="status" className="text-xs text-amber-800">{fallbackMessage}</p> : null}
      <p className="text-sm text-tech-text">标题：{articleTitle}{limits ? `（${[...articleTitle].length}/${limits.titleMax}）` : ''}</p>
      <pre className="whitespace-pre-wrap text-sm text-tech-text">{articleBody}</pre>
      <p className="text-sm text-tech-muted">
        头条首发：{options.firstPublish ? '是' : '否'} · 同时发布微头条：{options.crossPostWeitoutiao ? '是' : '否'}
        {' · '}
        声明：{options.declarations.length > 0 ? options.declarations.join('、') : '（无）'}
      </p>
      {coverBlocker ? <p className="text-xs text-amber-800">{coverBlocker}</p> : null}
      {fieldErrors.length > 0 ? <p className="text-xs text-red-600">{fieldErrors.join('；')}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose}>{created ? '关闭' : '取消'}</button>
        {!created ? (
          <button type="button" onClick={onCreate} disabled={blocked}>创建文章包</button>
        ) : null}
      </div>
    </div>
  );
}
