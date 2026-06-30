"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBinaryPaths = getBinaryPaths;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
function getBinaryPaths() {
    const isDev = !electron_1.app.isPackaged;
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
    const binPath = path_1.default.join(resourcesPath, 'bin');
    const pythonPath = path_1.default.join(resourcesPath, 'python');
    if (platform === 'win32') {
        return {
            ffmpeg: path_1.default.join(binPath, 'ffmpeg.exe'),
            ytdlp: path_1.default.join(binPath, 'yt-dlp.exe'),
            python: path_1.default.join(pythonPath, 'python.exe'),
        };
    }
    else if (platform === 'darwin') {
        return {
            ffmpeg: path_1.default.join(binPath, 'ffmpeg'),
            ytdlp: path_1.default.join(binPath, 'yt-dlp'),
            python: path_1.default.join(pythonPath, 'bin', 'python3'),
        };
    }
    else {
        // Linux（暂不支持，但提供默认值）
        return {
            ffmpeg: 'ffmpeg',
            ytdlp: 'yt-dlp',
            python: 'python3',
        };
    }
}
