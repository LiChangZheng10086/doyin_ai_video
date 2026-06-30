"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = startServer;
exports.stopServer = stopServer;
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const binary_paths_1 = require("./utils/binary-paths");
// 导入现有的后端路由
// 注意：这里需要根据实际的后端结构调整
let serverInstance = null;
async function startServer() {
    return new Promise((resolve, reject) => {
        // 设置外部依赖路径
        const binaryPaths = (0, binary_paths_1.getBinaryPaths)();
        process.env.FFMPEG_PATH = binaryPaths.ffmpeg;
        process.env.YTDLP_PATH = binaryPaths.ytdlp;
        process.env.PYTHON_PATH = binaryPaths.python;
        // 设置存储路径（从配置读取，首次运行使用默认值）
        const userDataPath = electron_1.app.getPath('userData');
        const defaultStoragePath = path_1.default.join(userDataPath, 'storage');
        process.env.STORAGE_PATH = defaultStoragePath;
        // 动态导入现有的后端服务器
        // 这里我们需要修改现有的 src/server.ts 使其可以被导入
        const app = (0, express_1.default)();
        // 临时：复用现有路由的简单方式
        // 实际实现时需要重构 src/server.ts
        const PORT = 0; // 使用随机端口
        serverInstance = app.listen(PORT, 'localhost', () => {
            const address = serverInstance.address();
            const port = address.port;
            console.log(`Embedded Express server listening on http://localhost:${port}`);
            resolve(port);
        });
        serverInstance.on('error', (err) => {
            console.error('Failed to start Express server:', err);
            reject(err);
        });
    });
}
function stopServer() {
    return new Promise((resolve) => {
        if (serverInstance) {
            serverInstance.close(() => {
                console.log('Express server stopped');
                resolve();
            });
        }
        else {
            resolve();
        }
    });
}
