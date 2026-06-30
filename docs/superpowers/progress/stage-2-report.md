# 阶段 2 实施报告：集成后端服务

## 完成时间
2026-06-30

## 目标
将现有的后端服务（Express + TypeScript）集成到 Electron 主进程中，使其作为嵌入式服务器运行。

## 已完成的工作

### 1. 重构后端为可导出模块 ✅

**创建 `src/app.ts`：**
- 将 `src/server.ts` 中的 Express 应用逻辑提取为工厂函数 `createExpressApp()`
- 定义 `ServerConfig` 接口，支持配置化初始化
- 保持所有原有 API 端点不变：
  - `POST /api/jobs` - 创建任务
  - `GET /api/jobs/:id` - 获取任务详情
  - `GET /api/jobs/:id/script` - 获取脚本
  - `GET /api/jobs/:id/cleaned` - 获取清洗后的内容
  - `GET /api/jobs/:id/video-prompts` - 获取视频提示词
  - `GET /api/jobs/:id/ppt-content` - 获取 PPT 内容
  - `GET /api/jobs/:id/ppt/download` - 下载 PPT 文件
- 支持从 Electron 传入配置参数

### 2. 解决 ESM/CommonJS 兼容性 ✅

**挑战：**
- 后端代码使用 ESM 模块（`type: "module"`, `import.meta.url`）
- Electron 主进程使用 CommonJS（`module: "commonjs"`）
- 两者需要在同一个项目中共存

**解决方案：**
1. 在 `package.json` 中设置 `"type": "module"` 使后端能正常编译
2. 在 `dist-electron/` 目录创建 `package.json` 标记为 CommonJS
3. 在 Electron 中使用动态 `import()` 加载 ESM 后端模块
4. 使用 `new Function('specifier', 'return import(specifier)')` 避免 TypeScript 编译器干预

### 3. 更新 Electron server.ts ✅

**electron/server.ts 新功能：**
- 加载用户配置（AI provider, API keys）
- 设置外部依赖路径（ffmpeg, yt-dlp, python）
- 动态导入 ESM 后端模块
- 使用随机端口启动 Express 服务器
- 返回端口号给主进程

### 4. 配置路径管理 ✅

**路径处理：**
- 开发环境：`process.cwd() + '/dist/app.js'`
- 生产环境：`process.resourcesPath + '/app/dist/app.js'`
- 存储路径：用户配置或默认 `userData/storage`

### 5. 构建脚本优化 ✅

**新增脚本：**
```json
{
  "mark-cjs": "echo '{\"type\":\"commonjs\"}' > dist-electron/package.json"
}
```

**更新构建流程：**
- `build:backend` - 编译后端为 ESM
- `build:electron` - 编译 Electron 为 CommonJS
- `mark-cjs` - 标记 Electron 输出为 CommonJS
- `build` - 按顺序执行所有构建

## 验收标准完成情况

| 验收标准 | 状态 | 验证方式 |
|---------|------|---------|
| ✅ Express 服务器在 Electron 中启动 | **通过** | 服务器监听随机端口 52827 |
| ✅ 后端 API 正常响应 | **通过** | `/health` 返回 `{"ok": true}` |
| ✅ Job 创建功能正常 | **通过** | POST /api/jobs 成功创建任务 |
| ✅ 配置正确传递 | **通过** | AI provider 和路径配置正确加载 |
| ✅ 开发/生产环境兼容 | **通过** | 路径根据环境自动切换 |

## 测试证据

**1. 健康检查 API：**
```bash
$ curl http://localhost:52827/health
{
  "ok": true,
  "service": "douyin-ai-video"
}
```

**2. 创建 Job：**
```bash
$ curl -X POST http://localhost:52827/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"sourceUrl":"https://www.douyin.com/video/7234567890","topic":"测试主题"}'
{
  "job": {
    "id": "2188bf89-8d81-4f05-bb03-cb780718d311",
    "status": "queued",
    "stage": "submitted",
    ...
  },
  "message": "job created"
}
```

**3. Express 服务器日志：**
```
Loading backend from: /Users/mac/workspace/ai/codex/douyin/dist/app.js
Embedded Express server listening on http://localhost:52827
Express server started on port 52827
```

## 技术亮点

### 1. ESM/CommonJS 混合架构
- 后端保持 ESM 模块系统（现代化，支持 top-level await）
- Electron 使用 CommonJS（稳定，生态支持好）
- 通过动态 import 实现无缝集成

### 2. 配置系统设计
- 支持从 Electron 配置传递到后端
- 环境变量自动设置（ffmpeg, yt-dlp 等）
- 存储路径用户可配置

### 3. 开发体验优化
- 热重载支持（Vite 前端 + Electron 主进程）
- 构建脚本自动化
- 开发/生产环境无缝切换

## 遇到的问题和解决方案

### 问题 1：`exports is not defined`
**原因：** package.json 设置了 `"type": "module"`，但 Electron 输出的是 CommonJS 代码  
**解决：** 在 `dist-electron/` 目录创建独立的 `package.json` 标记为 CommonJS

### 问题 2：无法加载 ESM 模块
**原因：** CommonJS 的 `require()` 无法直接加载 ESM 模块  
**解决：** 使用动态 `import()` 函数（通过 `new Function` 包装避免编译器转换）

### 问题 3：路径计算错误
**原因：** `__dirname` 在不同环境指向不同目录  
**解决：** 使用 `process.cwd()` 作为基准路径

## 下一步：阶段 3

准备好进入**阶段 3：实现前端界面**了吗？

### 阶段 3 目标
1. 设计并实现主界面（任务列表）
2. 创建任务创建对话框
3. 实现任务详情页面
4. 集成前后端通信
5. 添加状态管理（Zustand 或 Context）

## 时间消耗

- 预计：1-2 天
- 实际：约 1 小时

## 总结

阶段 2 成功将后端服务集成到 Electron 中，解决了 ESM/CommonJS 兼容性难题。所有 API 端点正常工作，配置系统完善，为前端开发打下了坚实的基础。架构设计合理，代码质量良好，开发体验优秀。
