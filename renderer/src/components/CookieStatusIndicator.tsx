import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { apiClient } from '../services/api';

type CookieStatus = 'loading' | 'logged-in' | 'no-auth' | 'no-cookie';

type CookieStatusInfo = {
  status: CookieStatus;
  path: string;
};

export function CookieStatusIndicator() {
  const [info, setInfo] = useState<CookieStatusInfo | null>(null);
  const location = useLocation();

  useEffect(() => {
    checkCookieStatus();
  }, [location.pathname]);

  const checkCookieStatus = async () => {
    try {
      const s = await apiClient.getCookieStatus();
      let status: CookieStatus;
      if (s.hasAuth) {
        status = 'logged-in';
      } else if (s.hasCookie) {
        status = 'no-auth';
      } else {
        status = 'no-cookie';
      }
      setInfo({ status, path: s.path });
    } catch {
      setInfo(null);
    }
  };

  // 检查中
  if (!info || info.status === 'loading') {
    return (
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
        <span className="text-sm text-tech-muted">Cookie...</span>
      </div>
    );
  }

  // 已登录（有有效 Cookie）
  if (info.status === 'logged-in') {
    return (
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 bg-green-500 rounded-full" />
        <span className="text-sm text-tech-muted">抖音已登录</span>
      </div>
    );
  }

  // 未登录（有 Cookie 但无登录态）
  return (
    <div className="flex items-center gap-3">
      <span className="w-2 h-2 bg-orange-500 rounded-full" />
      <span className="text-sm text-orange-600">
        {info.status === 'no-cookie' ? '未配置抖音 Cookie' : 'Cookie 已过期'}
      </span>
      <Link
        to="/settings"
        className="text-sm text-tech-blue hover:underline"
      >
        前往设置
      </Link>
    </div>
  );
}
