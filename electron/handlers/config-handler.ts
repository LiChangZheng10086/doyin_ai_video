import { ipcMain, app, safeStorage } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { resolve4, resolve6 } from 'dns/promises';
import { AppConfig, AIKeyChanges, AIKeyConfig, AIKeyInput, AIKeyTestResult, AiErrorCode } from '../preload';
import { randomUUID } from 'crypto';
import { classifyHttpFailure, classifyNetworkFailure, mergeAiKeyChanges, normalizeBaseURL, normalizeMaxOutputTokens } from '../utils/ai-config';

const CONFIG_FILE = 'config.json';

function getConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

// 默认配置
function getDefaultConfig(): AppConfig {
  return {
    storagePath: path.join(app.getPath('userData'), 'storage'),
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
async function testApiKey(keyConfig: AIKeyInput): Promise<AIKeyTestResult> {
  const testedAt = new Date().toISOString();
  const baseURL = normalizeBaseURL(keyConfig.baseURL) || defaultBaseURL(keyConfig.provider);
  if (!baseURL) {
    return { valid: false, code: 'endpoint', error: `请填写自定义 API 地址（模型：${keyConfig.model}）`, testedAt };
  }
  const hostname = getHostname(baseURL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
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
      signal: controller.signal,
    });

    if (response.ok) {
      return { valid: true, testedAt };
    }
    const errorData = await response.json().catch(() => ({})) as { error?: { message?: string } };
    const rawMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
    const code = classifyHttpFailure(response.status, rawMessage);
    return { valid: false, code, error: formatAiTestError(code, hostname, keyConfig.model, response.status), testedAt };
  } catch (error) {
    let code: AiErrorCode = classifyNetworkFailure(error);
    if (code === 'unknown' && hostname !== '未知地址' && !(await hasDnsRecords(hostname))) code = 'dns';
    return { valid: false, code, error: formatAiTestError(code, hostname, keyConfig.model), testedAt };
  } finally {
    clearTimeout(timeout);
  }
}

function defaultBaseURL(provider: AIKeyConfig['provider']) {
  if (provider === 'deepseek') return 'https://api.deepseek.com';
  if (provider === 'openai') return 'https://api.openai.com/v1';
  return '';
}

function normalizeAiKey<T extends AIKeyInput>(keyConfig: T): T {
  return {
    ...keyConfig,
    baseURL: normalizeBaseURL(keyConfig.baseURL) || defaultBaseURL(keyConfig.provider),
    maxOutputTokens: normalizeMaxOutputTokens(keyConfig.maxOutputTokens),
  };
}

function getHostname(baseURL: string) {
  try {
    return new URL(baseURL).hostname;
  } catch {
    return '未知地址';
  }
}

async function hasDnsRecords(hostname: string) {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  return results.some(result => result.status === 'fulfilled' && result.value.length > 0);
}

function formatAiTestError(code: AiErrorCode, hostname: string, model: string, status?: number) {
  const modelSuffix = model ? `（模型：${model}）` : '';
  const messages: Record<AiErrorCode, string> = {
    dns: `无法解析 API 域名 ${hostname}，请填写中转服务商提供的新地址`,
    tls: `TLS、证书或代理连接失败（域名：${hostname}）`,
    timeout: `连接 AI 服务超时（域名：${hostname}）`,
    auth: 'API Key 无效或没有访问权限',
    endpoint: `API 地址路径不正确${status ? `（HTTP ${status}）` : ''}`,
    model: '模型 ID 不存在或当前账号无权使用',
    quota: 'API 请求被限流或额度不足',
    upstream: `AI 中转服务暂时不可用${status ? `（HTTP ${status}）` : ''}`,
    unknown: `AI 服务连接失败（域名：${hostname}）`,
  };
  return `${messages[code]}${modelSuffix}`;
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
async function addApiKey(keyConfig: AIKeyInput): Promise<string> {
  const config = await loadConfig();
  const normalized = normalizeAiKey(keyConfig);
  const result = await testApiKey(normalized);
  if (!result.valid) throw new Error(result.error || 'API 配置测试失败');
  const id = randomUUID();

  const newKey: AIKeyConfig = {
    ...normalized,
    id,
    isActive: config.aiKeys.length === 0, // 第一个自动激活
    isValid: true,
    lastTested: result.testedAt,
  };

  config.aiKeys.push(newKey);
  await saveConfig(config);

  return id;
}

async function updateApiKey(keyId: string, changes: AIKeyChanges): Promise<void> {
  const config = await loadConfig();
  const index = config.aiKeys.findIndex(key => key.id === keyId);
  if (index < 0) throw new Error('API 配置不存在');
  const merged = normalizeAiKey(mergeAiKeyChanges(config.aiKeys[index], {
    ...changes,
    apiKey: changes.apiKey || '',
  }));
  const result = await testApiKey(merged);
  if (!result.valid) throw new Error(result.error || 'API 配置测试失败，原配置未修改');
  config.aiKeys[index] = { ...merged, isValid: true, lastTested: result.testedAt };
  await saveConfig(config);
}

async function retestApiKey(keyId: string): Promise<AIKeyTestResult> {
  const config = await loadConfig();
  const index = config.aiKeys.findIndex(key => key.id === keyId);
  if (index < 0) throw new Error('API 配置不存在');
  const result = await testApiKey(config.aiKeys[index]);
  config.aiKeys[index] = {
    ...config.aiKeys[index],
    isValid: result.valid,
    lastTested: result.testedAt,
    ...(result.valid ? {} : { isActive: false }),
  };
  await saveConfig(config);
  return result;
}

// 删除 API Key
async function removeApiKey(keyId: string): Promise<void> {
  const config = await loadConfig();
  config.aiKeys = config.aiKeys.filter(key => key.id !== keyId);

  await saveConfig(config);
}

// 设置活跃的 API Key
async function setActiveApiKey(keyId: string): Promise<void> {
  const config = await loadConfig();
  const target = config.aiKeys.find(key => key.id === keyId);
  if (!target) throw new Error('API 配置不存在');
  const result = await testApiKey(target);
  if (!result.valid) {
    config.aiKeys = config.aiKeys.map(key => key.id === keyId
      ? { ...key, isValid: false, lastTested: result.testedAt }
      : key);
    await saveConfig(config);
    throw new Error(result.error || 'API 配置测试失败，无法设为当前');
  }
  config.aiKeys = config.aiKeys.map(key => ({
    ...key,
    isActive: key.id === keyId,
    ...(key.id === keyId ? { isValid: true, lastTested: result.testedAt } : {}),
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

  ipcMain.handle('test-api-key', async (_, keyConfig: AIKeyInput) => {
    return await testApiKey(keyConfig);
  });

  ipcMain.handle('add-api-key', async (_, keyConfig: AIKeyInput) => {
    return await addApiKey(keyConfig);
  });

  ipcMain.handle('update-api-key', async (_, keyId: string, changes: AIKeyChanges) => {
    await updateApiKey(keyId, changes);
  });

  ipcMain.handle('retest-api-key', async (_, keyId: string) => {
    return await retestApiKey(keyId);
  });

  ipcMain.handle('remove-api-key', async (_, keyId: string) => {
    await removeApiKey(keyId);
  });

  ipcMain.handle('set-active-api-key', async (_, keyId: string) => {
    await setActiveApiKey(keyId);
  });
}
