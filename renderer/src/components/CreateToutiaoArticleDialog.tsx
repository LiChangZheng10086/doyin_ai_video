import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePromptPanel } from './ImagePromptPanel';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
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
  platform?: 'toutiao' | 'wechat_mp';
  onClose: () => void;
}

const EMPTY_OPTIONS: ToutiaoPublishOptions = defaultToutiaoOptions();

export function CreateToutiaoArticleDialog({ jobId, title, onClose, platform = 'toutiao' }: Props) {
  const wechat = platform === 'wechat_mp';
  const platformName = wechat ? '公众号' : '头条';
  const [author, setAuthor] = useState('');
  const [digest, setDigest] = useState('');
  const [bodyImageIds, setBodyImageIds] = useState<string[]>([]);
  const [source, setSource] = useState<NoteImageSource>('frames');
  const [libraryImages, setLibraryImages] = useState<AssetRecord[]>([]);
  const [libraryUrls, setLibraryUrls] = useState<Record<string, string>>({});
  const [libraryError, setLibraryError] = useState('');
  const [libraryTotal, setLibraryTotal] = useState(0); const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState(''); const [appliedQuery, setAppliedQuery] = useState('');
  const [imageCache, setImageCache] = useState<Record<string, AssetRecord>>({});
  const [showPrompts, setShowPrompts] = useState(false);
  const [promptGuard, setPromptGuard] = useState({ dirty: false, busy: false });
  const promptChanged = useCallback((dirty: boolean, busy: boolean) => setPromptGuard({ dirty, busy }), []);
  const librarySequence = useRef(0);
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
  const previewSequence = useRef(0);

  /*
   * 焦点、Esc、滚动锁、#root inert 全部交给共享 `Modal`。
   * 改造前这里是自研的：只有 `dialogRef.current?.focus()`（**打开时把焦点放到容器上**，
   * 而不是第一个可聚焦控件）、没有 inert、也没有关闭后的焦点归位 ——
   * 关掉弹窗后键盘用户会失去位置（焦点落回 body）。
   */
  const refreshLibrary = useCallback(async (query = appliedQuery) => {
    const sequence = ++librarySequence.current; setLibraryLoading(true); setLibraryError('');
    try {
      const result = await apiClient.searchImageAssets(query);
      const entries = await Promise.all(result.assets.map(async record => [record.id, await apiClient.getAssetRawUrl(record.id)] as const));
      if (sequence !== librarySequence.current) return;
      setLibraryImages(result.assets); setLibraryTotal(result.total); setAppliedQuery(query);
      setImageCache(previous => ({ ...previous, ...Object.fromEntries(result.assets.map(record => [record.id, record])) }));
      setLibraryUrls(previous => ({ ...previous, ...Object.fromEntries(entries) }));
    } catch (e) { if (sequence === librarySequence.current) setLibraryError(parseApiError(e).message); }
    finally { if (sequence === librarySequence.current) setLibraryLoading(false); }
  }, [appliedQuery]);
  useEffect(() => { void refreshLibrary(''); return () => { librarySequence.current++; previewSequence.current++; }; }, []);
  const close = () => {
    if (busy || promptGuard.busy) return;
    if (!created && (promptGuard.dirty || copyTouched.current) && !window.confirm('文章或提示词有未保存内容，放弃并关闭？')) return;
    onClose();
  };
  useEffect(() => {
    if (!promptGuard.dirty && !promptGuard.busy) return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [promptGuard]);

  const runPreview = useCallback(async (nextSource: NoteImageSource, coverAssetId: string) => {
    const sequence = ++previewSequence.current;
    if (nextSource === 'library' && !coverAssetId) {
      // 素材库还没选封面：不必发一个注定被拒的请求。
      setPreview(undefined);
      setPreviewing(false);
      setPreviewError('');
      return;
    }
    setPreviewing(true);
    setPreview(undefined);
    setPreviewError('');
    try {
      const result = await apiClient.previewPublishing(
        jobId,
        [platform],
        'article',
        { imageSource: nextSource, ...(nextSource === 'library' ? { imageAssetIds: [coverAssetId] } : {}), ...(wechat && bodyImageIds.length ? { articleImageAssetIds: bodyImageIds } : {}) },
      );
      if (sequence !== previewSequence.current) return;
      setPreview(result);
      // 用户改过文字后不再被预览结果覆盖（否则编辑会被悄悄吞掉）。
      if (!copyTouched.current) {
        setArticleTitle(result.articleCopy?.title ?? '');
        setArticleBody(result.articleCopy?.body ?? '');
        setAuthor(result.articleCopy?.author ?? '');
        setDigest(result.articleCopy?.digest ?? '');
      }
    } catch (previewFailure) {
      if (sequence !== previewSequence.current) return;
      setPreview(undefined);
      setPreviewError(parseApiError(previewFailure).message);
    } finally {
      if (sequence === previewSequence.current) setPreviewing(false);
    }
  }, [jobId, platform, wechat, bodyImageIds]);

  useEffect(() => {
    void runPreview(source, selectedCoverId);
  }, [runPreview, source, selectedCoverId]);

  const limits = preview?.articleLimits;
  const framesCount = source === 'frames' ? (preview?.articleCover ? 1 : 0) : 0;
  const coverBlocker = getToutiaoCoverBlocker({
    source,
    framesCount: source === 'frames' ? (previewing ? 1 : framesCount) : 0,
    libraryCount: libraryTotal,
    hasSelection: selectedCoverId.length > 0,
  });
  const fieldErrors = limits ? toutiaoArticleFieldErrors(articleTitle, articleBody, limits) : [];
  const canCreate = Boolean(preview) && !coverBlocker && fieldErrors.length === 0 && !previewing && !busy && !promptGuard.busy && !promptGuard.dirty;

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
        platform,
        author,
        digest,
        articleImageAssetIds: bodyImageIds,
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

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      busy={busy || promptGuard.busy}
      title={`创建${platformName}文章包`}
      subtitle={
        <p className="text-xs text-ink-muted">
          {wechat ? 'AI 成文后提交到公众号草稿箱，绝不自动发布。封面会裁成约 2.35:1，正文图按选择顺序插入各段后。' : 'AI 会把这条作品的转录与洗稿结果写成一篇头条文章。今日头条要求必须有封面（会裁成 16:9）。'}
        </p>
      }
      footer={
        <>
          <Button variant="outline" onClick={close}>{created ? '关闭' : '取消'}</Button>
          {!created && (
            <Button variant="ai" onClick={() => void create()} disabled={!canCreate}>
              <FileText size={16} aria-hidden="true" />
              创建文章包
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
          {created ? (
            <div className="space-y-2">
              <p className="text-sm text-success">
                已创建{platformName}文章包 v{created.version}（正文已渲染）。
              </p>
              <p className="text-sm text-ink-muted">
                接下来到「发布中心」预览这篇文章，确认后再点「{wechat ? '提交到公众号草稿箱' : '提交到头条号'}」。
              </p>
            </div>
          ) : (
            <>
              <ArticleImageSearch query={libraryQuery} loading={libraryLoading} total={libraryTotal} count={libraryImages.length} showPrompts={showPrompts} onQuery={setLibraryQuery}
                onSearch={() => void refreshLibrary(libraryQuery)} onReset={() => { setLibraryQuery(''); void refreshLibrary(''); }}
                onTogglePrompts={() => { if (!promptGuard.busy && (!showPrompts || !promptGuard.dirty || window.confirm('提示词面板有未保存内容，放弃并返回文章？'))) setShowPrompts(value => !value); }} />
              {showPrompts && <ImagePromptPanel referenceText={[articleTitle || title, articleBody].filter(Boolean).join('\n\n')} defaultAspectRatio={wechat ? '2.35:1' : '16:9'} onAssetsChanged={refreshLibrary} onDirtyChange={promptChanged} />}
              <ArticleImageSelectionSummary wechat={wechat} cover={selectedCoverId ? imageCache[selectedCoverId] ?? { id: selectedCoverId, originalName: '已选图片（待核对）' } : undefined}
                bodyImages={bodyImageIds.map(id => imageCache[id] ?? { id, originalName: '已选图片（待核对）' })} onRemoveCover={() => setSelectedCoverId('')} onRemoveBody={id => setBodyImageIds(ids => ids.filter(value => value !== id))} />
              {/* 封面（单选，必填） */}
              <section className="space-y-2">
                <p className="text-sm font-medium text-ink">封面（必填，单图）</p>
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
                  <p className="text-xs text-ink-muted">
                    使用第一张场景静帧，服务端会裁成{wechat ? '约 2.35:1' : '16:9'}。
                  </p>
                ) : libraryImages.length === 0 ? (
                  <p className="text-xs text-ink-muted">
                    {appliedQuery ? '没有匹配图片，请换短关键词或点击「全部图片」；已选图片仍保留。' : '素材库里还没有图片，可展开「图片提示词」生成后上传，或到「素材」页上传。'}
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
                        className={`overflow-hidden rounded-lg border ${selectedCoverId === image.id ? 'border-accent-line ring-2 ring-accent' : 'border-line'}`}
                        title={[image.description, image.tags?.join('，')].filter(Boolean).join(' · ')}
                      >
                        {libraryUrls[image.id] ? (
                          <img src={libraryUrls[image.id]} alt={image.originalName} className="h-20 w-full object-cover" />
                        ) : (
                          <span className="block h-20 w-full bg-canvas" />
                        )}
                        <span className="block truncate px-1 py-1 text-xs text-ink-muted">{image.description || image.originalName}</span>
                      </button>
                    ))}
                  </div>
                )}
                {libraryError ? <p className="text-xs text-danger">{libraryError}</p> : null}
                {coverBlocker ? (
                  <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">{wechat ? coverBlocker.replace(/头条/g, '公众号') : coverBlocker}</p>
                ) : null}
              </section>

              {wechat ? <section className="space-y-2">
                <p className="text-sm font-medium text-ink">正文配图（可选，按点选顺序）</p>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {libraryImages.map(image => <button key={image.id} type="button" aria-pressed={bodyImageIds.includes(image.id)}
                    onClick={() => setBodyImageIds(ids => ids.includes(image.id) ? ids.filter(id => id !== image.id) : [...ids, image.id])}
                    className={`rounded-lg border p-1 text-xs ${bodyImageIds.includes(image.id) ? 'border-accent-line text-accent' : 'border-line text-ink-muted'}`}>
                    {libraryUrls[image.id] ? <img src={libraryUrls[image.id]} alt="" className="h-16 w-full object-cover" /> : null}
                    {bodyImageIds.includes(image.id) ? `${bodyImageIds.indexOf(image.id) + 1}. ` : ''}{image.originalName}
                  </button>)}
                </div>
                <p className="text-xs text-ink-muted">没有图片也可建草稿；添加图片请先上传到素材库。</p>
              </section> : null}

              {/* AI 成文结果 */}
              <section className="space-y-2">
                <p className="text-sm font-medium text-ink">文章</p>
                {previewing ? <p className="text-xs text-ink-muted">正在生成文章…</p> : null}
                {previewError ? (
                  <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{previewError}</p>
                ) : null}
                {/* AI 走兜底时必须显眼：否则用户会以为这是模型写的（绝不静默）。 */}
                {preview?.articleFallback ? (
                  <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning" role="status">
                    {preview.articleFallback.message}
                  </p>
                ) : null}
                <label className="block text-xs text-ink-muted">
                  标题{limits ? `（${[...articleTitle].length}/${limits.titleMax}，至少 ${limits.titleMin}）` : ''}
                  <input
                    value={articleTitle}
                    onChange={(event) => {
                      copyTouched.current = true;
                      setArticleTitle(event.target.value);
                    }}
                    className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm text-ink"
                  />
                </label>
                <label className="block text-xs text-ink-muted">
                  正文（`## ` 开头的行会渲染成小标题）
                  <textarea
                    value={articleBody}
                    onChange={(event) => {
                      copyTouched.current = true;
                      setArticleBody(event.target.value);
                    }}
                    rows={12}
                    className="mt-1 w-full rounded-lg border border-line px-3 py-2 font-mono text-sm text-ink"
                  />
                </label>
                {wechat ? <>
                  <label className="block text-xs text-ink-muted">作者（可选）<input value={author} onChange={event => { copyTouched.current = true; setAuthor(event.target.value); }} className="mt-1 w-full rounded border border-line p-2 text-ink" /></label>
                  <label className="block text-xs text-ink-muted">摘要（可选，留空由微信提取）<textarea value={digest} onChange={event => { copyTouched.current = true; setDigest(event.target.value); }} className="mt-1 w-full rounded border border-line p-2 text-ink" /></label>
                </> : null}
                {fieldErrors.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-xs text-danger">
                    {fieldErrors.map((message) => <li key={message}>{message}</li>)}
                  </ul>
                ) : null}
              </section>

              {/* 发布选项 */}
              {!wechat ? <section className="space-y-2">
                <p className="text-sm font-medium text-ink">发布选项</p>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={options.firstPublish}
                    onChange={(event) => setOptions({ ...options, firstPublish: event.target.checked })}
                  />
                  勾选「头条首发」
                </label>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={options.crossPostWeitoutiao}
                    onChange={(event) => setOptions({ ...options, crossPostWeitoutiao: event.target.checked })}
                  />
                  同时发布微头条（默认不勾：头条发布页默认是勾上的，我们会在发布前显式取消并校验）
                </label>
                <div className="space-y-1">
                  <p className="text-xs text-ink-muted">作品声明（可多选，不选即不声明）</p>
                  <div className="flex flex-wrap gap-2">
                    {TOUTIAO_DECLARATIONS.map((item) => {
                      const active = options.declarations.includes(item.value);
                      return (
                        <button
                          key={item.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setOptions({ ...options, declarations: toggleDeclaration(options.declarations, item.value) })}
                          className={`rounded-full border px-3 py-1 text-xs ${active ? 'border-accent-line bg-accent-soft text-accent' : 'border-line text-ink-muted'}`}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section> : null}

              {wechat ? <p className="text-sm text-ink-muted">只保存公众号草稿，正式发布须由你在公众号后台操作。权限不足时可下载 HTML 和图片手工编辑。</p> : null}
              {error ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}
            </>
          )}
      </div>
    </Modal>
  );
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
      <h2 className="text-base font-medium text-ink">创建头条文章包</h2>
      {created ? (
        <p className="text-sm text-success">已创建头条文章包 v{created.version}</p>
      ) : null}
      <p className="text-sm text-ink-muted">封面来源：{source === 'frames' ? '场景静帧' : '素材库'}</p>
      {fallbackMessage ? <p role="status" className="text-xs text-warning">{fallbackMessage}</p> : null}
      <p className="text-sm text-ink">标题：{articleTitle}{limits ? `（${[...articleTitle].length}/${limits.titleMax}）` : ''}</p>
      <pre className="whitespace-pre-wrap text-sm text-ink">{articleBody}</pre>
      <p className="text-sm text-ink-muted">
        头条首发：{options.firstPublish ? '是' : '否'} · 同时发布微头条：{options.crossPostWeitoutiao ? '是' : '否'}
        {' · '}
        声明：{options.declarations.length > 0 ? options.declarations.join('、') : '（无）'}
      </p>
      {coverBlocker ? <p className="text-xs text-warning">{coverBlocker}</p> : null}
      {fieldErrors.length > 0 ? <p className="text-xs text-danger">{fieldErrors.join('；')}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose}>{created ? '关闭' : '取消'}</button>
        {!created ? (
          <button type="button" onClick={onCreate} disabled={blocked}>创建文章包</button>
        ) : null}
      </div>
    </div>
  );
}


