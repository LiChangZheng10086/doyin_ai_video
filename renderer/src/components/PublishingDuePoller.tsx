import { useEffect } from 'react';
import { desktop } from '../electron-bridge';
import { apiClient } from '../services/api';
import { formatDueNotification } from '../utils/publishing';

export function PublishingDuePoller() {
  useEffect(() => {
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const { notifications } = await apiClient.checkPublishingDue();
        if (!desktop.capabilities.showNotification) return;
        for (const notification of notifications) {
          await desktop.showNotification(
            `${notification.platformLabel} 待发布`,
            `${notification.title}，${formatDueNotification(notification)}`,
          );
        }
      } catch (error) {
        console.warn('发布排期检查失败', error);
      } finally {
        checking = false;
      }
    };

    const startupTimer = window.setTimeout(() => void check(), 0);
    const interval = window.setInterval(() => void check(), 30_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return null;
}
