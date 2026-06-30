"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.registerConfigHandlers = registerConfigHandlers;
const electron_1 = require("electron");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const CONFIG_FILE = 'config.json';
function getConfigPath() {
    return path_1.default.join(electron_1.app.getPath('userData'), CONFIG_FILE);
}
// 默认配置
function getDefaultConfig() {
    return {
        storagePath: path_1.default.join(electron_1.app.getPath('documents'), '抖音AI视频'),
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
function encryptApiKey(apiKey) {
    if (!apiKey)
        return '';
    if (!electron_1.safeStorage.isEncryptionAvailable()) {
        console.warn('Encryption not available, storing API key in plain text');
        return apiKey;
    }
    return electron_1.safeStorage.encryptString(apiKey).toString('base64');
}
// 解密 API Key
function decryptApiKey(encrypted) {
    if (!encrypted)
        return '';
    if (!electron_1.safeStorage.isEncryptionAvailable()) {
        return encrypted;
    }
    try {
        const buffer = Buffer.from(encrypted, 'base64');
        return electron_1.safeStorage.decryptString(buffer);
    }
    catch (error) {
        console.error('Failed to decrypt API key:', error);
        return '';
    }
}
// 读取配置
async function loadConfig() {
    const configPath = getConfigPath();
    try {
        const data = await promises_1.default.readFile(configPath, 'utf-8');
        const config = JSON.parse(data);
        // 解密 API Key
        if (config.ai.apiKey) {
            config.ai.apiKey = decryptApiKey(config.ai.apiKey);
        }
        return config;
    }
    catch (error) {
        // 配置文件不存在，返回默认配置
        return getDefaultConfig();
    }
}
// 保存配置
async function saveConfig(config) {
    const configPath = getConfigPath();
    // 读取现有配置
    const existingConfig = await loadConfig();
    // 合并配置
    const newConfig = {
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
    await promises_1.default.mkdir(path_1.default.dirname(configPath), { recursive: true });
    // 写入配置文件
    await promises_1.default.writeFile(configPath, JSON.stringify(configToSave, null, 2), 'utf-8');
}
// 注册 IPC 处理器
function registerConfigHandlers() {
    electron_1.ipcMain.handle('get-config', async () => {
        return await loadConfig();
    });
    electron_1.ipcMain.handle('save-config', async (_, config) => {
        await saveConfig(config);
    });
}
