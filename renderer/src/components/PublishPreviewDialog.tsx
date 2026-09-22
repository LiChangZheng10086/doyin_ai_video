import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/api.js';
import type { PlatformCopy, PublishAssetHealth, PublishingPackagePreview } from '../types/index.js';
import { Modal } from './ui/Modal.js';
import { Button } from './ui/Button.js';

/**
 * 发布前预览弹窗（spec §14）。
 *
 * 只负责**渲染**：字数与上限、超限判定、缺资产提示全部由服务端算好（`copyChecks`）——
 * 渲染层是独立 TS 工程、引用不到 `src/lib` 的 `validateNoteCopy`，规则留在服务端才不会有第二份实现。
 *
 * 两种进入方式：图文包点「发布图文到抖音」时**必经**（确认后才提交），视频包随时可看。
 */
/** 预览载荷的类型来自 `types/index.ts`，与后端 `PublishingPackagePreview` 同形。 */
export type PublishPreviewDialogPreview = PublishingPackagePreview;
export type PublishPreviewCopyCheck = PublishingPackagePreview['copyChecks'][number];

export interface PublishPreviewDialogProps {
  open: boolean;
  preview: PublishPreviewDialogPreview | null;
  onClose: () => void;
  /** 省略时不渲染确认按钮（视频包只是「看一眼」）。 */
  onConfirm?: () => void;
  confirmLabel?: string;
  busy?: boolean;
  /**
   * 成片流的绝对 URL（由页面用 `apiClient.getJobVideoStreamUrl` 解析好后传入）。
   * 弹窗保持纯展示，不自己拼 URL —— 相对路径在 Electron 里会打到错误的端口。
   */
  videoUrl?: string;
}

const HEALTH_TEXT: Record<PublishAssetHealth, string> = {
  healthy: '资产正常',
  missing_cover: '缺少封面',
  broken_video: '视频异常',
  missing_images: '缺少图片',
};

const HEALTH_CLASS: Record<PublishAssetHealth, string> = {
  healthy: 'bg-success-soft text-success',
  missing_cover: 'bg-warning-soft text-warning',
  broken_video: 'bg-danger-soft text-danger',
  missing_images: 'bg-danger-soft text-danger',
};

function isBlocking(health: PublishAssetHealth): boolean {
  return health === 'broken_video' || health === 'missing_images';
}

/** 一个字数与上限：`标题 12/20`，超限标红。 */
function CountedField({ name, value }: { name: string; value: PublishingPackagePreview['copyChecks'][number]['title'] }) {
  return (
    <span
      data-over={value.over ? 'true' : 'false'}
      className={value.over ? 'text-xs font-medium text-danger' : 'text-xs text-ink-muted'}
    >
      {name} {value.actual}/{value.limit}
    </span>
  );
}

/**
 * 提交中的进度提示。
 *
 * 提交是**同步**请求：先 `sau douyin check`（会起一次无头浏览器，实测约 100 秒），再跑上传。
 * 没有提示的话界面就是一个不动的转圈、按钮还是灰的，用户会以为卡死了
 * （2026-09-17 用户实测反馈：「一直停留在这个页面，按钮也无法点击」）。
 */
function SubmitProgress() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((current) => current + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="text-xs text-ink-muted" role="status">
      正在提交…已用 {seconds} 秒。校验登录态与上传通常需要 1–3 分钟，
      请<strong className="font-medium text-ink">不要关闭窗口</strong>，也别重复点击。
    </p>
  );
}

/** 取这份检查对应的文案正文：包级检查看 `noteCopy`，任务级检查看对应任务的文案。 */
function copyForCheck(
  preview: PublishPreviewDialogPreview,
  check: PublishPreviewCopyCheck,
): PlatformCopy | undefined {
  if (check.scope === 'package') {
    // 文章包的包级文案在 `articleCopy` 里：此前只取 noteCopy，于是卡片旁边字数是对的（12/30、300/20000）
    // 而标题/正文显示为空，看起来像内容丢了。
    if (preview.articleCopy) {
      return { title: preview.articleCopy.title, description: preview.articleCopy.body, hashtags: [] };
    }
    return preview.noteCopy;
  }
  return preview.tasks.find((task) => task.id === check.taskId)?.copy;
}

/**
 * 文案正文。
 *
 * 只显示「标题 25/55」这类计数是不够的 —— spec §14.1 立项的理由就是「此前项目里没有任何地方能
 * **看见**将要发出去的内容」，所以标题/正文/话题的文字必须原样摊出来，超限的整段标红。
 */
