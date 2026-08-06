import { AddressInfo } from 'net';
import path from 'path';
import { app as electronApp } from 'electron';
import { getBinaryPaths } from './utils/binary-paths';
import { loadConfig } from './handlers/config-handler';

let serverInstance: any = null;

export async function startServer(): Promise<number> {
  return new Promise(async (resolve, reject) => {
    try {
      // 设置外部依赖路径
      const binaryPaths = getBinaryPaths();

      // 加载配置
      const config = await loadConfig();

      // 获取当前活跃的 API Key
      const activeKey = config.aiKeys.find(key => key.isActive);

      // 确定后端模块路径
      const isDev = !electronApp.isPackaged;
      const appModulePath = isDev
        ? path.join(process.cwd(), 'dist', 'app.js')
        : path.join(process.resourcesPath, 'app', 'dist', 'app.js');

      console.log('Loading backend from:', appModulePath);

      // 动态导入 ESM 后端模块
      // 使用 eval 包裹 import() 来避免 TypeScript 编译器将其转换为 require
      const dynamicImport = new Function('specifier', 'return import(specifier)');
      const appModule = await dynamicImport('file://' + appModulePath);
      const { createExpressApp } = appModule;

      // 创建 Express 应用
      const expressApp = await createExpressApp({
        storagePath: config.storagePath,
        rootDir: isDev ? path.join(__dirname, '../..') : electronApp.getAppPath(),
        aiProvider: activeKey?.provider || 'deepseek',
        aiModel: activeKey?.model || 'deepseek-chat',
        aiApiKey: activeKey?.apiKey || '',
        aiBaseURL: activeKey?.baseURL || (activeKey?.provider === 'deepseek' ? 'https://api.deepseek.com' : undefined),
        resolveAiConfig: async () => {
          const latest = await loadConfig();
          const current = latest.aiKeys.find(key => key.isActive);
          return current ? {
            provider: current.provider,
            model: current.model,
            apiKey: current.apiKey,
            baseURL: current.baseURL || (current.provider === 'deepseek'
              ? 'https://api.deepseek.com'
              : current.provider === 'openai' ? 'https://api.openai.com/v1' : undefined),
          } : null;
        },
        ytDlpBinary: binaryPaths.ytdlp,
        ffmpegBinary: binaryPaths.ffmpeg,
        ffprobeBinary: binaryPaths.ffprobe,
        whisperCliPath: binaryPaths.whisperCli,
        whisperModelPath: binaryPaths.whisperModel,
        runtimeBinDir: binaryPaths.binDir,
        hyperframesCliPath: binaryPaths.hyperframesCli,
        hyperframesNodeBinary: process.execPath,
        hyperframesUseElectronAsNode: electronApp.isPackaged,
        hyperframesBrowserPath: binaryPaths.hyperframesBrowser,
      });

      const PORT = 0; // 使用随机端口

      serverInstance = expressApp.listen(PORT, 'localhost', () => {
        const address = serverInstance.address() as AddressInfo;
        const port = address.port;
        console.log(`Embedded Express server listening on http://localhost:${port}`);
        resolve(port);
      });

      // 设置全局超时：10 分钟（generate-skill 等路由需要较长时间）
      serverInstance.timeout = 600_000;

      serverInstance.on('error', (err: Error) => {
        console.error('Failed to start Express server:', err);
        reject(err);
      });
    } catch (error) {
      console.error('Error in startServer:', error);
      reject(error);
    }
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
