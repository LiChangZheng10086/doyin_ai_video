import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ExternalLink, QrCode, RefreshCw } from 'lucide-react';
import { parseApiError } from '../services/api';

/**
 * **通用的「应用内扫码登录」面板**（今日头条与小红书共用一份实现）。
 *
 * 为什么要抽通用件：两个平台的登录交互**逐字相同** —— 后端取登录页二维码 data URL →
 * 界面放进 `<img src>` → 轮询登录状态 → 支持「打开浏览器窗口扫码」与「零副作用自检」。
 * 各平台只有**端点、文案与会话目录说明**不同，所以那些走 props，逻辑只有这一份
 *（复制一份 258 行的面板就等于养两个必然漂移的真源）。
 *
 * 三件事必须让操作者看得见（本项目在「入口零变化导致找不到」上吃过亏）：
 * ① 二维码本身；② 当前状态（等待扫码 / 已登录 / 已过期）；③ 过期后**怎么重新开始**。
 */
const POLL_INTERVAL_MS = 3_000;

type LoginPhase = 'idle' | 'starting' | 'waiting' | 'window' | 'logged_in' | 'expired';

/** 面板要用的四个后端动作（各平台一套端点，形状一致）。 */
export interface QrLoginApi {
  start(): Promise<{ qrDataUrl: string }>;
  poll(): Promise<{ status: 'idle' | 'waiting' | 'logged_in' | 'expired'; username?: string }>;
  cancel(): Promise<unknown>;
  loginInWindow(): Promise<{ loggedIn: boolean; username?: string; message: string }>;
  verify(): Promise<{ loggedIn: boolean; username?: string; message: string }>;
}

export interface QrLoginCopy {
  /** 「今日头条」/「小红书」——只用于拼接给用户看的文案。 */
  platformName: string;
  /** 扫码用的 App 名（目前与平台名相同，单独列出来是为了将来能分开）。 */
  appName: string;
  /** 面板根节点的 `data-testid`（各平台不同，便于用例精确定位）。 */
  testId: string;
  /** 二维码 `<img>` 的 `data-testid`。 */
  qrTestId: string;
  /** 底部说明：说清登录态存在哪、以及这个平台**不做**什么。 */
  footnote: string;
}

export interface QrLoginPanelProps {
  api: QrLoginApi;
  copy: QrLoginCopy;
  onLoggedIn?: (username?: string) => void;
}