function CopyBody({ check, copy }: { check: PublishPreviewCopyCheck; copy: PlatformCopy | undefined }) {
  const row = 'flex gap-2';
  const label = 'w-10 shrink-0 text-ink-muted';
  const overText = (over: boolean) => (over ? 'font-medium text-danger' : 'text-ink');
  return (
    <dl className="mt-3 space-y-2 border-t border-line pt-3 text-sm">
      <div className={row}>
        <dt className={label}>标题</dt>
        <dd className={overText(check.title.over)}>{copy?.title || '（空）'}</dd>
      </div>
      <div className={row}>
        <dt className={label}>正文</dt>
        <dd className={`whitespace-pre-wrap leading-6 ${overText(check.description.over)}`}>
          {copy?.description || '（空）'}
        </dd>
      </div>
      <div className={row}>
        <dt className={label}>话题</dt>
        <dd className="text-ai">
          {copy?.hashtags.length ? copy.hashtags.map((tag) => `#${tag}`).join(' ') : '（无）'}
        </dd>
      </div>
    </dl>
  );
}

/**
 * 单张预览图。
 *
 * **必须用带会话的请求取 blob**，不能直接把 `/images/:index` 塞给 `<img src>`：
 * 该接口是 `authenticated` 的，而浏览器给 `<img>` 发请求时不带 `X-Local-Session` → 401 → 破图。
 * 与页面里既有的封面缩略图同一套做法。
 */
function PreviewImage({ packageId, index, total }: { packageId: string; index: number; total: number }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    void apiClient.getPublishingPackageImage(packageId, index).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [packageId, index]);

  return (
    /*
     * ⚠️ 尺寸必须与**后端实际裁剪出来的比例**一致。
     * 配图在后端被统一裁成 3:4（1080×1440，见 src/lib/note-media.ts），
     * 而这里原本是 `h-64 w-36` = 144×256 = **9:16**，再配 `object-cover`
     * ⇒ 横向被裁掉约 25%。用户是**看着这张图批准 previewRevision** 的，
     * 而 previewRevision 是「我确认过这个包」的服务端凭据 —— 预览显示的
     * 必须是真会发出去的那张画面。w-48 = 192×256 = 3:4。
     */
    <span className="flex h-64 w-48 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-well">
      {url
        ? <img src={url} alt={`第 ${index + 1} 张，共 ${total} 张`} className="h-full w-full object-cover" />
        : <span className="px-2 text-center text-xs text-ink-muted">第 {index + 1} / {total} 张</span>}
    </span>
  );
}