export function ArticleImageSearch({ query, loading, total, count, showPrompts, onQuery, onSearch, onReset, onTogglePrompts }: {
  query: string; loading: boolean; total: number; count: number; showPrompts: boolean;
  onQuery: (query: string) => void; onSearch: () => void; onReset: () => void; onTogglePrompts: () => void;
}) {
  return <section className="space-y-2 rounded-lg border border-line p-3">
    <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); onSearch(); }}>
      <label className="min-w-0 flex-1 text-sm text-ink">图片关键词<input className="mt-1 w-full rounded-lg border border-line-ui bg-canvas p-2 text-ink" maxLength={200} placeholder="例如：海边 日落（空格分隔）" value={query} onChange={e => onQuery(e.target.value)} /></label>
      <Button type="submit" disabled={loading}>{loading ? '搜索中…' : '搜索图片'}</Button><Button disabled={loading} onClick={onReset}>全部图片</Button>
      <Button aria-expanded={showPrompts} onClick={onTogglePrompts}>{showPrompts ? '返回文章选图' : '图片提示词'}</Button>
    </form>
    <p className="text-xs text-ink-muted">候选 {count} / 共 {total} 张。封面与正文配图共用搜索；筛选不会取消已选图片。</p>
  </section>;
}
export function ArticleImageSelectionSummary({ cover, bodyImages, wechat, onRemoveCover, onRemoveBody }: {
  cover?: Pick<AssetRecord, 'id' | 'originalName'>; bodyImages: Pick<AssetRecord, 'id' | 'originalName'>[]; wechat: boolean;
  onRemoveCover: () => void; onRemoveBody: (id: string) => void;
}) {
  if (!cover && (!wechat || !bodyImages.length)) return null;
  return <div className="space-y-2 rounded-lg border border-line bg-elevated p-3 text-sm text-ink">
    {cover && <p className="flex flex-wrap items-center gap-2"><span className="break-words">已选封面：{cover.originalName}</span><Button size="sm" onClick={onRemoveCover}>取消封面</Button></p>}
    {wechat && bodyImages.length > 0 && <><p>正文配图顺序</p><ol className="space-y-1">{bodyImages.map((image, index) => <li key={image.id} className="flex flex-wrap items-center gap-2"><span className="break-words">{index + 1}. {image.originalName}</span><Button size="sm" onClick={() => onRemoveBody(image.id)}>移除正文图 {index + 1}</Button></li>)}</ol></>}
  </div>;
}
