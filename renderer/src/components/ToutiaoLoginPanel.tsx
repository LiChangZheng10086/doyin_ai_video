import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, QrCode, RefreshCw } from 'lucide-react';
import { apiClient, parseApiError } from '../services/api';

/**
 * 今日头条登录面板（**应用内扫码**，不弹浏览器窗口）。
 *
 * 头条号没有可手工粘贴的凭据（登录态是浏览器 profile），所以扫码是唯一入口：
 * 后端取登录页上的二维码 data URL（实测就是 512×512 的 `data:image/png;base64,…`），
 * 这里直接放进 `<img src>`，然后轮询登录状态。
 *
 * 三件事必须让操作者看得见（本项目在「入口零变化导致找不到」上吃过亏）：
 * ① 二维码本身；② 当前状态（等待扫码 / 已登录 / 已过期）；③ 过期后**怎么重新开始**。
 */
const POLL_INTERVAL_MS = 3_000;

type LoginPhase = 'idle' | 'starting' | 'waiting' | 'window' | 'logged_in' | 'expired';

export interface ToutiaoLoginPanelProps {
  onLoggedIn?: (username?: string) => void;
}

export function ToutiaoLoginPanel({ onLoggedIn }: ToutiaoLoginPanelProps) {
  const [phase, setPhase] = useState<LoginPhase>('idle');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [username, setUsername] = useState<string | undefined>(undefined);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  useEffect(() => () => {
    stopped.current = true;
    stopPolling();
  }, [stopPolling]);

  const poll = useCallback(async () => {
    if (stopped.current) return;
    try {
      const status = await apiClient.pollToutiaoLogin();
      if (stopped.current) return;
      if (status.status === 'logged_in') {
        setPhase('logged_in');
        setUsername(status.username);
        setQrDataUrl('');
        setFeedback(status.username ? `登录成功：${status.username}` : '登录成功');
        onLoggedIn?.(status.username);
        return;
      }
      if (status.status === 'expired' || status.status === 'idle') {
        setPhase('expired');
        setQrDataUrl('');
        setError('二维码已过期：请点「重新获取二维码」再用今日头条 App 扫码。');
        return;
      }
      pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    } catch (pollError) {
      if (stopped.current) return;
      // 轮询失败不该把二维码丢掉：多半是瞬时问题，下次轮询会自愈。
      setError(parseApiError(pollError).message);
      pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    }
  }, [onLoggedIn]);

  const start = useCallback(async () => {
    setBusy(true);
    setError('');
    setFeedback('');
    setPhase('starting');
    stopPolling();
    try {
      const started = await apiClient.startToutiaoLogin();
      setQrDataUrl(started.qrDataUrl);
      setPhase('waiting');
      pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    } catch (startError) {
      setPhase('idle');
      setError(parseApiError(startError).message);
    } finally {
      setBusy(false);
    }
  }, [poll, stopPolling]);

  const cancel = useCallback(async () => {
    setBusy(true);
    stopPolling();
    try {
      await apiClient.cancelToutiaoLogin();
      setQrDataUrl('');
      setPhase('idle');
      setFeedback('已取消本次扫码登录');
    } catch (cancelError) {
      setError(parseApiError(cancelError).message);
    } finally {
      setBusy(false);
    }
  }, [stopPolling]);

  /**
   * 打开浏览器窗口扫码（与抖音那套同一交互）。
   *
   * 请求同步等 3 分钟：界面必须显示「等待扫码中…」并说明「窗口已打开」，
   * 否则用户会以为按钮没反应（本项目在抖音通路上吃过「提交中毫无反馈」的亏）。
   */
  const startWindowLogin = useCallback(async () => {
    setBusy(true);
    setError('');
    setFeedback('');
    stopPolling();
    setQrDataUrl('');
    setPhase('window');
    try {
      const result = await apiClient.loginToutiaoInWindow();
      if (result.loggedIn) {
        setPhase('logged_in');
        setUsername(result.username);
        setFeedback(result.message);
        onLoggedIn?.(result.username);
      } else {
        setPhase('idle');
        setError(result.message);
      }
    } catch (windowError) {
      setPhase('idle');
      setError(parseApiError(windowError).message);
    } finally {
      setBusy(false);
    }
  }, [onLoggedIn, stopPolling]);

  /** 等待中要重来一次：必须先取消当前会话（否则服务端会 409「已有会话在进行中」）。 */
  const restart = useCallback(async () => {
    setBusy(true);
    stopPolling();
    try {
      await apiClient.cancelToutiaoLogin().catch(() => undefined);
    } finally {
      setBusy(false);
    }
    await start();
  }, [start, stopPolling]);

  const verify = useCallback(async () => {
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const result = await apiClient.verifyToutiaoLogin();
      if (result.loggedIn) {
        setPhase('logged_in');
        setUsername(result.username);
        setFeedback(result.username ? `登录态有效：${result.username}` : '登录态有效');
      } else {
        setPhase('idle');
        setError(result.message);
      }
    } catch (verifyError) {
      setError(parseApiError(verifyError).message);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="space-y-4" data-testid="toutiao-login-panel">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void (phase === 'waiting' ? restart() : start())}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg border border-tech-border bg-white px-3 py-2 text-sm hover:border-tech-blue disabled:opacity-60"
        >
          <QrCode size={16} />
          {phase === 'waiting' ? '取消并重新获取二维码' : '扫码登录'}
        </button>
        <button
          type="button"
          onClick={() => void startWindowLogin()}
          disabled={busy}
          title="在浏览器窗口里扫码；窗口用持久化 profile，登录一次后长期有效"
          className="inline-flex items-center gap-2 rounded-lg border border-tech-border bg-white px-3 py-2 text-sm hover:border-tech-blue disabled:opacity-60"
        >
          <ExternalLink size={16} />
          打开浏览器扫码登录
        </button>
        <button
          type="button"
          onClick={() => void verify()}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg border border-tech-border bg-white px-3 py-2 text-sm hover:border-tech-blue disabled:opacity-60"
        >
          <CheckCircle2 size={16} />
          校验登录
        </button>
        {phase === 'waiting' ? (
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-tech-border bg-white px-3 py-2 text-sm hover:border-red-400 disabled:opacity-60"
          >
            <RefreshCw size={16} />
            取消
          </button>
        ) : null}
      </div>

      {phase === 'waiting' && qrDataUrl ? (
        <div className="flex flex-col items-start gap-2">
          {/* 二维码是后端从登录页 DOM 里取出的 data URL —— 直接放 <img src>，不需要额外请求。 */}
          <img
            src={qrDataUrl}
            alt="今日头条登录二维码"
            width={200}
            height={200}
            className="rounded-lg border border-tech-border bg-white p-2"
            data-testid="toutiao-qr"
          />
          <p className="text-sm text-tech-muted">
            请用「今日头条」App 扫码登录。二维码约 10 分钟过期，过期后点「重新获取二维码」即可 ——
            <strong>不需要重启应用</strong>。
          </p>
        </div>
      ) : null}

      {phase === 'window' ? (
        <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
          <RefreshCw size={16} className="animate-spin" />
          等待扫码中…（浏览器窗口已打开，请用「今日头条」App 扫码；最长等待 3 分钟）
        </p>
      ) : null}

      {phase === 'logged_in' ? (
        <p className="flex items-center gap-2 text-sm text-emerald-700" role="status">
          <CheckCircle2 size={16} />
          已登录{username ? `（${username}）` : ''}
        </p>
      ) : null}

      {feedback && phase !== 'logged_in' ? (
        <p className="text-sm text-tech-muted" role="status">{feedback}</p>
      ) : null}
      {error ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p>
      ) : null}

      <p className="text-xs text-tech-muted">
        登录用的是应用内置的无头浏览器（不会弹出窗口），登录态保存在本机 storage 里的头条会话目录中。
      </p>
    </div>
  );
}
