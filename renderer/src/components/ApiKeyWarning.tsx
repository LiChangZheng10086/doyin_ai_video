import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';

interface ApiKeyWarningProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ApiKeyWarning({ isOpen, onClose }: ApiKeyWarningProps) {
  const navigate = useNavigate();

  if (!isOpen) return null;

  const handleGoToSettings = () => {
    onClose();
    navigate('/settings');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-sm rounded-xl bg-white p-6 shadow-lg"
      >
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
            <AlertTriangle size={22} />
          </div>
          <h3 className="text-lg font-semibold text-tech-text">
            需要配置 API Key
          </h3>
        </div>

        <p className="text-sm text-tech-muted">
          您还没有添加 AI API 密钥。请先前往设置页面添加密钥后再创建任务。
        </p>

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-tech-border px-4 py-2 text-sm font-medium text-tech-text hover:bg-tech-bg"
          >
            取消
          </button>
          <button
            onClick={handleGoToSettings}
            className="rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white hover:bg-tech-blue-dark"
          >
            前往设置
          </button>
        </div>
      </div>
    </div>
  );
}
