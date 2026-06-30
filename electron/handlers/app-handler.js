"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAppHandlers = registerAppHandlers;
const electron_1 = require("electron");
const main_1 = require("../main");
// 注册应用相关的 IPC 处理器
function registerAppHandlers() {
    // 获取应用版本
    electron_1.ipcMain.handle('get-version', () => {
        return electron_1.app.getVersion();
    });
    // 获取 Express 服务器端口
    electron_1.ipcMain.handle('get-server-port', () => {
        return (0, main_1.getServerPort)();
    });
    // 在外部浏览器打开链接
    electron_1.ipcMain.handle('open-external', async (_, url) => {
        await electron_1.shell.openExternal(url);
    });
    // 在文件管理器中显示文件
    electron_1.ipcMain.handle('show-item-in-folder', (_, filePath) => {
        electron_1.shell.showItemInFolder(filePath);
    });
    // 显示系统通知
    electron_1.ipcMain.handle('show-notification', (_, title, body) => {
        if (electron_1.Notification.isSupported()) {
            new electron_1.Notification({
                title,
                body,
            }).show();
        }
    });
}