export function PublishPreviewDialog({
  open,
  preview,
  onClose,
  onConfirm,
  confirmLabel = '确认发布',
  busy = false,
  videoUrl,
}: PublishPreviewDialogProps) {
  // 关着的时候返回 `null`（而不是 `''`）：空串在 React 里是一个**文本子节点**，与打开后的
  // `div` 是两种节点类型，同一个子槽位换类型属于「替换」，没必要为此走一次替换。
  //
  // 注意：改了这里**并不会**消掉 dev 下那条
  // 「Internal React error: Expected static flag was missing.」——
  // 那是 React 19 **development 构建才有**的内部校验（生产构建没有这段代码），
  // 对任何「同一个子槽位在两次渲染里换成另一种节点」的写法都会报。
  // 实测：图文包预览（`PreviewImage` 的 span → img）与文章包预览（封面 p → img）**都会报**，
  // 与本次头条改动无关、也不影响功能（弹窗内容全部正确渲染，2026-09-18 真浏览器核对）。
  /*
   * ⚠️ 这个 hook 必须在早退**之前**调用。
   *
   * 改造前它的位置在 `if (!open || !preview) return null;` 之后，而父组件是**常驻挂载**
   * 这个弹窗（`open` 从 false 变 true），初始态是 `open=false / preview=null`
   * ⇒ 首次渲染 0 个 hook、打开后 2 个 hook。
   *
   * 2026-09-21 实测：这在当前 React 19 下**不会崩** —— React 选择 dispatcher 时会看
   * 上一次渲染有没有 hook（`current.memoizedState === null` 就走 mount 分支），
   * 于是「0 → N」被当作重新挂载、静默通过（探针：无 pageerror，弹窗正常渲染）。
   * 但代价是 hook 状态被**静默重新初始化**，而且只要有人在早退之上再加一个 hook，
   * 计数就变成 1 → 3，那时 dispatcher 走 update 分支，会直接抛
   * 「Rendered more hooks than during the previous render」。
   *
   * 顺带说明为什么现有测试抓不到：它们全部用 `renderToStaticMarkup`，不跑更新阶段的
   * dispatcher，因此对「hook 顺序随渲染变化」完全不敏感。
   */
  const [bodyView, setBodyView] = React.useState<'plain' | 'typeset'>('plain');
  const articleCover = useArticleCover(
    preview?.package.id ?? '',
    open && Boolean(preview) && preview?.package.contentType === 'article' && Boolean(preview?.articleCopy),
  );

  if (!open || !preview) return null;

  const { package: pkg } = preview;
  const blocking = isBlocking(pkg.assetHealth);
  const hasViolations = preview.copyChecks.some((check) => check.violations.length > 0);
  const images = preview.imagePaths ?? [];
  const imageCount = images.length;
  const isArticle = pkg.contentType === 'article';

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      busy={busy}
      title={`发布前预览 · ${pkg.title}`}
      subtitle={
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          <span>v{pkg.version}</span>
          <span>{pkg.contentType === 'note' ? '图文' : pkg.contentType === 'article' ? '文章' : '视频'}</span>
          <span>{pkg.createdBy.displayName}</span>
          <span className="tabular">{new Date(pkg.createdAt).toLocaleString('zh-CN')}</span>
          <span className="truncate">{pkg.packagePath}</span>
        </p>
      }
      headerAside={
        <span className={`shrink-0 rounded-full px-2 py-1 text-xs ${HEALTH_CLASS[pkg.assetHealth]}`}>
          {HEALTH_TEXT[pkg.assetHealth]}
        </span>
      }
      footer={
        <>
          {busy && <span className="mr-auto"><SubmitProgress /></span>}
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          {onConfirm && (
            <Button
              variant="primary"
              onClick={onConfirm}
              disabled={busy || blocking || hasViolations}
            >
              {confirmLabel}
            </Button>
          )}
        </>
      }
    >
      <>
          {blocking && (
            <p className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-sm font-medium text-danger">
              资产{HEALTH_TEXT[pkg.assetHealth]}，请先修复后再发布。
            </p>
          )}

          {isArticle ? (
            <section className="space-y-3">
              {articleCover.url ? (
                <img
                  src={articleCover.url}
                  alt="文章封面"
                  className="w-full max-w-md rounded-lg border border-line"
                  data-testid="article-cover"
                />
              ) : (
                <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
                  这个文章包没有可显示的封面。今日头条要求文章必须有封面，请重新创建文章包并选择封面。
                </p>
              )}
              <div className="space-y-1">
                <p className="text-sm font-medium text-ink">标题</p>
                <p className="text-sm text-ink" data-testid="article-title">
                  {preview.articleCopy?.title ?? pkg.title}
                </p>
                {preview.articleLimits ? (
                  <CountedField
                    name="标题"
                    value={{
                      actual: [...(preview.articleCopy?.title ?? '')].length,
                      limit: preview.articleLimits.titleMax,
                      over: [...(preview.articleCopy?.title ?? '')].length > preview.articleLimits.titleMax
                        || [...(preview.articleCopy?.title ?? '')].length < preview.articleLimits.titleMin,
                    }}
                  />
                ) : null}
              </div>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-ink">正文</p>
                  {/*
                    双视图。默认「纯文本 · 所见即所发」是**刻意的保真**：抖音图文与小红书笔记的
                    正文是纯文本，平台不解析 Markdown —— 若这里把 `**粗体**` 渲染成真粗体，
                    等于骗用户（提交过去的是字面星号）。但文章包的正文以 `## ` 标记往返
                    （`articleHtmlToBodyText`），只给纯文本会很难读，所以提供一个**排版预览**，
                    并明确标注「提交的仍是纯文本」。
                  */}
                  <div role="group" aria-label="正文视图" className="flex gap-1 rounded-md border border-line bg-well p-0.5">
                    {([['plain', '纯文本 · 所见即所发'], ['typeset', '排版预览']] as const).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={bodyView === id}
                        onClick={() => setBodyView(id)}
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          bodyView === id ? 'bg-elevated text-ink ring-1 ring-inset ring-line-strong' : 'text-ink-muted hover:text-ink'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {bodyView === 'plain' ? (
                  <pre
                    className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-well p-3 text-sm leading-relaxed text-ink"
                    data-testid="article-body"
                  >
                    {preview.articleCopy?.body ?? ''}
                  </pre>
                ) : (
                  <div className="max-h-64 overflow-auto rounded-lg border border-line bg-well p-3" data-testid="article-body-typeset">
                    <TypesetBody body={preview.articleCopy?.body ?? ''} />
                    <p className="mt-3 border-t border-line pt-2 text-xs text-ink-subtle">
                      仅预览排版。提交给头条的仍然是纯文本，编辑器会把 <code className="font-mono">## </code>
                      开头的行当成小标题。
                    </p>
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-ink">发布选项</p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-ink-muted">
                  <li>头条首发：{preview.toutiaoOptions?.firstPublish ? '是' : '否'}</li>
                  <li>
                    作品声明：
                    {preview.toutiaoOptions?.declarations?.length
                      ? preview.toutiaoOptions.declarations.join('、')
                      : '（无）'}
                  </li>
                  {/* 平台默认会勾上这一项：把真实取值摊出来，避免「多发了一条微头条」才知道 */}
                  <li>同时发布微头条：{preview.toutiaoOptions?.crossPostWeitoutiao ? '是' : '否'}</li>
                </ul>
              </div>
            </section>
          ) : pkg.contentType === 'note' ? (
            <section>
              {imageCount === 0 ? (
                <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">包内没有图片</p>
              ) : (
                <>
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {images.map((imagePath, index) => (
                      <PreviewImage
                        key={imagePath}
                        packageId={pkg.id}
                        index={index}
                        total={imageCount}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-ink-muted">{`1/${imageCount}`} 起，按发布顺序排列</p>
                </>
              )}
            </section>
          ) : (
            <section>
              <video controls src={videoUrl} className="max-h-[60vh] w-full rounded-lg bg-black" />
              <p className="mt-2 text-xs text-ink-muted">
                {preview.video?.hasCover ? '包含封面' : '没有封面'}
              </p>
            </section>
          )}

          <section className="mt-4 space-y-3">
            {preview.copyChecks.map((check) => (
              <article
                key={`${check.scope}-${check.taskId ?? 'package'}-${check.platform}`}
                className="rounded-lg border border-line p-3"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-sm font-medium text-ink">
                    {check.label}
                    {check.scope === 'package' ? '（包级文案）' : ''}
                  </h3>
                  <CountedField name="标题" value={check.title} />
                  <CountedField name="正文" value={check.description} />
                  <CountedField name="话题" value={check.hashtags} />
                </div>
                <CopyBody check={check} copy={copyForCheck(preview, check)} />
                {check.violations.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {check.violations.map((violation) => (
                      <li key={`${violation.field}-${violation.limit}`} className="text-xs font-medium text-danger">
                        {violation.message}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </section>
      </>
    </Modal>
  );
}

/**
 * 文章封面：走 `apiClient` 取 blob（`<img src>` 不会带 `X-Local-Session` 头 → 401 破图）。
 * 与 `PreviewImage` 同一套做法，只是封面的接口是包级 `/cover`。
 */
function useArticleCover(packageId: string, enabled: boolean): { url: string } {
  const [url, setUrl] = React.useState('');

  React.useEffect(() => {
    if (!enabled) {
      setUrl('');
      return undefined;
    }
    let revoked = '';
    let cancelled = false;
    void apiClient.getPublishingCover(packageId).then((blob) => {
      if (cancelled) return;
      revoked = URL.createObjectURL(blob);
      setUrl(revoked);
    }).catch(() => {
      if (!cancelled) setUrl('');
    });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [packageId, enabled]);

  return { url };
}

/**
 * 文章正文的「排版预览」。
 *
 * ⚠️ 它**只**用于预览，渲染出来的小标题与粗体**不会**出现在提交内容里 ——
 * 提交给头条的是包内 `articleCopy.body` 那段纯文本（`## ` 开头的行由编辑器识别成小标题）。
 * 所以调用方必须在同一屏里写明这件事，别让用户以为能带格式。
 *
 * 限定 `max-w-[72ch]`：改造前弹窗宽 896px + 14px 字号 ≈ 每行 120 字符，回行容易串行。
 */
function TypesetBody({ body }: { body: string }) {
  const lines = body.split('\n');
  return (
    <div className="max-w-[72ch] space-y-2.5 text-sm leading-7 text-ink">
      {lines.map((raw, index) => {
        const line = raw.trim();
        if (!line) return null;
        const heading = line.match(/^#{2,4}\s+(.*)$/);
        if (heading) {
          return (
            <h3 key={index} className="mt-3 font-display text-base font-semibold text-ink first:mt-0">
              {inlineFormat(heading[1]!)}
            </h3>
          );
        }
        const bullet = line.match(/^[-*]\s+(.*)$/);
        if (bullet) {
          return (
            <p key={index} className="flex gap-2 pl-1">
              <span aria-hidden="true" className="text-ink-subtle">·</span>
              <span className="min-w-0">{inlineFormat(bullet[1]!)}</span>
            </p>
          );
        }
        const ordered = line.match(/^(\d+)[.、]\s*(.*)$/);
        if (ordered) {
          return (
            <p key={index} className="flex gap-2 pl-1">
              <span className="tabular shrink-0 text-ink-subtle">{ordered[1]}.</span>
              <span className="min-w-0">{inlineFormat(ordered[2]!)}</span>
            </p>
          );
        }
        return <p key={index}>{inlineFormat(line)}</p>;
      })}
    </div>
  );
}

/** 只处理行内加粗（`**…**`）。渲染结果仅用于预览。 */
function inlineFormat(text: string): React.ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <strong key={index} className="font-semibold text-ink">{part.slice(2, -2)}</strong>
    ) : (
      <React.Fragment key={index}>{part}</React.Fragment>
    ),
  );
}
