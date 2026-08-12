import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export interface PublishingActionDialogProps {
  open: boolean;
  type: 'confirm' | 'prompt' | 'edit-content' | 'withdraw';
  title: string;
  description?: string;
  confirmLabel?: string;
  tone?: 'danger' | 'warning' | 'info';
  // prompt mode
  inputLabel?: string;
  inputPlaceholder?: string;
  defaultValue?: string;
  // edit-content mode
  defaultValues?: { title: string; description: string; hashtags: string };
  // lifecycle
  busy?: boolean;
  onConfirm: (value?: string | { title: string; description: string; hashtags: string[] } | { reason: string }) => void;
  onClose: () => void;
}

export function PublishingActionDialog({
  open,
  type,
  title,
  description,
  confirmLabel,
  tone,
  inputLabel,
  inputPlaceholder,
  defaultValue,
  defaultValues,
  busy,
  onConfirm,
  onClose,
}: PublishingActionDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  // prompt / withdraw / edit-content form state
  const [value, setValue] = useState(defaultValue ?? '');
  const [editTitle, setEditTitle] = useState(defaultValues?.title ?? '');
  const [editDescription, setEditDescription] = useState(defaultValues?.description ?? '');
  const [editHashtags, setEditHashtags] = useState(defaultValues?.hashtags ?? '');
  // withdraw second step
  const [withdrawReason, setWithdrawReason] = useState('');
  const [withdrawStep, setWithdrawStep] = useState<'reason' | 'confirm'>('reason');

  // Reset form when dialog opens
  useEffect(() => {
    if (!open) return;
    setValue(defaultValue ?? '');
    setEditTitle(defaultValues?.title ?? '');
    setEditDescription(defaultValues?.description ?? '');
    setEditHashtags(defaultValues?.hashtags ?? '');
    setWithdrawReason('');
    setWithdrawStep('reason');
  }, [open, defaultValue, defaultValues]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';

    requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled])');
      first?.focus();
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) {
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
        ));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      previousFocus.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const confirmBtnClass = tone === 'danger'
    ? 'bg-red-600 hover:bg-red-700 text-white'
    : tone === 'warning'
      ? 'bg-amber-600 hover:bg-amber-700 text-white'
      : 'bg-tech-blue hover:bg-tech-blue-dark text-white';

  const defaultConfirmLabel = type === 'withdraw' && withdrawStep === 'reason'
    ? '下一步'
    : confirmLabel ?? (type === 'confirm' ? '确认' : '保存');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    if (type === 'withdraw') {
      if (withdrawStep === 'reason') {
        if (!withdrawReason.trim()) return;
        setWithdrawStep('confirm');
        return;
      }
      onConfirm({ reason: withdrawReason.trim() });
      return;
    }

    if (type === 'prompt') {
      onConfirm(value);
    } else if (type === 'edit-content') {
      onConfirm({
        title: editTitle,
        description: editDescription,
        hashtags: editHashtags.split(/\s+/u).filter(Boolean),
      });
    } else {
      onConfirm();
    }
  };

  const renderBody = () => {
    if (type === 'withdraw' && withdrawStep === 'confirm') {
      return (
        <p className="text-sm text-tech-muted">
          只撤回本地状态，不会删除平台视频。确认继续？
        </p>
      );
    }

    if (type === 'prompt') {
      const isDatetime = inputLabel?.includes('排期') || inputPlaceholder?.includes('YYYY-MM-DD');
      const isMultiline = inputLabel?.includes('原因') || inputPlaceholder?.includes('原因');
      return (
        <label className="block">
          {inputLabel && <span className="mb-1.5 block text-sm font-medium text-tech-text">{inputLabel}</span>}
          {isMultiline ? (
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={inputPlaceholder}
              rows={3}
              className="w-full rounded-lg border border-tech-border bg-tech-bg px-3 py-2 text-sm text-tech-text outline-none focus:border-tech-blue focus:ring-1 focus:ring-tech-blue resize-y"
              autoFocus
            />
          ) : (
            <input
              type={isDatetime ? 'datetime-local' : 'text'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={inputPlaceholder}
              className="w-full rounded-lg border border-tech-border bg-tech-bg px-3 py-2 text-sm text-tech-text outline-none focus:border-tech-blue focus:ring-1 focus:ring-tech-blue"
              autoFocus
            />
          )}
        </label>
      );
    }

    if (type === 'edit-content') {
      return (
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-tech-text">标题</span>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full rounded-lg border border-tech-border bg-tech-bg px-3 py-2 text-sm text-tech-text outline-none focus:border-tech-blue focus:ring-1 focus:ring-tech-blue"
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-tech-text">正文</span>
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-tech-border bg-tech-bg px-3 py-2 text-sm text-tech-text outline-none focus:border-tech-blue focus:ring-1 focus:ring-tech-blue resize-y"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-tech-text">标签（空格分隔）</span>
            <input
              type="text"
              value={editHashtags}
              onChange={(e) => setEditHashtags(e.target.value)}
              className="w-full rounded-lg border border-tech-border bg-tech-bg px-3 py-2 text-sm text-tech-text outline-none focus:border-tech-blue focus:ring-1 focus:ring-tech-blue"
            />
          </label>
        </div>
      );
    }

    if (type === 'withdraw') {
      return (
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-tech-text">填写撤回本地已发布状态的原因</span>
          <textarea
            value={withdrawReason}
            onChange={(e) => setWithdrawReason(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-tech-border bg-tech-bg px-3 py-2 text-sm text-tech-text outline-none focus:border-tech-blue focus:ring-1 focus:ring-tech-blue resize-y"
            autoFocus
          />
        </label>
      );
    }

    // confirm mode
    return description ? <p className="text-sm text-tech-muted">{description}</p> : null;
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={() => { if (!busy) onClose(); }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-md rounded-xl bg-white p-6 shadow-lg"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-tech-text">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1.5 text-tech-muted hover:bg-tech-bg hover:text-tech-text disabled:opacity-50"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {renderBody()}

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                if (type === 'withdraw' && withdrawStep === 'confirm') {
                  setWithdrawStep('reason');
                  return;
                }
                onClose();
              }}
              disabled={busy}
              className="rounded-lg border border-tech-border px-4 py-2 text-sm font-medium text-tech-text hover:bg-tech-bg disabled:opacity-50"
            >
              {type === 'withdraw' && withdrawStep === 'confirm' ? '上一步' : '取消'}
            </button>
            <button
              type="submit"
              disabled={busy || (type === 'withdraw' && withdrawStep === 'reason' && !withdrawReason.trim())}
              className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${confirmBtnClass}`}
            >
              {busy ? '处理中...' : defaultConfirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
