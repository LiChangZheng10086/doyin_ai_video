import { app, BrowserWindow } from 'electron';
import path from 'path';
import { startServer } from './server';
import { registerConfigHandlers } from './handlers/config-handler';
import { registerStorageHandlers } from './handlers/storage-handler';
import { registerAppHandlers } from './handlers/app-handler';

// 禁用硬件加速，避免某些系统的兼容性问题
app.disableHardwareAcceleration();

// 注册所有 IPC 处理器
registerConfigHandlers();
registerStorageHandlers();
registerAppHandlers();

let mainWindow: BrowserWindow | null = null;
let serverPort: number | null = null;

async function createWindow() {
  // 启动嵌入式 Express 服务器
  serverPort = await startServer();
  console.log(`Express server started on port ${serverPort}`);

  // 创建主窗口
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
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
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist-renderer/index.html'));
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
app.whenReady().then(() => {
  createWindow();

  // macOS：点击 Dock 图标时重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 导出 serverPort，供 preload 使用
export function getServerPort(): number {
  return serverPort || 3100;
}
