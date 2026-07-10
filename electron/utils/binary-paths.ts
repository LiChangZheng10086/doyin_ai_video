import { app } from 'electron';
import path from 'path';

export interface BinaryPaths {
  ffmpeg: string;
  ytdlp: string;
  whisperCli: string;
  whisperModel: string;
}

export function getBinaryPaths(): BinaryPaths {
  const isDev = !app.isPackaged;
  const platform = process.platform;

  if (isDev) {
    const whisperPath = path.join(process.cwd(), 'vendor', 'whisper');
    // 开发环境：假设用户已安装这些工具
    return {
      ffmpeg: 'ffmpeg',
      ytdlp: 'yt-dlp',
      whisperCli: path.join(whisperPath, platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'),
      whisperModel: path.join(whisperPath, 'models', 'ggml-small.bin'),
    };
  }

  // 生产环境：使用打包的二进制文件
  const resourcesPath = process.resourcesPath;
  const binPath = path.join(resourcesPath, 'bin');
  const whisperPath = path.join(resourcesPath, 'whisper');

  if (platform === 'win32') {
    return {
      ffmpeg: path.join(binPath, 'ffmpeg.exe'),
      ytdlp: path.join(binPath, 'yt-dlp.exe'),
      whisperCli: path.join(whisperPath, 'whisper-cli.exe'),
      whisperModel: path.join(whisperPath, 'models', 'ggml-small.bin'),
    };
  } else if (platform === 'darwin') {
    return {
      ffmpeg: path.join(binPath, 'ffmpeg'),
      ytdlp: path.join(binPath, 'yt-dlp'),
      whisperCli: path.join(whisperPath, 'whisper-cli'),
      whisperModel: path.join(whisperPath, 'models', 'ggml-small.bin'),
    };
  } else {
    // Linux（暂不支持，但提供默认值）
    return {
      ffmpeg: 'ffmpeg',
      ytdlp: 'yt-dlp',
      whisperCli: path.join(whisperPath, 'whisper-cli'),
      whisperModel: path.join(whisperPath, 'models', 'ggml-small.bin'),
    };
  }
}
