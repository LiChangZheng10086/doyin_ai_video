// 根 tsconfig 没有开 `jsx: react-jsx`（tsx 走经典转换），所以这里必须显式 import React：
// 缺了它静态渲染会 ReferenceError（本项目已经踩过一次，见 worklog 2026-09-17）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Images, Loader2, Upload, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiClient, parseApiError } from '../services/api';
import type {
  AssetRecord,
  NoteImageSource,
  PlatformCopy,
  PublishPlatform,
  PublishingPackageDetail,
  PublishingPreview,
} from '../types';
import {
  buildNotePackageInput,
  getNoteImageBlocker,
  NOTE_AUTOMATION_PLATFORMS,
  getNotePlatformBlocker,
  noteCopyFieldErrors,
  notePublishDialogTitle,
  selectionOrder,
  toggleLibraryImage,
  toggleNotePlatform,
} from '../utils/notePackage';

/**
 * 图文包（抖音 / 小红书图文）创建弹窗。
 *
 * 与视频向导 `CreatePublishPackageDialog` **相互独立**：图文与视频的资产口径、
 * 必填项、文案规则都不同，塞进同一个向导只会让两套规则纠缠（视频链路因此一行未改）。
 *
 * 图片来源二选一：自动静帧（该作品生成视频时的场景静帧）或素材库选图（按选择顺序）。
 * 无论哪种，打包时图片都会被**复制进包目录**，所以事后删素材不影响已建好的包。
 */
interface Props {
  jobId: string;
  title: string;
  onClose: () => void;
}

const EMPTY_COPY: PlatformCopy = { title: '', description: '', hashtags: [] };

