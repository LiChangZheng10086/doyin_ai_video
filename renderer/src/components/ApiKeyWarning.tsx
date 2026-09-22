import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

interface ApiKeyWarningProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * 「还没配 API Key」的拦截弹窗。
 *
 * 改造前它是一个裸 div + `role="dialog"`：**没有 Esc、没有焦点移入与陷阱、没有 inert、
 * 没有滚动锁**，遮罩点击也不关（只有一个 onClick 挂在内层 div 上）。
 * 现在统一交给共享 `Modal`（portal + role/aria-modal/aria-labelledby + Esc + 焦点陷阱
 * + #root inert + 55% 遮罩），这里只留内容与动作。
 */
export function ApiKeyWarning({ isOpen, onClose }: ApiKeyWarningProps) {
  const navigate = useNavigate();

  const handleGoToSettings = () => {
    onClose();
    navigate('/settings');
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      size="sm"
      hideClose
      title={
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning">
            <AlertTriangle size={16} aria-hidden="true" />
          </span>
          需要配置 API Key
        </span>
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleGoToSettings}>前往设置</Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-ink-muted">
        您还没有添加 AI API 密钥。请先前往设置页面添加密钥后再创建任务。
      </p>
    </Modal>
  );
}
