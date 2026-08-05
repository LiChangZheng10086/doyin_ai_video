/**
 * 浏览器开发模式下 window.electron 的 polyfill。
 * 在 Electron 环境中由 preload 脚本注入真正的实现；
 * 在纯浏览器开发时，此 polyfill 通过 REST API 桥接后端功能。
 */

declare global {
  interface Window {
    electron: {
      getServerPort: () => Promise<number>;
      getConfig: () => Promise<any>;
      setConfig: (config: any) => Promise<void>;
      addApiKey: (key: any) => Promise<any>;
      updateApiKey: (id: string, key: any) => Promise<any>;
      removeApiKey: (id: string) => Promise<void>;
      setActiveApiKey: (id: string) => Promise<void>;
      testApiKey: (key: any) => Promise<any>;
      retestApiKey: (id: string) => Promise<any>;
      getAppPaths: () => Promise<any>;
    };
  }
}

if (!(window as any).electron) {
  const API_BASE = '';

  async function apiFetch<T = any>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }

  (window as any).electron = {
    getServerPort: async () => 5173,

    getConfig: async () => {
      try {
        return await apiFetch('/api/config');
      } catch {
        return { aiKeys: [] };
      }
    },

    setConfig: async (config: any) => {
      return await apiFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
    },

    addApiKey: async (key: any) => {
      return await apiFetch('/api/config/ai-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(key),
      });
    },

    updateApiKey: async (id: string, key: any) => {
      return await apiFetch(`/api/config/ai-keys/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(key),
      });
    },

    removeApiKey: async (id: string) => {
      await apiFetch(`/api/config/ai-keys/${id}`, { method: 'DELETE' });
    },

    setActiveApiKey: async (id: string) => {
      await apiFetch(`/api/config/ai-keys/${id}/activate`, { method: 'POST' });
    },

    testApiKey: async (key: any) => {
      return await apiFetch('/api/config/ai-keys/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(key),
      });
    },

    retestApiKey: async (id: string) => {
      return await apiFetch(`/api/config/ai-keys/${id}/test`, { method: 'POST' });
    },

    getAppPaths: async () => {
      try {
        return await apiFetch('/api/config/paths');
      } catch {
        return { storagePath: '', configPath: '' };
      }
    },
  };
}
