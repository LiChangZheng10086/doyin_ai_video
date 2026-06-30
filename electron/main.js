"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getServerPort = getServerPort;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const server_1 = require("./server");
const config_handler_1 = require("./handlers/config-handler");
const storage_handler_1 = require("./handlers/storage-handler");
const app_handler_1 = require("./handlers/app-handler");
// 禁用硬件加速，避免某些系统的兼容性问题
electron_1.app.disableHardwareAcceleration();
// 注册所有 IPC 处理器
(0, config_handler_1.registerConfigHandlers)();
(0, storage_handler_1.registerStorageHandlers)();
(0, app_handler_1.registerAppHandlers)();
let mainWindow = null;
let serverPort = null;
async function createWindow() {
    // 启动嵌入式 Express 服务器
    serverPort = await (0, server_1.startServer)();
    console.log(`Express server started on port ${serverPort}`);
    // 创建主窗口
    mainWindow = new electron_1.BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
        titleBarStyle: 'default',
        show: false, // 等待加载完成后再显示
    });
    // 开发环境：加载 Vite 开发服务器
    // 生产环境：加载构建后的文件
    if (process.env.NODE_ENV === 'development') {
        await mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    }
    else {
        await mainWindow.loadFile(path_1.default.join(__dirname, '../dist-renderer/index.html'));
    }
    // 窗口准备好后显示
    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });
    // 窗口关闭时清理
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
// 应用准备就绪
electron_1.app.whenReady().then(() => {
    createWindow();
    // macOS：点击 Dock 图标时重新创建窗口
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
// 所有窗口关闭时退出（macOS 除外）
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
// 导出 serverPort，供 preload 使用
function getServerPort() {
    return serverPort || 3100;
}
