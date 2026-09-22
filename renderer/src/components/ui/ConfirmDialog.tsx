import React from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'warning' | 'info';
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * 二次确认弹窗。现在只是 `Modal` 的一层语义包装。
 *
 * 改造前它自己实现焦点管理，有两个问题：
 *
 * 1. **焦点陷阱会失效**：effect 的依赖数组里放了 `onClose`，而调用处传的全是**每次渲染
 *    新建的内联箭头函数**（`onClose={() => setX(null)}`）⇒ 父组件任何重渲染都会让
 *    effect cleanup→setup 重跑一次：`previousActiveElement` 被覆盖成弹窗内部元素、
 *    焦点被拽回第一个按钮；而 busy 时两个按钮都 `disabled` 不可聚焦，focus() 静默失败，
 *    Tab 陷阱的边界判断随之失效 —— **Tab 能跑出模态**。关闭时归位的焦点还可能是
 *    已卸载的节点，于是落到 body。
 *    修法：`Modal` 把 onClose/busy 收进 ref，effect 依赖只留 `[open]`。
 *
 * 2. **danger 档把 Esc 也禁掉了**（`tone !== 'danger'`）。防误触值得保留的是
 *    「点遮罩不关闭」，而**剥夺 Esc 偏离了对话框的通行约定** —— 键盘用户的第一反应
 *    失效，会以为界面卡死。现在：Esc 始终可用（busy 除外），遮罩对 danger 不可点。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  tone,
  busy,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const confirmVariant = tone === 'danger' ? 'danger' : tone === 'warning' ? 'danger' : 'primary';

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      busy={busy}
      title={title}
      tone={tone}
      dismissOnBackdrop={tone !== 'danger'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={busy}>
            {busy ? '处理中...' : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-ink-muted">{description}</p>
    </Modal>
  );
}
