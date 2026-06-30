import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { hasValidApiKey } from '../utils/apiKeyValidator';

export function ApiKeyStatusIndicator() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const location = useLocation();

  // 路由变化时重新检查
  useEffect(() => {
    checkApiKey();
  }, [location.pathname]);

  const checkApiKey = async () => {
    const valid = await hasValidApiKey();
    setHasKey(valid);
  };

  // 检查中
  if (hasKey === null) {
    return (
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
        <span className="text-sm text-tech-muted">检查中...</span>
      </div>
    );
  }

  // 已配置
  if (hasKey) {
    return (
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 bg-green-500 rounded-full" />
        <span className="text-sm text-tech-muted">API 已配置</span>
      </div>
    );
  }

  // 未配置
  return (
    <div className="flex items-center gap-3">
      <span className="w-2 h-2 bg-orange-500 rounded-full" />
      <span className="text-sm text-orange-600">未配置 AI</span>
      <Link
        to="/settings"
        className="text-sm text-tech-blue hover:underline"
      >
        前往设置
      </Link>
    </div>
  );
}
