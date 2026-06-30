import express from 'express';
import { AddressInfo } from 'net';
import path from 'path';
import { app as electronApp } from 'electron';
import { getBinaryPaths } from './utils/binary-paths';

// 导入现有的后端路由
// 注意：这里需要根据实际的后端结构调整
let serverInstance: any = null;

export async function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    // 设置外部依赖路径
    const binaryPaths = getBinaryPaths();
    process.env.FFMPEG_PATH = binaryPaths.ffmpeg;
    process.env.YTDLP_PATH = binaryPaths.ytdlp;
    process.env.PYTHON_PATH = binaryPaths.python;

    // 设置存储路径（从配置读取，首次运行使用默认值）
    const userDataPath = electronApp.getPath('userData');
    const defaultStoragePath = path.join(userDataPath, 'storage');
    process.env.STORAGE_PATH = defaultStoragePath;

    // 动态导入现有的后端服务器
    // 这里我们需要修改现有的 src/server.ts 使其可以被导入
    const app = express();

    // 临时：复用现有路由的简单方式
    // 实际实现时需要重构 src/server.ts
    const PORT = 0; // 使用随机端口

    serverInstance = app.listen(PORT, 'localhost', () => {
      const address = serverInstance.address() as AddressInfo;
      const port = address.port;
      console.log(`Embedded Express server listening on http://localhost:${port}`);
      resolve(port);
    });

    serverInstance.on('error', (err: Error) => {
      console.error('Failed to start Express server:', err);
      reject(err);
    });
  });
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (serverInstance) {
      serverInstance.close(() => {
        console.log('Express server stopped');
        resolve();
      });
    } else {
      resolve();
    }
  });
}
