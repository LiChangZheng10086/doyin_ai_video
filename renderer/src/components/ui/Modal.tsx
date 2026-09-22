import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './Button';

/*
 * 共享对话框壳。
 *
 * 为什么需要它：改造前有 **9 个各自手写的弹窗**，对话框工程完整度参差不齐 ——
 *   组件                        role  Esc  inert  focus  scrollLock
 *   PublishPreviewDialog         有    无    无     无      无     ← 服务端强制的唯一发布闸门
 *   CreateJobDialog              无    无    无     无      无     ← 全产品入口
 *   PublishingActionDialog       有    有    无     有      有
 *   CollectionDetailPage ×2      无    无    无     无      无
 * 于是「预览弹窗键盘完全不能用」「入口弹窗不是对话框」这类问题能同时存在。
 *
 * 这里把 CreateNotePackageDialog 里那套**已经被验证过**的做法抽出来当唯一真源
 * （它是改造前做得最完整的一个）：
 *   - portal 到 document.body ⇒ 弹窗是 #root 的**兄弟节点**，所以给 #root 设 inert
 *     才能真正屏蔽背景，而不会把弹窗自己也屏蔽掉（这是个容易写错的地方）；
 *   - 打开时存档焦点 → 关闭时 rAF 归位（rAF 是必要的：关闭瞬间原节点可能已卸载）；
 *   - Esc 关闭（busy 时忽略）、Tab 困在弹窗内、锁 body 滚动并还原 prev。
 *
 * 两个刻意的决定：
 *   1. **busy 时 Esc 仍然可用**的例外是「危险确认」——见 ConfirmDialog 的 danger 档。
 *      普通长任务（洗稿、提交）不该剥夺 Esc：用户会以为界面卡死。
 *   2. onClose / busy 走 ref，effect 依赖只留 `[open]`。改造前 ConfirmDialog 把
 *      内联箭头函数放进依赖数组 ⇒ 父组件任何重渲染都会 cleanup→setup 重跑一次：
 *      参考焦点被覆盖、焦点被拽回、busy 时按钮不可聚焦导致 Tab 逃出模态。
 */

