import React, { useEffect, useRef, useState } from 'react';

export interface SupplementCleanDialogProps {
  open: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: (text: string) => void;
  onClose: () => void;
}

export function SupplementCleanDialog({ open, busy, error, onConfirm, onClose }: SupplementCleanDialogProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      setText('');
      return;
    }
    previousActiveElement.current = document.activeElement as HTMLElement;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => textareaRef.current?.focus());

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prev;
      previousActiveElement.current?.focus();
    };
  }, [open, busy, onClose]);

  if (!open) return null;

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const submit = () => {
    if (!canSubmit) return;
    onConfirm(trimmed);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={busy ? undefined : onClose} />
      <div role="dialog" aria-modal="true" className="relative z-10 w-full max-w-lg rounded-xl bg-white p-6 shadow-lg">
        <h3 className="text-lg font-semibold text-tech-text">补充内容，重新洗稿</h3>
        <p className="mt-2 text-sm text-tech-muted">
          直接洗稿可能遗漏信息。把你希望补全的数据、细节或背景写在这里，AI 会把它与视频转录合并，重新生成洗稿成果。
        </p>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="例如：视频里还提到了「XX 方法的三步流程」和「转化率提升了 30%」……"
          className="mt-4 w-full resize-y rounded-lg border border-tech-border bg-gray-50 px-4 py-3 text-sm text-tech-text outline-none focus:border-tech-blue focus:bg-white"
        />
        <p className="mt-1 text-right text-xs text-tech-muted">{text.length} 字</p>
        {error && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>
        )}
        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-tech-border px-4 py-2 text-sm font-medium text-tech-text hover:bg-tech-bg disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white transition-all hover:bg-tech-blue-dark disabled:opacity-50"
          >
            {busy ? '重新洗稿中...' : '开始重新洗稿'}
          </button>
        </div>
      </div>
    </div>
  );
}