export function QrLoginPanel({ api, copy, onLoggedIn }: QrLoginPanelProps) {
  const [phase, setPhase] = useState<LoginPhase>('idle');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [username, setUsername] = useState<string | undefined>(undefined);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  /** feedback 的语气：登录态相关的正面提示用 success，其余用中性 */
  const [feedbackTone, setFeedbackTone] = useState<'info' | 'success'>('info');
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
      const status = await api.poll();
      if (stopped.current) return;
      if (status.status === 'logged_in') {
        setPhase('logged_in');
        setUsername(status.username);
        setQrDataUrl('');
        setFeedbackTone('success');
        setFeedback(status.username ? `登录成功：${status.username}` : '登录成功');
        onLoggedIn?.(status.username);
        return;
      }
      if (status.status === 'expired' || status.status === 'idle') {
        setPhase('expired');
        setQrDataUrl('');
        setError(`二维码已过期：请点「重新获取二维码」再用${copy.appName} App 扫码。`);
        return;
      }
      pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    } catch (pollError) {
      if (stopped.current) return;
      // 轮询失败不该把二维码丢掉：多半是瞬时问题，下次轮询会自愈。
      setError(parseApiError(pollError).message);
      pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    }
  }, [api, copy.appName, onLoggedIn]);

  const start = useCallback(async () => {
    /*
     * ⚠️ 必须在这里把 `stopped` 复位。
     *
     * 它只在**卸载**时的 cleanup 里被置为 true（见上面的 effect），而 React 18/19 的
     * StrictMode 在开发模式下是 setup → cleanup → setup：第一次 cleanup 就把它**永久**
     * 置位了，此后 `poll()` 每次都在第一行 return。
     * 表现是：二维码正常显示，但**永远探测不到「已扫码」也探测不到「已过期」** ——
     * 开发模式下 100% 复现，而且很容易被误诊成「平台改版 / 取不到码」
     * （这个项目在误诊上已经吃过一次亏）。生产构建不受影响，所以更难被发现。
     */
    stopped.current = false;
    setBusy(true);
    setError('');
    setFeedback('');
    setFeedbackTone('info');
    setPhase('starting');
    stopPolling();
    try {
      const started = await api.start();
      setQrDataUrl(started.qrDataUrl);
      setPhase('waiting');
      pollTimer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    } catch (startError) {
      const parsed = parseApiError(startError);
      /*
       * 409「已经是登录状态」**不是失败**。
       * 改造前它走的是下面那条路：相位回 idle + 红色 error 样式 ——
       * 把一个成功状态呈现成了错误，用户以为出问题了。
       * 而后端那句话本身写得很好（「若要换账号，请先在小红书里退出登录…」），
       * 是这里唯一可操作的信息，不能被红色淹没。
       * 保持 idle 相位（`phase === 'logged_in'` 时 feedback 不渲染），语气改为 success。
       */
      if (parsed.code === 'xhs_already_logged_in' || parsed.code === 'toutiao_already_logged_in') {
        setPhase('idle');
        setFeedbackTone('success');
        setFeedback(parsed.message);
        setError('');
        return;
      }
      setPhase('idle');
      setFeedbackTone('info');
      setError(parsed.message);
    } finally {
      setBusy(false);
    }
  }, [api, poll, stopPolling]);

  const cancel = useCallback(async () => {
    setBusy(true);
    stopPolling();
    try {
      await api.cancel();
      setQrDataUrl('');
      setPhase('idle');
      setFeedback('已取消本次扫码登录');
    } catch (cancelError) {
      setError(parseApiError(cancelError).message);
    } finally {
      setBusy(false);
    }
  }, [api, stopPolling]);

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
      const result = await api.loginInWindow();
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
  }, [api, onLoggedIn, stopPolling]);

  /** 等待中要重来一次：必须先取消当前会话（否则服务端会 409「已有会话在进行中」）。 */
  const restart = useCallback(async () => {
    setBusy(true);
    stopPolling();
    try {
      await api.cancel().catch(() => undefined);
    } finally {
      setBusy(false);
    }
    await start();
  }, [api, start, stopPolling]);

  const verify = useCallback(async () => {
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      const result = await api.verify();
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
  }, [api]);

  return (
    <div className="space-y-4" data-testid={copy.testId}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void (phase === 'waiting' ? restart() : start())}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm hover:border-accent-line disabled:opacity-60"
        >
          <QrCode size={16} />
          {phase === 'waiting' ? '取消并重新获取二维码' : '扫码登录'}
        </button>
        <button
          type="button"
          onClick={() => void startWindowLogin()}
          disabled={busy}
          title="在浏览器窗口里扫码；窗口用持久化 profile，登录一次后长期有效"
          className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm hover:border-accent-line disabled:opacity-60"
        >
          <ExternalLink size={16} />
          打开浏览器扫码登录
        </button>
        <button
          type="button"
          onClick={() => void verify()}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm hover:border-accent-line disabled:opacity-60"
        >
          <CheckCircle2 size={16} />
          校验登录
        </button>
        {phase === 'waiting' ? (
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-sm hover:border-danger-line disabled:opacity-60"
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
            alt={`${copy.platformName}登录二维码`}
            width={200}
            height={200}
            className="rounded-lg border border-line bg-panel p-2"
            data-testid={copy.qrTestId}
          />
          <p className="text-sm text-ink-muted">
            请用「{copy.appName}」App 扫码登录。二维码约 10 分钟过期，过期后点「重新获取二维码」即可 ——
            <strong>不需要重启应用</strong>。
          </p>
        </div>
      ) : null}

      {phase === 'window' ? (
        <p className="flex items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
          <RefreshCw size={16} className="animate-spin" />
          等待扫码中…（浏览器窗口已打开，请用「{copy.appName}」App 扫码；最长等待 3 分钟）
        </p>
      ) : null}

      {phase === 'logged_in' ? (
        <p className="flex items-center gap-2 text-sm text-success" role="status">
          <CheckCircle2 size={16} />
          已登录{username ? `（${username}）` : ''}
        </p>
      ) : null}

      {feedback && phase !== 'logged_in' ? (
        <p
          className={`flex items-start gap-2 text-sm ${feedbackTone === 'success' ? 'text-success' : 'text-ink-muted'}`}
          role="status"
        >
          {feedbackTone === 'success' && <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />}
          <span>{feedback}</span>
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">{error}</p>
      ) : null}

      <p className="text-xs text-ink-muted">{copy.footnote}</p>
    </div>
  );
}
