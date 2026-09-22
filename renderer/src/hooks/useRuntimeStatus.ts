import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../services/api';
import type { RuntimeChannelId, RuntimeCheckSummary, RuntimeStatusResponse } from '../types/index.js';

/**
 * 运行环境状态的取数与深检轮询。
 *
 * 两处界面（发布中心概览条、设置页「运行环境」）**共用这一个 hook** —— 同一份数据、
 * 同一套刷新时机。判定全在服务端（INV-7），这里只负责搬运与轮询。
 *
 * 轮询形状照抄 `QrLoginPanel`：`setTimeout` 自续期 + `stopped` ref + **轮询失败不清状态、
 * 下一拍自愈** + 卸载清理。间隔取 `QrLoginPanel` 的 3 秒。
 */

const POLL_INTERVAL_MS = 3_000;

export interface UseRuntimeStatusResult {
  status: RuntimeStatusResponse | null;
  loading: boolean;
  error: string | null;
  /** 当前或最近一次深检（服务端给的摘要）。 */
  check: RuntimeCheckSummary | null;
  /** 重新拉一次免费检查。 */
  refresh: () => Promise<void>;
  /** 发起深检（后台任务；立刻返回 running）。 */
  verify: (id: RuntimeChannelId) => Promise<void>;
  /** 取消正在进行的深检。 */
  cancel: () => Promise<void>;
}

export function useRuntimeStatus(): UseRuntimeStatusResult {
  const [status, setStatus] = useState<RuntimeStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const stopped = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await apiClient.getRuntimeStatus();
      if (stopped.current) return;
      setStatus(next);
      setError(null);
    } catch (cause) {
      if (stopped.current) return;
      // 取不到就让上一次的结果留着并说明原因 —— 清空会让界面闪一下"什么都没有"
      setError(cause instanceof Error ? cause.message : '运行环境状态取不到');
    } finally {
      if (!stopped.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    stopped.current = false;
    void refresh();
    return () => {
      stopped.current = true;
      stopPolling();
    };
  }, [refresh, stopPolling]);

  /*
   * 深检轮询：只在 `running` 时转，**终态一到就整份重拉** ——
   * 因为终态会改动 `verified`，而「概览条同步变绿」（AC-6）靠的就是这一次重拉。
   * 不重拉的话，用户会看到「检测完成」但状态行还是黄的。
   */
  const runningCheckId = status?.check?.status === 'running' ? status.check.checkId : null;
  useEffect(() => {
    if (!runningCheckId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const check = await apiClient.getRuntimeCheck(runningCheckId);
        if (cancelled) return;
        if (check.status === 'running') {
          setStatus((current) => (current ? { ...current, check } : current));
          pollTimer.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
          return;
        }
        setStatus((current) => (current ? { ...current, check } : current));
        await refresh();
      } catch {
        if (cancelled) return;
        // 轮询失败不该把界面变成"没有检测"：多半是瞬时问题，下一拍自愈
        pollTimer.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
      }
    };
    pollTimer.current = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [runningCheckId, refresh, stopPolling]);

  const verify = useCallback(
    async (id: RuntimeChannelId) => {
      try {
        const check = await apiClient.startRuntimeCheck(id);
        setStatus((current) => (current ? { ...current, check } : current));
        setError(null);
      } catch (cause) {
        // 409（已有检测在跑 / 该渠道正在发布）与 422（该渠道没有深检通路）都会落到这里
        setError(cause instanceof Error ? cause.message : '发起检测失败');
      }
    },
    [],
  );

  const cancel = useCallback(async () => {
    const checkId = status?.check?.checkId;
    if (!checkId) return;
    try {
      const check = await apiClient.cancelRuntimeCheck(checkId);
      setStatus((current) => (current ? { ...current, check } : current));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '取消失败');
    }
  }, [status?.check?.checkId]);

  return { status, loading, error, check: status?.check ?? null, refresh, verify, cancel };
}
