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
      openExternal?: (url: string) => Promise<void>;
      showItemInFolder?: (path: string) => Promise<void>;
      showNotification?: (title: string, body: string) => Promise<void>;
    };
  }
}

const browserWindow = typeof window === 'undefined' ? undefined : window;
const injectedElectron = browserWindow?.electron;

export type DesktopCapabilities = {
  openExternal: boolean;
  showItemInFolder: boolean;
  showNotification: boolean;
};

export type DesktopActionResult = { available: true } | { available: false };

export const desktop = {
  capabilities: {
    openExternal: typeof injectedElectron?.openExternal === 'function',
    showItemInFolder: typeof injectedElectron?.showItemInFolder === 'function',
    showNotification: typeof injectedElectron?.showNotification === 'function',
  } satisfies DesktopCapabilities,

  async openExternal(url: string): Promise<DesktopActionResult> {
    if (!injectedElectron?.openExternal) return { available: false };
    await injectedElectron.openExternal(url);
    return { available: true };
  },

  async showItemInFolder(path: string): Promise<DesktopActionResult> {
    if (!injectedElectron?.showItemInFolder) return { available: false };
    await injectedElectron.showItemInFolder(path);
    return { available: true };
  },

  async showNotification(title: string, body: string): Promise<DesktopActionResult> {
    if (!injectedElectron?.showNotification) return { available: false };
    await injectedElectron.showNotification(title, body);
    return { available: true };
  },
};

if (browserWindow && !browserWindow.electron) {
  const API_BASE = '';

  async function apiFetch<T = any>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }

  (browserWindow as any).electron = {
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
