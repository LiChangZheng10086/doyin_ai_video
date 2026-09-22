import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { apiClient } from '../services/api';

type CookieStatus = 'loading' | 'logged-in' | 'no-auth' | 'no-cookie';

type CookieStatusInfo = {
  status: CookieStatus;
  path: string;
};

export function CookieStatusIndicator({ compact }: { compact?: boolean }) {
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
        <span className="w-2 h-2 bg-ink-subtle rounded-full animate-pulse" />
        <span className="text-sm text-ink-muted">检查登录态…</span>
      </div>
    );
  }

  // 已登录（有有效 Cookie）
  if (info.status === 'logged-in') {
    return (
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 bg-success rounded-full" />
        <span className={`text-sm text-ink-muted ${compact ? 'text-xs' : ''}`}>{compact ? '抖音已登录' : '抖音已登录'}</span>
      </div>
    );
  }

  // 未登录（有 Cookie 但无登录态）
  return (
    <div className="flex items-center gap-3">
      <span className="w-2 h-2 bg-warning rounded-full" />
      <span className={`${compact ? 'text-xs' : 'text-sm'} text-warning`}>
        {info.status === 'no-cookie' ? '未配置抖音 Cookie' : 'Cookie 已过期'}
      </span>
      <Link
        to="/settings"
        className="text-sm text-accent hover:underline"
      >
        前往设置
      </Link>
    </div>
  );
}
