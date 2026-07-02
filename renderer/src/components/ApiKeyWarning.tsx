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
    <div className="fixed inset-0 bg-black bg-opacity-50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-tech-surface rounded-xl shadow-2xl w-full max-w-md mx-4 border border-tech-border p-6">
        <div className="text-center mb-4">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
            <AlertTriangle size={30} />
          </div>
          <h3 className="text-xl font-semibold text-tech-text mb-2">
            需要配置 API Key
          </h3>
        </div>

        <p className="text-tech-muted text-center mb-6">
          您还没有添加 AI API 密钥。请先前往设置页面添加密钥后再创建任务。
        </p>

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-tech-border text-tech-text hover:bg-tech-bg transition-all"
          >
            取消
          </button>
          <button
            onClick={handleGoToSettings}
            className="px-4 py-2 rounded-lg bg-tech-blue text-white hover:bg-tech-blue-dark transition-all shadow-sm"
          >
            前往设置
          </button>
        </div>
      </div>
    </div>
  );
}