const SIZE_CLASS = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
} as const;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** 弹出层的无障碍名。传字符串时自动渲染成标题。 */
  title?: React.ReactNode;
  /** 标题下方的次要信息行（版本号 / 创建人 / 时间等） */
  subtitle?: React.ReactNode;
  /** 头部右侧的附加物（状态徽章等） */
  headerAside?: React.ReactNode;
  /** 标题不是字符串时（或用别的名字）的替代无障碍名 */
  ariaLabel?: string;
  size?: keyof typeof SIZE_CLASS;
  /** 进行中的不可中断操作：屏蔽 Esc 与点遮罩 */
  busy?: boolean;
  /** 危险操作：不允许点遮罩关闭（Esc 仍可用 —— 剥夺 Esc 会让键盘用户以为卡死） */
  dismissOnBackdrop?: boolean;
  footer?: React.ReactNode;
  /** 内容区自带滚动；省略 header/footer 时整块可滚 */
  children: React.ReactNode;
  /**
   * 语气标记，落到弹窗节点上的 `data-tone`。
   * `ConfirmDialog` 用它暴露 danger/warning/info（这是组件对外的契约，
   * 调用方与用例都依赖它），也便于按语气加样式而不必改组件。
   */
  tone?: string;
  /** 不渲染头部右上角的关闭按钮（默认渲染） */
  hideClose?: boolean;
  /** 给内容区加的内边距类（默认 px-5 py-4） */
  bodyClassName?: string;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  headerAside,
  ariaLabel,
  size = 'md',
  busy = false,
  dismissOnBackdrop = true,
  footer,
  tone,
  children,
  bodyClassName = 'px-5 py-4',
  hideClose = false,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  /*
   * cleanup 里要靠它区分两种情况：「用户真的关了弹窗」还是
   * 「React StrictMode 在开发模式下把 effect 跑了两遍（setup → cleanup → setup）」。
   * 改造前 cleanup 无条件 rAF 归位焦点，于是 StrictMode 下它会和 setup 里的
   * 「焦点移入」抢跑、最后把焦点留在**背景元素**上 ——
   * 真机实测就是这样（弹窗开着，但 activeElement 是侧栏的一个 <a>）。
   */
  const openRef = useRef(open);
  openRef.current = open;

  const titleId = React.useId();

  useEffect(() => {
    if (!open) return;

    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const appRoot = document.getElementById('root');
    appRoot?.setAttribute('aria-hidden', 'true');
    appRoot?.setAttribute('inert', '');

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    /*
     * 焦点移入：优先第一个可聚焦控件，没有就把焦点放到容器本身。
     *
     * ⚠️ **不能只靠 requestAnimationFrame**。真机实测：当窗口处于后台/被遮挡时
     * `document.visibilityState === 'hidden'`，Chromium 会**完全节流 rAF**
     * （探针结果：rAF 800ms 内一次都没跑，而 setTimeout 正常）。于是「打开弹窗把焦点
     * 移进去」会**静默失效** —— 弹窗开着，焦点却仍在背景的侧栏导航上，
     * 键盘用户 Tab 半天进不去。
     *
     * 所以：先**同步**聚焦（useEffect 里 DOM 已提交，布局也就绪），
     * 再用 setTimeout(0) 兜一次底（应对「同一帧内又被重渲染」），
     * 兜底时若焦点已被用户移到别处就不再抢。
     */
    const focusFirst = (force = false) => {
      const el = dialogRef.current;
      if (!el) return;
      if (!force && el.contains(document.activeElement)) return;
      const first = el.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      (first ?? el).focus();
    };
    focusFirst(true);
    const focusTimer = setTimeout(() => focusFirst(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const el = dialogRef.current;
      if (!el) return;
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((node) => node.offsetParent !== null);
      if (focusables.length === 0) {
        event.preventDefault();
        el.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      // 焦点已经跑到弹窗外面（例如按钮被禁用导致原焦点消失）就拉回来
      if (!active || !el.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      appRoot?.removeAttribute('aria-hidden');
      appRoot?.removeAttribute('inert');
      // 只在**真的关闭**时归位焦点（区分 StrictMode 的 setup→cleanup→setup）。
      // 同样不用 rAF：窗口被遮挡时它不会跑，焦点会落在 body。
      if (!openRef.current) {
        const target = previousFocus.current;
        if (target?.isConnected) {
          setTimeout(() => target.focus(), 0);
        }
      }
    };
  }, [open]);

  if (!open) return null;

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/55"
        onClick={dismissOnBackdrop && !busy ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        data-tone={tone}
        aria-label={title === undefined ? ariaLabel : undefined}
        aria-labelledby={title !== undefined ? titleId : undefined}
        tabIndex={-1}
        className={`relative z-10 flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl outline-none ${SIZE_CLASS[size]}`}
      >
        {title !== undefined && (
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="truncate font-display text-lg font-semibold text-ink">
                {title}
              </h2>
              {subtitle && <div className="mt-1">{subtitle}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {headerAside}
              {/* 可见的关闭入口。缺了它，用户只能靠 Esc 或点遮罩 —— 而遮罩在
                  「危险操作不允许点遮罩」时是故意失效的，那时就没有出口了。 */}
              {!hideClose && (
                <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭" disabled={busy}>
                  <X size={18} aria-hidden="true" />
                </Button>
              )}
            </div>
          </header>
        )}
        <div className={`min-h-0 flex-1 overflow-y-auto ${bodyClassName}`}>{children}</div>
        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-line px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );

  /*
   * 浏览器里 portal 到 document.body：这样弹窗是 `#root` 的**兄弟节点**，
   * 才能给 #root 设 inert 屏蔽背景而不把弹窗自己也屏蔽掉。
   *
   * 但**静态渲染**（测试用的 `renderToStaticMarkup`）没有 DOM，portal 无从谈起 ——
   * 那种环境下内联返回，让弹窗内容照常参与序列化。这一点不做的话，所有
   * 「渲染弹窗并断言其内容」的测试会全部拿到空串。effect（焦点/滚动锁/inert）
   * 在静态渲染下本来也不会执行，所以两条路径的差异只在于 DOM 挂在哪。
   */
  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}
