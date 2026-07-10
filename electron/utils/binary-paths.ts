import { app } from 'electron';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

export interface BinaryPaths {
  binDir?: string;
  ffmpeg: string;
  ytdlp: string;
  whisperCli: string;
  whisperModel: string;
  hyperframesCli?: string;
  hyperframesBrowser?: string;
}

interface RuntimeAssetsManifest {
  assets?: Record<string, string>;
}

export function getBinaryPaths(): BinaryPaths {
  const isDev = !app.isPackaged;
  const platform = process.platform;

  if (isDev) {
    const whisperPath = path.join(process.cwd(), 'vendor', 'whisper');
    // 开发环境：假设用户已安装这些工具
    return {
      binDir: undefined,
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
  const manifest = readRuntimeAssetsManifest(resourcesPath);
  const assetPath = (key: string, fallback: string) => {
    const relativePath = manifest.assets?.[key];
    return relativePath ? path.join(resourcesPath, relativePath) : fallback;
  };

  if (platform === 'win32') {
    return {
      binDir: binPath,
      ffmpeg: assetPath('ffmpeg', path.join(binPath, 'ffmpeg.exe')),
      ytdlp: assetPath('ytdlp', path.join(binPath, 'yt-dlp.exe')),
      whisperCli: assetPath('whisperCli', path.join(whisperPath, 'whisper-cli.exe')),
      whisperModel: assetPath('whisperModel', path.join(whisperPath, 'models', 'ggml-small.bin')),
      hyperframesCli: assetPath('hyperframesCli', path.join(resourcesPath, 'hyperframes', 'node_modules', 'hyperframes', 'dist', 'cli.js')),
      hyperframesBrowser: assetPath('hyperframesBrowser', path.join(resourcesPath, 'browser', 'chrome-headless-shell.exe')),
    };
  } else if (platform === 'darwin') {
    return {
      binDir: binPath,
      ffmpeg: assetPath('ffmpeg', path.join(binPath, 'ffmpeg')),
      ytdlp: assetPath('ytdlp', path.join(binPath, 'yt-dlp')),
      whisperCli: assetPath('whisperCli', path.join(whisperPath, 'whisper-cli')),
      whisperModel: assetPath('whisperModel', path.join(whisperPath, 'models', 'ggml-small.bin')),
      hyperframesCli: assetPath('hyperframesCli', path.join(resourcesPath, 'hyperframes', 'node_modules', 'hyperframes', 'dist', 'cli.js')),
      hyperframesBrowser: assetPath('hyperframesBrowser', path.join(resourcesPath, 'browser', 'chrome-headless-shell')),
    };
  } else {
    // Linux（暂不支持，但提供默认值）
    return {
      binDir: undefined,
      ffmpeg: 'ffmpeg',
      ytdlp: 'yt-dlp',
      whisperCli: path.join(whisperPath, 'whisper-cli'),
      whisperModel: path.join(whisperPath, 'models', 'ggml-small.bin'),
    };
  }
}

function readRuntimeAssetsManifest(resourcesPath: string): RuntimeAssetsManifest {
  const manifestPath = path.join(resourcesPath, 'runtime-assets-manifest.json');
  if (!existsSync(manifestPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeAssetsManifest;
  } catch {
    return {};
  }
}
