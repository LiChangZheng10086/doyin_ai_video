import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

export interface SupplementCleanDialogProps {
  open: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: (text: string) => void;
  onClose: () => void;
}

/**
 * 「补充内容，重新洗稿」。
 *
 * 改造前自己实现焦点与 Esc，有两个真实缺陷：
 *  ① effect 依赖里带了 `busy`，而 busy 翻转时（点「开始重新洗稿」的瞬间）会
 *     cleanup → setup 重跑一次：先把焦点还给背景按钮，再 rAF 抢回 textarea ——
 *     键盘用户正按 Tab 找按钮就被打断。现在依赖只剩 `open`（就是 `Modal` 的做法）。
 *  ② busy 时把**三种退出方式全锁死**（取消按钮 disabled、Esc 分支带 `&& !busy`、
 *     背板点击置 undefined），而重新洗稿是 AI 调用、后端还会自动重试最多 3 次，
 *     可能几分钟 —— 用户只能盯着一个「重新洗稿中...」的按钮，看不到任何进度，
 *     而真正的流式输出被这个弹窗盖在下面。
 *     现在：**可以关掉弹窗让任务在后台继续**（关掉后反而能在成果区看到流式输出），
 *     并在运行中明确写出这件事。
 */
export function SupplementCleanDialog({ open, busy, error, onConfirm, onClose }: SupplementCleanDialogProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) setText('');
  }, [open]);

  // 打开时把焦点放到输入框（Modal 会把焦点移入弹窗内第一个可聚焦元素，
  // 这里再把焦点精确落到 textarea 上）
  useEffect(() => {
    if (!open) return;
    // 同步聚焦 + setTimeout 兜底：窗口被遮挡时 rAF 会被完全节流（见 Modal 里的说明）
    textareaRef.current?.focus();
    const timer = setTimeout(() => {
      if (!textareaRef.current || document.activeElement === textareaRef.current) return;
      const dlg = textareaRef.current.closest('[role="dialog"]');
      if (dlg && !dlg.contains(document.activeElement)) textareaRef.current.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [open]);

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const submit = () => {
    if (!canSubmit) return;
    onConfirm(trimmed);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="补充内容，重新洗稿"
      hideClose={false}
      footer={
        busy ? (
          <>
            <span className="mr-auto inline-flex items-center gap-2 text-xs text-ink-muted" role="status">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              正在重新洗稿，可以关掉这个窗口 —— 任务会在后台继续，成果区会显示流式输出。
            </span>
            <Button variant="outline" onClick={onClose}>关闭（任务继续）</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button variant="primary" onClick={submit} disabled={!canSubmit}>开始重新洗稿</Button>
          </>
        )
      }
    >
      <p className="text-sm leading-6 text-ink-muted">
        直接洗稿可能遗漏信息。把你希望补全的数据、细节或背景写在这里，AI 会把它与视频转录合并，重新生成洗稿成果。
      </p>
      <label className="mt-4 block">
        <span className="mb-1.5 block text-sm font-medium text-ink">要补充的内容</span>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          disabled={busy}
          placeholder="例如：视频里还提到了「XX 方法的三步流程」和「转化率提升了 30%」……"
          className="w-full resize-y rounded-lg border border-line-ui bg-well px-4 py-3 text-sm text-ink outline-none placeholder:text-ink-subtle focus:border-accent-line disabled:opacity-60"
        />
      </label>
      <p className="mt-1 text-right text-xs tabular text-ink-muted">{text.length} 字</p>
      {!busy && trimmed.length === 0 && (
        <p className="mt-2 text-xs text-ink-subtle">写点什么才能重新洗稿 —— 空内容会被当成「没有补充」。</p>
      )}
      {error && (
        <p className="mt-3 rounded-lg border border-danger-line bg-danger-soft p-3 text-sm text-danger" role="alert">{error}</p>
      )}
    </Modal>
  );
}
