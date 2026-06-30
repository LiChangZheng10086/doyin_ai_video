import { useEffect, useState, useCallback } from 'react';
import { useAppStore } from '../store';
import { apiClient } from '../services/api';

/**
 * 智能轮询 Hook
 * 根据任务状态动态调整轮询频率：
 * - 有任务处理中：3 秒
 * - 所有任务完成：15 秒
 * - 没有任务：停止轮询
 *
 * @param enabled 是否启用轮询
 * @returns { isPolling } 当前是否正在轮询
 */
export function useJobPolling(enabled: boolean) {
  const jobs = useAppStore(state => state.jobs);
  const setJobs = useAppStore(state => state.setJobs);
  const [isPolling, setIsPolling] = useState(false);

  // 计算轮询间隔
  const getInterval = useCallback(() => {
    if (jobs.length === 0) return null; // 停止轮询

    const hasActive = jobs.some(j =>
      j.status === 'queued' || j.status === 'processing'
    );

    return hasActive ? 3000 : 15000; // 3秒 或 15秒
  }, [jobs]);

  useEffect(() => {
    if (!enabled) {
      setIsPolling(false);
      return;
    }

    const interval = getInterval();
    if (!interval) {
      setIsPolling(false);
      return;
    }

    setIsPolling(true);

    const fetchJobs = async () => {
      try {
        const response = await apiClient.get('/jobs');
        if (response.data?.jobs) {
          setJobs(response.data.jobs);
        }
      } catch (error) {
        console.error('Polling failed:', error);
        // 静默失败，下次轮询时重试
      }
    };

    const timer = setInterval(fetchJobs, interval);

    return () => clearInterval(timer);
  }, [enabled, getInterval, setJobs]);

  return { isPolling };
}
