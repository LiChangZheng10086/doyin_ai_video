import { ipcMain, app, safeStorage } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '../preload';

const CONFIG_FILE = 'config.json';

function getConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

// 默认配置
function getDefaultConfig(): AppConfig {
  return {
    storagePath: path.join(app.getPath('documents'), '抖音AI视频'),
    ai: {
      provider: 'deepseek',
      apiKey: '',
      model: 'deepseek-chat',
    },
    app: {
      firstRun: true,
      theme: 'system',
    },
  };
}

// 加密 API Key
function encryptApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('Encryption not available, storing API key in plain text');
    return apiKey;
  }
  return safeStorage.encryptString(apiKey).toString('base64');
}

// 解密 API Key
function decryptApiKey(encrypted: string): string {
  if (!encrypted) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    return encrypted;
  }
  try {
    const buffer = Buffer.from(encrypted, 'base64');
    return safeStorage.decryptString(buffer);
  } catch (error) {
    console.error('Failed to decrypt API key:', error);
    return '';
  }
}

// 读取配置
export async function loadConfig(): Promise<AppConfig> {
  const configPath = getConfigPath();
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(data) as AppConfig;

    // 解密 API Key
    if (config.ai.apiKey) {
      config.ai.apiKey = decryptApiKey(config.ai.apiKey);
    }

    return config;
  } catch (error) {
    // 配置文件不存在，返回默认配置
    return getDefaultConfig();
  }
}

// 保存配置
export async function saveConfig(config: Partial<AppConfig>): Promise<void> {
  const configPath = getConfigPath();

  // 读取现有配置
  const existingConfig = await loadConfig();

  // 合并配置
  const newConfig: AppConfig = {
    ...existingConfig,
    ...config,
    ai: {
      ...existingConfig.ai,
      ...(config.ai || {}),
    },
    app: {
      ...existingConfig.app,
      ...(config.app || {}),
    },
  };

  // 加密 API Key
  const configToSave = {
    ...newConfig,
    ai: {
      ...newConfig.ai,
      apiKey: encryptApiKey(newConfig.ai.apiKey),
    },
  };

  // 确保目录存在
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  // 写入配置文件
  await fs.writeFile(configPath, JSON.stringify(configToSave, null, 2), 'utf-8');
}

// 注册 IPC 处理器
export function registerConfigHandlers(): void {
  ipcMain.handle('get-config', async () => {
    return await loadConfig();
  });

  ipcMain.handle('save-config', async (_, config: Partial<AppConfig>) => {
    await saveConfig(config);
  });
}