export function CreateNotePackageDialog({ jobId, title, onClose }: Props) {
  const navigate = useNavigate();
  const [source, setSource] = useState<NoteImageSource>('frames');
  const [libraryImages, setLibraryImages] = useState<AssetRecord[]>([]);
  const [libraryUrls, setLibraryUrls] = useState<Record<string, string>>({});
  const [libraryError, setLibraryError] = useState('');
  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [copy, setCopy] = useState<PlatformCopy>(EMPTY_COPY);
  // 平台与小红书发布选项。默认「只发抖音」+「已声明 AI」，与后端默认姿态一致（spec §10/§11）。
  const [platforms, setPlatforms] = useState<PublishPlatform[]>(['douyin']);
  /**
   * 平台集合的稳定键：排序后拼接。
   * 预览 effect 依赖它而不是数组引用 —— 数组每次渲染都是新引用，
   * 直接依赖会在无关重渲染里反复打预览接口。
   */
  const platformKey = [...platforms].sort().join(',');
  const [xhsAiDeclaration, setXhsAiDeclaration] = useState(true);
  const [xhsSubmit, setXhsSubmit] = useState(false);
  const [preview, setPreview] = useState<PublishingPreview | undefined>();
  const [previewing, setPreviewing] = useState(true);
  const [previewError, setPreviewError] = useState('');
  const [titleCompressed, setTitleCompressed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<PublishingPackageDetail | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  // 用户一旦动过文案，重新预览（换图/换来源）就不得再覆盖它
  const copyTouched = useRef(false);
  // 预览是异步的：只认最后一次请求的结果，避免快速点选时旧响应覆盖新选择
  const previewToken = useRef(0);
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
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      appRoot?.removeAttribute('aria-hidden');
      appRoot?.removeAttribute('inert');
      document.removeEventListener('keydown', onKeyDown);
      // ⚠️ 不用 rAF：窗口被遮挡时 Chromium 会完全节流 rAF（实测 800ms 内一次都不跑），
      // 焦点就回不到触发按钮上。setTimeout 不受此影响。
      setTimeout(() => {
        const target = previousFocus.current;
        if (target?.isConnected) target.focus();
      }, 0);
    };
  }, []);

  // 素材库清单与缩略图：图片走绝对 URL 的 <img src>（相对路径在 Electron 里会打到 Vite 代理）
  useEffect(() => {
    let active = true;
    void apiClient.getAssets('image')
      .then(async (images) => {
        if (!active) return;
        setLibraryImages(images);
        const urls: Record<string, string> = {};
        for (const record of images) urls[record.id] = await apiClient.getAssetRawUrl(record.id);
        if (active) setLibraryUrls(urls);
      })
      .catch((requestError) => {
        if (active) setLibraryError(parseApiError(requestError).message);
      });
    return () => { active = false; };
  }, []);

  /*
   * 每次「来源 / 选择 / **所选平台**」变化都重新预览：它同时产出创建时必须回传的
   * previewRevision。
   *
   * ⚠️ 平台必须参与，而且**要传真实所选平台**（改造前这里硬编码成 `['douyin']`）。
   * 服务端的 `sourceRevision()` 会把平台列表排序后拼进哈希：
   *   `hash.update([...platforms].sort().join(","))`
   * 于是勾上「小红书」后，创建时服务端按 `['douyin','xiaohongshu']` 重算，
   * 与预览时的 `['douyin']` 必然不等 → **409「源内容自预览后发生变化，请重新预览后创建」**，
   * 而按提示重新预览仍然用 `['douyin']` ⇒ 重试永远失败、小红书流程在界面上不可达。
   * 同一行还导致小红书 18 张的图片上限被当成抖音的 35 张（服务端按所选平台下发 imageLimit），
   * 用户会建出 20 张的包、走到「提交到小红书」才吃 422。
   *
   * 依赖用 `platformKey`（排序后拼接的字符串）而不是数组本身：数组每次都是新引用，
   * 用它会在一堆无关重渲染里反复打预览接口。
   */
  useEffect(() => {
    // 素材库一张没选时预览会被服务端拒绝（400），此时交给 blocker 提示，不发这个请求
    if (source === 'library' && selectedImageIds.length === 0) {
      previewToken.current += 1;
      setPreview(undefined);
      setPreviewing(false);
      setPreviewError('');
      return;
    }
    const token = previewToken.current + 1;
    previewToken.current = token;
    setPreviewing(true);
    setPreviewError('');
    void apiClient.previewPublishing(jobId, platforms, 'note', {
      imageSource: source,
      ...(source === 'library' ? { imageAssetIds: selectedImageIds } : {}),
    }).then((result) => {
      if (previewToken.current !== token) return;
      setPreview(result);
      if (!copyTouched.current && result.noteCopy) {
        setCopy({
          title: result.noteCopy.title,
          description: result.noteCopy.description,
          hashtags: [...result.noteCopy.hashtags],
        });
      }
      setTitleCompressed(Boolean(result.noteCopyTitleCompressed));
    }).catch((requestError) => {
      if (previewToken.current !== token) return;
      setPreview(undefined);
      setPreviewError(parseApiError(requestError).message);
    }).finally(() => {
      if (previewToken.current === token) setPreviewing(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用 platformKey 代替 platforms 引用
  }, [jobId, source, selectedImageIds, platformKey]);

  const limits = preview?.copyLimits;
  const imageLimit = preview?.imageLimit ?? 35;

  const blocker = useMemo(() => getNoteImageBlocker({
    source,
    framesCount: source === 'frames' ? (preview?.images?.length ?? 0) : 0,
    libraryCount: libraryImages.length,
    selectedCount: selectedImageIds.length,
    limit: imageLimit,
  }), [source, preview, libraryImages.length, selectedImageIds.length, imageLimit]);

  const toggleImage = useCallback((assetId: string) => {
    setSelectedImageIds((current) => toggleLibraryImage(current, assetId, imageLimit));
  }, [imageLimit]);

  const changeCopy = useCallback((field: keyof PlatformCopy, value: string | string[]) => {
    copyTouched.current = true;
    setCopy((current) => ({ ...current, [field]: value }));
  }, []);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      setCreated(await apiClient.createPublishingPackage(buildNotePackageInput({
        sourceJobId: jobId,
        title,
        preview,
        copy,
        source,
        selectedImageIds,
        platforms,
        xhsOptions: { aiDeclaration: xhsAiDeclaration, submit: xhsSubmit },
      })));
    } catch (requestError) {
      setError(parseApiError(requestError).message);
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="note-publish-title" className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-2xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 id="note-publish-title" className="text-lg font-semibold text-ink">{notePublishDialogTitle(platforms)}</h2>
            <p className="mt-1 text-sm text-ink-muted">图片会复制进交付包，之后删除源素材不影响已建好的包。</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭" className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted hover:bg-elevated hover:text-ink disabled:opacity-50">
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {created ? (
            <div className="py-8 text-center">
              <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success"><Check size={24} /></span>
              <h3 className="mt-4 text-xl font-semibold text-ink">图文包已创建</h3>
              <p className="mt-2 text-sm text-ink-muted">
                v{created.package.version} · 共 {created.package.imagePaths?.length ?? 0} 张图片
              </p>
              <p className="mt-2 text-sm text-ink-muted">到发布中心点「发布图文到抖音」，提交前会强制预览确认。</p>
              <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
                <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-elevated">关闭</button>
                <button type="button" onClick={() => navigate('/publishing')} className="rounded-lg bg-ai px-4 py-2 text-sm font-medium text-on-accent hover:opacity-90">前往发布中心</button>
              </div>
            </div>
          ) : (
            <NotePackageForm
              source={source}
              onSourceChange={setSource}
              preview={preview}
              libraryImages={libraryImages}
              libraryUrls={libraryUrls}
              libraryError={libraryError}
              previewing={previewing}
              copy={copy}
              onCopyChange={changeCopy}
              titleCompressed={titleCompressed}
              selectedImageIds={selectedImageIds}
              onToggleImage={toggleImage}
              platforms={platforms}
              onTogglePlatform={(platform) => setPlatforms((current) => toggleNotePlatform(current, platform))}
              xhsAiDeclaration={xhsAiDeclaration}
              onXhsAiDeclarationChange={setXhsAiDeclaration}
              xhsSubmit={xhsSubmit}
              onXhsSubmitChange={setXhsSubmit}
              busy={busy}
              error={error || previewError}
              onCreate={() => void create()}
              onClose={onClose}
            />
          )}
        </div>
      </section>
    </div>
  );
  return typeof document === 'undefined' ? null : createPortal(dialog, document.body);
}

export interface NotePackageFormProps {
  source: NoteImageSource;
  onSourceChange: (source: NoteImageSource) => void;
  /** 最近一次预览：图片清单、文案默认值、张数/字数上限与 `previewRevision` 都来自它。 */
  preview?: PublishingPreview;
  libraryImages: AssetRecord[];
  libraryUrls: Record<string, string>;
  libraryError: string;
  previewing: boolean;
  copy: PlatformCopy;
  onCopyChange: (field: keyof PlatformCopy, value: string | string[]) => void;
  /** 服务端把视频口径的标题压到了图文口径（20 字）：界面必须标注「已压缩，可编辑」。 */
  titleCompressed: boolean;
  /** 素材库选择，顺序即入包顺序。 */
  selectedImageIds: string[];
  onToggleImage: (assetId: string) => void;
  /** 要建包的平台（至少一个）；抖音走外部 sau、小红书走自研执行器。 */
  platforms: PublishPlatform[];
  onTogglePlatform: (platform: PublishPlatform) => void;
  /** 小红书合规开关：声明「笔记含AI合成内容」。默认开。 */
  xhsAiDeclaration: boolean;
  onXhsAiDeclarationChange: (value: boolean) => void;
  /** 小红书最后一步：`true` = 由程序点发布；默认 `false`（只填到草稿，真人在同一浏览器中点）。 */
  xhsSubmit: boolean;
  onXhsSubmitChange: (value: boolean) => void;
  busy: boolean;
  error: string;
  onCreate: () => void;
  onClose: () => void;
}

/** 纯展示表单：数据与副作用都在容器里，这里只渲染（因此可以被静态渲染断言守住）。 */
export function NotePackageForm(props: NotePackageFormProps) {
  const {
    source,
    preview,
    libraryImages,
    libraryUrls,
    libraryError,
    previewing,
    copy,
    titleCompressed,
    selectedImageIds,
  } = props;
  const limits = preview?.copyLimits;
  const imageLimit = preview?.imageLimit ?? 35;
  const blocker = getNoteImageBlocker({
    source,
    framesCount: source === 'frames' ? (preview?.images?.length ?? 0) : 0,
    libraryCount: libraryImages.length,
    selectedCount: selectedImageIds.length,
    limit: imageLimit,
  });
  const fieldErrors = limits ? noteCopyFieldErrors(copy, limits) : [];
  const platformBlocker = getNotePlatformBlocker(props.platforms, props.xhsAiDeclaration);
  const canCreate = !blocker && !platformBlocker && fieldErrors.length === 0
    && Boolean(preview) && !previewing && !props.busy;

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-base font-semibold text-ink">图片来源</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <SourceOption
            value="frames"
            current={source}
            label="自动静帧"
            hint="用这个作品生成视频时的场景静帧，按场景序"
            onSelect={props.onSourceChange}
          />
          <SourceOption
            value="library"
            current={source}
            label="素材库选图"
            hint="从素材页上传的图片里多选，按选择顺序进包"
            onSelect={props.onSourceChange}
          />
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-ink">图片</h3>
          <span className="text-xs text-ink-muted">
            {source === 'library' ? `已选 ${selectedImageIds.length}/${imageLimit}` : `共 ${preview?.images?.length ?? 0} 张 · 上限 ${imageLimit} 张`}
          </span>
        </div>

        {previewing && <p className="mt-3 text-sm text-ink-muted">正在准备图片清单…</p>}

        {source === 'frames' ? (
          <ul className="mt-3 space-y-1.5">
            {(preview?.images ?? []).map((image) => (
              <li key={image.name} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm text-ink">
                <span className="truncate">{image.name}</span>
                <span className="ml-3 shrink-0 text-xs text-ink-muted">{formatBytes(image.size)}</span>
              </li>
            ))}
          </ul>
        ) : libraryImages.length === 0 ? (
          // 纯展示组件不挂路由：这里给的是「去哪儿上传」的明确指引，导航交给侧栏
          <p className="mt-3 flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-4 text-sm text-ink-muted">
            <Images size={16} /> 素材库里还没有图片，请先到左侧「素材」页上传（jpg/png/webp，单张 ≤20MB）。
          </p>
        ) : (
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {libraryImages.map((image) => {
              const order = selectionOrder(selectedImageIds, image.id);
              const url = libraryUrls[image.id];
              return (
                <li key={image.id}>
                  <button
                    type="button"
                    onClick={() => props.onToggleImage(image.id)}
                    aria-pressed={order > 0}
                    aria-label={order > 0 ? `第 ${order} 张：${image.originalName}` : `选择 ${image.originalName}`}
                    className={`w-full overflow-hidden rounded-lg border text-left transition-colors ${order > 0 ? 'border-accent-line bg-info-soft' : 'border-line hover:bg-elevated'}`}
                  >
                    <span className="relative block aspect-video w-full bg-elevated">
                      {url
                        ? <img src={url} alt={image.originalName} loading="lazy" className="h-full w-full object-cover" />
                        : <span className="flex h-full w-full items-center justify-center text-xs text-ink-muted">图片</span>}
                      {order > 0 && (
                        <span className="absolute left-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent text-xs font-semibold text-on-accent">{order}</span>
                      )}
                    </span>
                    <span className="block truncate px-2 py-1.5 text-xs text-ink">{image.originalName}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {libraryError && <p className="mt-3 text-sm text-danger" role="alert">素材库加载失败：{libraryError}</p>}
        {blocker && <p className="mt-3 rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-sm text-warning">{blocker}</p>}
      </section>

      <section className="space-y-3">
        <h3 className="text-base font-semibold text-ink">发布平台</h3>
        <div className="flex flex-wrap gap-2">
          {NOTE_AUTOMATION_PLATFORMS.map((platform) => {
            const checked = props.platforms.includes(platform);
            const label = platform === 'douyin' ? '抖音' : '小红书';
            return (
              <button
                key={platform}
                type="button"
                aria-pressed={checked}
                onClick={() => props.onTogglePlatform(platform)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${checked ? 'border-accent-line bg-accent-soft text-accent' : 'border-line text-ink-muted hover:bg-elevated hover:text-ink'}`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="text-xs leading-5 text-ink-muted">
          抖音由外部引擎提交；小红书由自研执行器填写（默认保存到浏览器本地图文草稿，点「打开小红书草稿浏览器」核对并发布）。
          ⚠️ 自动化发布违反平台规则，风险由你的账号承担。
        </p>

        {props.platforms.includes('xiaohongshu') && (
          <div className="space-y-2 rounded-lg border border-line bg-canvas p-3">
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={props.xhsAiDeclaration}
                onChange={(event) => props.onXhsAiDeclarationChange(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                声明「笔记含AI合成内容」
                <span className="mt-0.5 block text-xs text-ink-muted">
                  小红书要求 AI 生成内容主动标识，未标识会被限制分发。取消勾选将无法创建小红书图文包。
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={props.xhsSubmit}
                onChange={(event) => props.onXhsSubmitChange(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                创建后由程序点发布
                <span className="mt-0.5 block text-xs text-ink-muted">
                  推荐保持关闭：只把标题、正文、图片与 AI 声明填好并存为草稿，最后一下由你在同一草稿浏览器里点；不会同步到手机。
                  打开后提交时会真的点「发布」，请自行评估账号风险。
                </span>
              </span>
            </label>
          </div>
        )}

        {platformBlocker && (
          <p className="rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-sm text-warning">{platformBlocker}</p>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-base font-semibold text-ink">图文文案</h3>
        {titleCompressed && (
          <p className="rounded-lg border border-info-line bg-info-soft px-3 py-2 text-sm text-info">
            原标题超过图文口径，已压缩到 {limits?.titleMax ?? 20} 字，可编辑。
          </p>
        )}
        <label className="block text-sm font-medium text-ink">
          标题
          {limits && (
            <span className={`float-right text-xs font-normal ${[...copy.title].length > limits.titleMax ? 'text-danger' : 'text-ink-muted'}`}>
              {[...copy.title].length}/{limits.titleMax}
            </span>
          )}
          <input
            value={copy.title}
            onChange={(event) => props.onCopyChange('title', event.target.value)}
            className="mt-2 w-full rounded-lg border border-line-ui px-3 py-2 text-sm outline-none focus:border-accent-line focus:ring-2 focus:ring-accent"
          />
        </label>
        <label className="block text-sm font-medium text-ink">
          正文
          {limits && (
            <span className={`float-right text-xs font-normal ${[...copy.description].length > limits.descriptionMax ? 'text-danger' : 'text-ink-muted'}`}>
              {[...copy.description].length}/{limits.descriptionMax}
            </span>
          )}
          <textarea
            value={copy.description}
            onChange={(event) => props.onCopyChange('description', event.target.value)}
            rows={6}
            className="mt-2 w-full resize-y rounded-lg border border-line-ui px-3 py-2 text-sm outline-none focus:border-accent-line focus:ring-2 focus:ring-accent"
          />
        </label>
        <label className="block text-sm font-medium text-ink">
          话题（空格分隔）
          {limits && (
            <span className={`float-right text-xs font-normal ${copy.hashtags.length > limits.hashtagMax ? 'text-danger' : 'text-ink-muted'}`}>
              {copy.hashtags.length}/{limits.hashtagMax}
            </span>
          )}
          <input
            value={copy.hashtags.join(' ')}
            onChange={(event) => props.onCopyChange('hashtags', event.target.value.split(/\s+/u).filter(Boolean))}
            className="mt-2 w-full rounded-lg border border-line-ui px-3 py-2 text-sm outline-none focus:border-accent-line focus:ring-2 focus:ring-accent"
          />
        </label>
        {fieldErrors.map((message) => <p key={message} className="text-sm text-danger">{message}</p>)}
      </section>

      {props.error && <p className="rounded-lg border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">{props.error}</p>}

      {/*
        操作行吸在滚动区底部：这个表单比弹窗高，若把「创建图文包」放在内容末尾，
        用户要先滚到底才能找到它 —— 本项目已经因为「入口藏起来」返工过两次。
      */}
      <div className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-4 flex items-center justify-between gap-3 border-t border-line bg-panel px-5 py-4">
        <button type="button" onClick={props.onClose} disabled={props.busy} className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink hover:bg-elevated disabled:opacity-50">
          取消
        </button>
        <button
          type="button"
          onClick={props.onCreate}
          disabled={!canCreate}
          className="inline-flex items-center gap-2 rounded-lg bg-ai px-4 py-2 text-sm font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
        >
          {props.busy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
          创建图文包
        </button>
      </div>
    </div>
  );
}

function SourceOption({
  value,
  current,
  label,
  hint,
  onSelect,
}: {
  value: NoteImageSource;
  current: NoteImageSource;
  label: string;
  hint: string;
  onSelect: (source: NoteImageSource) => void;
}) {
  const active = value === current;
  return (
    <label className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 ${active ? 'border-accent-line bg-info-soft' : 'border-line hover:bg-elevated'}`}>
      <span className="flex items-center gap-2">
        <input
          type="radio"
          name="note-image-source"
          value={value}
          checked={active}
          onChange={() => onSelect(value)}
          className="h-4 w-4 accent-tech-blue"
        />
        <span className="font-medium text-ink">{label}</span>
      </span>
      <span className="pl-6 text-xs text-ink-muted">{hint}</span>
    </label>
  );
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
}
