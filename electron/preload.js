"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// 暴露安全的 API 到 window.electron
electron_1.contextBridge.exposeInMainWorld('electron', {
    // 存储管理
    selectDirectory: () => electron_1.ipcRenderer.invoke('select-directory'),
    getStoragePath: () => electron_1.ipcRenderer.invoke('get-storage-path'),
    // 配置管理
    getConfig: () => electron_1.ipcRenderer.invoke('get-config'),
    saveConfig: (config) => electron_1.ipcRenderer.invoke('save-config', config),
    // 应用信息
    getVersion: () => electron_1.ipcRenderer.invoke('get-version'),
    getServerPort: () => electron_1.ipcRenderer.invoke('get-server-port'),
    // 文件操作
    openExternal: (url) => electron_1.ipcRenderer.invoke('open-external', url),
    showItemInFolder: (path) => electron_1.ipcRenderer.invoke('show-item-in-folder', path),
    // 系统通知
    showNotification: (title, body) => electron_1.ipcRenderer.invoke('show-notification', title, body),
});
