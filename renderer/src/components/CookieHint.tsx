import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { apiClient } from '../services/api';

type CookieSummary = 'logged-in' | 'no-auth' | 'no-cookie' | 'loading';

interface CookieHintProps {
  /** Show warning when cookie is missing entirely vs just expired */
  compact?: boolean;
}

export function useCookieStatus() {
  const [status, setStatus] = useState<CookieSummary>('loading');

  useEffect(() => {
    let cancelled = false;
    apiClient.getCookieStatus().then((s) => {
      if (cancelled) return;
      if (s.hasAuth) setStatus('logged-in');
      else if (s.hasCookie) setStatus('no-auth');
      else setStatus('no-cookie');
    }).catch(() => {
      if (!cancelled) setStatus('no-cookie');
    });
    return () => { cancelled = true; };
  }, []);

  return status;
}

/**
 * Inline hint shown near the transcription/download step.
 * Explains why a cookie matters and links to settings.
 */
export function CookieHint({ compact }: CookieHintProps) {
  const status = useCookieStatus();

  if (status === 'loading') return null;
  if (status === 'logged-in') {
    if (compact) return null; // don't clutter when everything is fine in compact mode
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
        <CheckCircle2 size={16} className="shrink-0" />
        <span>已登录抖音，可下载无水印视频</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
      <div className="flex items-center gap-2">
        {status === 'no-auth' ? (
          <AlertCircle size={16} className="shrink-0" />
        ) : (
          <Info size={16} className="shrink-0" />
        )}
        <span>
          {status === 'no-auth'
            ? 'Cookie 已过期或未登录，下载的视频可能带水印'
            : '未设置抖音 Cookie，下载的视频可能带水印'}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <Link
          to="/settings"
          className="inline-flex items-center gap-1 text-tech-blue hover:underline"
        >
          前往设置
        </Link>
        <span className="text-amber-400">·</span>
        <span>扫码登录或手动粘贴 Cookie 后可下载无水印视频</span>
      </div>
    </div>
  );
}
