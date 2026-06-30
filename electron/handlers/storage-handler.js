"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerStorageHandlers = registerStorageHandlers;
const electron_1 = require("electron");
const config_handler_1 = require("./config-handler");
// 注册存储相关的 IPC 处理器
function registerStorageHandlers() {
    // 选择目录
    electron_1.ipcMain.handle('select-directory', async () => {
        const result = await electron_1.dialog.showOpenDialog({
            title: '选择数据存储目录',
            properties: ['openDirectory', 'createDirectory'],
            buttonLabel: '选择',
        });
        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        return result.filePaths[0];
    });
    // 获取当前存储路径
    electron_1.ipcMain.handle('get-storage-path', async () => {
        const config = await (0, config_handler_1.loadConfig)();
        return config.storagePath;
    });
}
