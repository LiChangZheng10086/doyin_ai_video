import { ipcMain, app, shell, Notification } from 'electron';
import { getServerPort } from '../main';

// 注册应用相关的 IPC 处理器
export function registerAppHandlers(): void {
  // 获取应用版本
  ipcMain.handle('get-version', () => {
    return app.getVersion();
  });

  // 获取 Express 服务器端口
  ipcMain.handle('get-server-port', () => {
    return getServerPort();
  });

  // 在外部浏览器打开链接
  ipcMain.handle('open-external', async (_, url: string) => {
    await shell.openExternal(url);
  });

  // 在文件管理器中显示文件
  ipcMain.handle('show-item-in-folder', (_, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // 显示系统通知
  ipcMain.handle('show-notification', (_, title: string, body: string) => {
    if (Notification.isSupported()) {
      new Notification({
        title,
        body,
      }).show();
    }
  });
}
