import { contextBridge, ipcRenderer } from 'electron';

// 定义暴露给渲染进程的 API
export interface ElectronAPI {
  // 存储管理
  selectDirectory: () => Promise<string | null>;
  getStoragePath: () => Promise<string>;

  // 配置管理
  getConfig: () => Promise<AppConfig>;
  saveConfig: (config: Partial<AppConfig>) => Promise<void>;

  // 应用信息
  getVersion: () => Promise<string>;
  getServerPort: () => Promise<number>;

  // 文件操作
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (path: string) => Promise<void>;

  // 系统通知
  showNotification: (title: string, body: string) => Promise<void>;
}

export interface AppConfig {
  storagePath: string;
  ai: {
    provider: 'deepseek' | 'openai';
    apiKey: string;
    model: string;
  };
  app: {
    firstRun: boolean;
    theme: 'light' | 'dark' | 'system';
  };
}

// 暴露安全的 API 到 window.electron
contextBridge.exposeInMainWorld('electron', {
  // 存储管理
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getStoragePath: () => ipcRenderer.invoke('get-storage-path'),

  // 配置管理
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: Partial<AppConfig>) =>
    ipcRenderer.invoke('save-config', config),

  // 应用信息
  getVersion: () => ipcRenderer.invoke('get-version'),
  getServerPort: () => ipcRenderer.invoke('get-server-port'),

  // 文件操作
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  showItemInFolder: (path: string) =>
    ipcRenderer.invoke('show-item-in-folder', path),

  // 系统通知
  showNotification: (title: string, body: string) =>
    ipcRenderer.invoke('show-notification', title, body),
} as ElectronAPI);

// TypeScript 类型声明
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
