import { contextBridge, ipcRenderer } from 'electron';
import type { AiProvider } from './utils/ai-config';

export type { AiProvider } from './utils/ai-config';

// 定义暴露给渲染进程的 API
export interface ElectronAPI {
  // 存储管理
  selectDirectory: () => Promise<string | null>;
  getStoragePath: () => Promise<string>;

  // 配置管理
  getConfig: () => Promise<AppConfig>;
  saveConfig: (config: Partial<AppConfig>) => Promise<void>;
  testApiKey: (keyConfig: AIKeyInput) => Promise<AIKeyTestResult>;
  addApiKey: (keyConfig: Omit<AIKeyConfig, 'id' | 'isActive' | 'isValid' | 'lastTested'>) => Promise<string>;
  updateApiKey: (keyId: string, changes: AIKeyChanges) => Promise<void>;
  retestApiKey: (keyId: string) => Promise<AIKeyTestResult>;
  removeApiKey: (keyId: string) => Promise<void>;
  setActiveApiKey: (keyId: string) => Promise<void>;

  // 应用信息
  getVersion: () => Promise<string>;
  getServerPort: () => Promise<number>;

  // 文件操作
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (path: string) => Promise<void>;

  // 系统通知
  showNotification: (title: string, body: string) => Promise<void>;
}

export interface AIKeyConfig {
  id: string;
  name: string; // 用户自定义名称，如 "我的 DeepSeek"
  provider: AiProvider;
  apiKey: string;
  baseURL?: string;
  model: string;
  maxOutputTokens?: number;
  isActive: boolean; // 当前使用的 Key
  isValid?: boolean; // API Key 是否有效
  lastTested?: string; // 最后测试时间
}

export type AIKeyInput = Omit<AIKeyConfig, 'id' | 'isActive' | 'isValid' | 'lastTested'>;
export type AIKeyChanges = Omit<AIKeyInput, 'apiKey' | 'maxOutputTokens'> & {
  apiKey?: string;
  maxOutputTokens?: number | null;
};
export type AiErrorCode = 'dns' | 'tls' | 'timeout' | 'auth' | 'endpoint' | 'model' | 'quota' | 'upstream' | 'unknown';

export interface AIKeyTestResult {
  valid: boolean;
  code?: AiErrorCode;
  error?: string;
  testedAt: string;
}

export interface AppConfig {
  storagePath: string;
  aiKeys: AIKeyConfig[]; // 支持多个 API Key
  asrProvider?: string;
  asrApiKey?: string;
  asrBaseURL?: string;
  asrModel?: string;
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
  testApiKey: (keyConfig: AIKeyInput) =>
    ipcRenderer.invoke('test-api-key', keyConfig),
  addApiKey: (keyConfig: Omit<AIKeyConfig, 'id' | 'isActive' | 'isValid' | 'lastTested'>) =>
    ipcRenderer.invoke('add-api-key', keyConfig),
  updateApiKey: (keyId: string, changes: AIKeyChanges) =>
    ipcRenderer.invoke('update-api-key', keyId, changes),
  retestApiKey: (keyId: string) =>
    ipcRenderer.invoke('retest-api-key', keyId),
  removeApiKey: (keyId: string) =>
    ipcRenderer.invoke('remove-api-key', keyId),
  setActiveApiKey: (keyId: string) =>
    ipcRenderer.invoke('set-active-api-key', keyId),

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
