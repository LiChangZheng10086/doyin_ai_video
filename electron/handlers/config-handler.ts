import { ipcMain, app, safeStorage } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig, AIKeyConfig } from '../preload';
import { randomUUID } from 'crypto';

const CONFIG_FILE = 'config.json';

function getConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

// 默认配置
function getDefaultConfig(): AppConfig {
  return {
    storagePath: path.join(app.getPath('documents'), '抖音AI视频'),
    aiKeys: [],
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

// 测试 API Key
async function testApiKey(keyConfig: Omit<AIKeyConfig, 'id' | 'isActive' | 'isValid' | 'lastTested'>): Promise<{ valid: boolean; error?: string }> {
  try {
    const baseURL = keyConfig.baseURL ||
      (keyConfig.provider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1');

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keyConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: keyConfig.model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
      }),
    });

    if (response.ok) {
      return { valid: true };
    } else {
      const errorData: any = await response.json();
      return {
        valid: false,
        error: errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`
      };
    }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : '网络错误'
    };
  }
}

// 读取配置
export async function loadConfig(): Promise<AppConfig> {
  const configPath = getConfigPath();
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(data) as AppConfig;

    // 解密所有 API Keys
    if (config.aiKeys && Array.isArray(config.aiKeys)) {
      config.aiKeys = config.aiKeys.map(key => ({
        ...key,
        apiKey: decryptApiKey(key.apiKey),
      }));
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
    aiKeys: config.aiKeys || existingConfig.aiKeys,
    app: {
      ...existingConfig.app,
      ...(config.app || {}),
    },
  };

  // 加密所有 API Keys
  const configToSave = {
    ...newConfig,
    aiKeys: newConfig.aiKeys.map(key => ({
      ...key,
      apiKey: encryptApiKey(key.apiKey),
    })),
  };

  // 确保目录存在
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  // 写入配置文件
  await fs.writeFile(configPath, JSON.stringify(configToSave, null, 2), 'utf-8');
}

// 添加 API Key
async function addApiKey(keyConfig: Omit<AIKeyConfig, 'id' | 'isActive' | 'isValid' | 'lastTested'>): Promise<string> {
  const config = await loadConfig();
  const id = randomUUID();

  const newKey: AIKeyConfig = {
    ...keyConfig,
    id,
    isActive: config.aiKeys.length === 0, // 第一个自动激活
    isValid: undefined,
    lastTested: undefined,
  };

  config.aiKeys.push(newKey);
  await saveConfig(config);

  return id;
}

// 删除 API Key
async function removeApiKey(keyId: string): Promise<void> {
  const config = await loadConfig();
  config.aiKeys = config.aiKeys.filter(key => key.id !== keyId);

  // 如果删除的是活跃 Key，激活第一个
  if (!config.aiKeys.find(key => key.isActive) && config.aiKeys.length > 0) {
    config.aiKeys[0].isActive = true;
  }

  await saveConfig(config);
}

// 设置活跃的 API Key
async function setActiveApiKey(keyId: string): Promise<void> {
  const config = await loadConfig();
  config.aiKeys = config.aiKeys.map(key => ({
    ...key,
    isActive: key.id === keyId,
  }));
  await saveConfig(config);
}

// 注册 IPC 处理器
export function registerConfigHandlers(): void {
  ipcMain.handle('get-config', async () => {
    return await loadConfig();
  });

  ipcMain.handle('save-config', async (_, config: Partial<AppConfig>) => {
    await saveConfig(config);
  });

  ipcMain.handle('test-api-key', async (_, keyConfig: Omit<AIKeyConfig, 'id' | 'isActive' | 'isValid' | 'lastTested'>) => {
    return await testApiKey(keyConfig);
  });

  ipcMain.handle('add-api-key', async (_, keyConfig: Omit<AIKeyConfig, 'id' | 'isActive' | 'isValid' | 'lastTested'>) => {
    return await addApiKey(keyConfig);
  });

  ipcMain.handle('remove-api-key', async (_, keyId: string) => {
    await removeApiKey(keyId);
  });

  ipcMain.handle('set-active-api-key', async (_, keyId: string) => {
    await setActiveApiKey(keyId);
  });
}
