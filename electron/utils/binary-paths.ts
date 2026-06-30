import { app } from 'electron';
import path from 'path';

export interface BinaryPaths {
  ffmpeg: string;
  ytdlp: string;
  python: string;
}

export function getBinaryPaths(): BinaryPaths {
  const isDev = !app.isPackaged;
  const platform = process.platform;

  if (isDev) {
    // 开发环境：假设用户已安装这些工具
    return {
      ffmpeg: 'ffmpeg',
      ytdlp: 'yt-dlp',
      python: 'python3',
    };
  }

  // 生产环境：使用打包的二进制文件
  const resourcesPath = process.resourcesPath;
  const binPath = path.join(resourcesPath, 'bin');
  const pythonPath = path.join(resourcesPath, 'python');

  if (platform === 'win32') {
    return {
      ffmpeg: path.join(binPath, 'ffmpeg.exe'),
      ytdlp: path.join(binPath, 'yt-dlp.exe'),
      python: path.join(pythonPath, 'python.exe'),
    };
  } else if (platform === 'darwin') {
    return {
      ffmpeg: path.join(binPath, 'ffmpeg'),
      ytdlp: path.join(binPath, 'yt-dlp'),
      python: path.join(pythonPath, 'bin', 'python3'),
    };
  } else {
    // Linux（暂不支持，但提供默认值）
    return {
      ffmpeg: 'ffmpeg',
      ytdlp: 'yt-dlp',
      python: 'python3',
    };
  }
}
