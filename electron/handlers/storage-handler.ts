import { ipcMain, dialog } from 'electron';
import { loadConfig } from './config-handler';

// 注册存储相关的 IPC 处理器
export function registerStorageHandlers(): void {
  // 选择目录
  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
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
  ipcMain.handle('get-storage-path', async () => {
    const config = await loadConfig();
    return config.storagePath;
  });
}
