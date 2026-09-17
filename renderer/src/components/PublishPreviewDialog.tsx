import React, { useEffect, useState } from 'react';
import { apiClient } from '../services/api.js';
import type { PlatformCopy, PublishAssetHealth, PublishingPackagePreview } from '../types/index.js';

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
  healthy: 'bg-emerald-50 text-emerald-700',
  missing_cover: 'bg-amber-50 text-amber-700',
  broken_video: 'bg-red-50 text-red-700',
  missing_images: 'bg-red-50 text-red-700',
};

function isBlocking(health: PublishAssetHealth): boolean {
  return health === 'broken_video' || health === 'missing_images';
}

/** 一个字数与上限：`标题 12/20`，超限标红。 */
function CountedField({ name, value }: { name: string; value: PublishingPackagePreview['copyChecks'][number]['title'] }) {
  return (
    <span
      data-over={value.over ? 'true' : 'false'}
      className={value.over ? 'text-xs font-medium text-red-600' : 'text-xs text-tech-muted'}
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
    <p className="text-xs text-tech-muted" role="status">
      正在提交到抖音…已用 {seconds} 秒。校验登录态与上传通常需要 1–3 分钟，
      请<strong className="font-medium text-tech-text">不要关闭窗口</strong>，也别重复点击。
    </p>
  );
}

/** 取这份检查对应的文案正文：包级检查看 `noteCopy`，任务级检查看对应任务的文案。 */
function copyForCheck(
  preview: PublishPreviewDialogPreview,
  check: PublishPreviewCopyCheck,
): PlatformCopy | undefined {
  if (check.scope === 'package') return preview.noteCopy;
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
  const label = 'w-10 shrink-0 text-tech-muted';
  const overText = (over: boolean) => (over ? 'font-medium text-red-600' : 'text-tech-text');
  return (
    <dl className="mt-3 space-y-2 border-t border-tech-border pt-3 text-sm">
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
        <dd className="text-tech-purple">
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
    <span className="flex h-64 w-36 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-tech-border bg-tech-bg">
      {url
        ? <img src={url} alt={`第 ${index + 1} 张，共 ${total} 张`} className="h-full w-full object-cover" />
        : <span className="px-2 text-center text-xs text-tech-muted">第 {index + 1} / {total} 张</span>}
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
  if (!open || !preview) return '';

  const { package: pkg } = preview;
  const blocking = isBlocking(pkg.assetHealth);
  const hasViolations = preview.copyChecks.some((check) => check.violations.length > 0);
  const images = preview.imagePaths ?? [];
  const imageCount = images.length;

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <header className="flex items-start justify-between gap-4 border-b border-tech-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-medium text-tech-text">发布前预览 · {pkg.title}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tech-muted">
              <span>v{pkg.version}</span>
              <span>{pkg.contentType === 'note' ? '图文' : '视频'}</span>
              <span>{pkg.createdBy.displayName}</span>
              <span>{new Date(pkg.createdAt).toLocaleString('zh-CN')}</span>
              <span className="truncate">{pkg.packagePath}</span>
            </p>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-1 text-xs ${HEALTH_CLASS[pkg.assetHealth]}`}>
            {HEALTH_TEXT[pkg.assetHealth]}
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {blocking && (
            <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              资产{HEALTH_TEXT[pkg.assetHealth]}，请先修复后再发布。
            </p>
          )}

          {pkg.contentType === 'note' ? (
            <section>
              {imageCount === 0 ? (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">包内没有图片</p>
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
                  <p className="text-xs text-tech-muted">{`1/${imageCount}`} 起，按发布顺序排列</p>
                </>
              )}
            </section>
          ) : (
            <section>
              <video controls src={videoUrl} className="max-h-[60vh] w-full rounded-lg bg-black" />
              <p className="mt-2 text-xs text-tech-muted">
                {preview.video?.hasCover ? '包含封面' : '没有封面'}
              </p>
            </section>
          )}

          <section className="mt-4 space-y-3">
            {preview.copyChecks.map((check) => (
              <article
                key={`${check.scope}-${check.taskId ?? 'package'}-${check.platform}`}
                className="rounded-lg border border-tech-border p-3"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-sm font-medium text-tech-text">
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
                      <li key={`${violation.field}-${violation.limit}`} className="text-xs font-medium text-red-600">
                        {violation.message}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </section>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-tech-border px-5 py-3">
          {busy ? <SubmitProgress /> : <span />}
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-tech-muted hover:bg-tech-bg">
            关闭
          </button>
          {onConfirm && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy || blocking || hasViolations}
              className="rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {confirmLabel}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
