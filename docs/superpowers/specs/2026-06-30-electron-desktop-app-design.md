# 抖音 AI 视频生成器 - Electron 桌面应用设计方案

> **设计日期：** 2026-06-30  
> **目标：** 将现有 Web Demo 升级为跨平台桌面应用（Windows + macOS）  
> **用户定位：** 分发给同事/朋友（少量用户）  
> **预计开发周期：** 1-2 周

---

## 1. 设计背景

### 1.1 当前项目状态

项目已实现完整的 Web Demo，具备以下能力：

- ✅ 抖音链接解析和视频下载
- ✅ 音频提取和 ASR 转写
- ✅ AI 内容清洗（DeepSeek/OpenAI）
- ✅ 结构化技术分享脚本生成
- ✅ 电影级视频场景提示词生成（video-master skill）
- ✅ 自动 PPT 生成（ppt-generator-skill）
- ✅ 简单的 HTML 前端界面

**技术栈：**
- 后端：TypeScript + Express + Node.js
- 前端：原生 HTML/CSS/JavaScript
- 外部依赖：ffmpeg, yt-dlp, Python 3.13 + python-pptx

### 1.2 升级目标

将项目改造为可独立安装的桌面应用，满足以下需求：

1. **一键安装** - 用户下载安装包后直接使用，无需配置环境
2. **全依赖打包** - 包含 ffmpeg、yt-dlp、Python 等所有依赖
3. **现代界面** - 使用 React 重写前端，提供更好的用户体验
4. **配置管理** - 应用内设置界面，支持 API Key 配置
5. **跨平台** - 同时支持 Windows 和 macOS

---

## 2. 技术方案选择

### 2.1 方案对比

考虑了三种桌面应用方案：

| 方案 | 优点 | 缺点 | 推荐度 |
|------|------|------|--------|
| **Electron + React** | 成熟稳定、生态丰富、打包简单 | 安装包较大（~250MB） | ⭐⭐⭐⭐⭐ |
| Tauri + React | 轻量、性能好 | 生态年轻、打包复杂 | ⭐⭐⭐ |
| Electron + Vue | 和方案 1 类似 | 案例相对较少 | ⭐⭐⭐⭐ |

### 2.2 最终选择

**Electron + React + TypeScript**

**理由：**
1. Electron 是最成熟的跨平台桌面方案
2. 可以复用现有的 TypeScript 后端代码
3. React 生态强大，组件库丰富
4. electron-builder 支持打包外部依赖
5. 开发效率高，调试工具完善

---

## 3. 整体架构设计

### 3.1 三层架构

```
┌─────────────────────────────────────────────┐
│          Electron 主进程 (Main)             │
│  - 管理应用生命周期                          │
│  - 创建和管理窗口                            │
│  - 启动嵌入式 Express 服务器                 │
│  - 管理外部依赖（ffmpeg/yt-dlp/Python）      │
│  - IPC 通信桥接                              │
└─────────────────────────────────────────────┘
                    ↕ IPC
┌─────────────────────────────────────────────┐
│       Electron 渲染进程 (Renderer)          │
│  - React 18 + TypeScript                   │
│  - 现代 UI 界面（shadcn/ui）                │
│  - 状态管理（Zustand）                       │
│  - 与后端通过 HTTP 通信                      │
└─────────────────────────────────────────────┘
                    ↕ HTTP
┌─────────────────────────────────────────────┐
│        嵌入式 Express 服务器 (Backend)      │
│  - 复用现有的 TypeScript 后端代码            │
│  - 在主进程中启动，监听 localhost 随机端口   │
│  - 处理所有业务逻辑                          │
│  - 调用外部工具（ffmpeg/yt-dlp/Python）     │
└─────────────────────────────────────────────┘
```

### 3.2 关键设计决策

#### Express 服务器嵌入主进程

- **方案：** Express 服务器在 Electron 主进程中启动
- **端口：** 随机端口（如 47832），避免冲突
- **通信：** 通过 IPC 将端口号传递给渲染进程
- **优势：** 复用现有代码，开发效率高

#### 外部依赖打包策略

所有外部依赖打包进 `resources/` 目录：

```
resources/
├── bin/
│   ├── ffmpeg-win.exe
│   ├── ffmpeg-mac
│   ├── yt-dlp-win.exe
│   └── yt-dlp-mac
└── python/
    ├── python.exe (Windows embeddable)
    ├── python3 (macOS)
    └── site-packages/
        └── python-pptx/
```

主进程启动时设置 PATH 环境变量指向这些二进制文件。

#### 数据存储路径

- **首次启动：** 弹出对话框让用户选择存储目录
- **配置保存：** `app.getPath('userData')/config.json`
- **用户数据：** 用户选择的目录（如 `~/Documents/抖音AI视频/`）
- **可更改：** 用户可以在设置页面更改存储路径

---

## 4. 项目结构设计

### 4.1 目录结构

```
douyin-ai-video/
├── electron/                      # Electron 主进程代码
│   ├── main.ts                    # 主进程入口
│   ├── preload.ts                 # 预加载脚本（IPC 桥接）
│   ├── server.ts                  # 启动 Express 服务器
│   ├── windows/                   # 窗口管理
│   │   ├── main-window.ts
│   │   └── settings-window.ts
│   ├── handlers/                  # IPC 处理器
│   │   ├── storage-handler.ts
│   │   ├── config-handler.ts
│   │   └── app-handler.ts
│   └── utils/
│       └── binary-paths.ts        # 外部依赖路径管理
│
├── src/                           # 现有后端代码（保持不变）
│   ├── server.ts
│   ├── lib/
│   └── types.ts
│
├── renderer/                      # React 前端（新增）
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── Home.tsx
│   │   │   ├── TaskDetail.tsx
│   │   │   ├── History.tsx
│   │   │   └── Settings.tsx
│   │   ├── components/
│   │   │   ├── TaskCard.tsx
│   │   │   ├── ProgressBar.tsx
│   │   │   ├── ScriptViewer.tsx
│   │   │   ├── VideoPromptViewer.tsx
│   │   │   └── PPTPreview.tsx
│   │   ├── hooks/
│   │   │   ├── useTask.ts
│   │   │   └── useConfig.ts
│   │   ├── store/
│   │   │   └── app-store.ts
│   │   ├── api/
│   │   │   └── client.ts
│   │   └── styles/
│   │       └── globals.css
│   ├── index.html
│   └── vite.config.ts
│
├── resources/                     # 打包资源
│   ├── bin/
│   └── python/
│
├── scripts/                       # 构建脚本
│   ├── download-binaries.js
│   └── package-python.js
│
├── .agents/                       # Skills（保持不变）
├── docs/
├── package.json
├── electron-builder.yml
├── tsconfig.json
├── tsconfig.electron.json
└── tsconfig.renderer.json
```

### 4.2 构建流程

**开发模式：**
```bash
npm run dev
├─→ 启动 Vite (React 热重载)
├─→ 启动 tsc --watch (Electron 编译)
└─→ 启动 Electron
```

**生产构建：**
```bash
npm run build
├─→ build:renderer   (Vite 构建前端)
├─→ build:electron   (编译主进程)
├─→ build:backend    (编译后端)
└─→ download:binaries (下载外部依赖)

npm run package
└─→ electron-builder
    ├─→ macOS: .dmg
    └─→ Windows: .exe
```

---

## 5. IPC 通信设计

### 5.1 安全的 IPC API

在 `preload.ts` 中暴露安全的 API：

```typescript
interface ElectronAPI {
  // 存储管理
  selectDirectory: () => Promise<string | null>;
  getStoragePath: () => Promise<string>;
  
  // 配置管理
  getConfig: () => Promise<AppConfig>;
  saveConfig: (config: Partial<AppConfig>) => Promise<void>;
  
  // 应用信息
  getVersion: () => Promise<string>;
  getServerPort: () => Promise<number>;
  
  // 文件操作
  openExternal: (url: string) => Promise<void>;
  showItemInFolder: (path: string) => Promise<void>;
  
  // 系统通知
  showNotification: (title: string, body: string) => Promise<void>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
```

### 5.2 配置存储设计

```typescript
// 配置文件位置：
// macOS: ~/Library/Application Support/抖音AI视频/config.json
// Windows: C:\Users\用户名\AppData\Roaming\抖音AI视频\config.json

interface AppConfig {
  storagePath: string;  // 用户数据存储目录
  
  ai: {
    provider: 'deepseek' | 'openai';
    apiKey: string;  // 使用 safeStorage 加密
    model: string;
  };
  
  app: {
    firstRun: boolean;
    theme: 'light' | 'dark' | 'system';
  };
}
```

### 5.3 数据流

**创建任务流程：**

```
1. [React] 用户填写表单，点击"创建任务"
     ↓
2. [React] 调用 fetch(`http://localhost:${port}/api/jobs`)
     ↓
3. [Express] 创建任务，返回任务 ID
     ↓
4. [React] 跳转到任务详情页，开始轮询
     ↓
5. [Express] 后台异步处理：
   - 下载视频
   - 提取音频
   - ASR 转写
   - AI 清洗
   - 生成视频提示词
   - 生成 PPT
     ↓
6. [React] 轮询获取状态更新，显示进度
     ↓
7. [React] 任务完成，显示结果
     ↓
8. [Electron Main] 发送系统通知
```

---

## 6. 前端界面设计

### 6.1 主要页面

#### 首页（创建任务）

```
┌────────────────────────────────────────────┐
│  抖音 AI 视频生成器            [_][□][×]  │
├────────────────────────────────────────────┤
│  [首页] [历史] [设置]                      │
├────────────────────────────────────────────┤
│  ┌──────────────────────────────────────┐ │
│  │      创建新任务                      │ │
│  │                                      │ │
│  │  抖音链接: [___________________]     │ │
│  │  主题:     [AI 技术分享_______]     │ │
│  │  分享文案:                           │ │
│  │  ┌────────────────────────────────┐ │ │
│  │  │ (多行文本框)                   │ │ │
│  │  └────────────────────────────────┘ │ │
│  │                                      │ │
│  │           [创建任务]                 │ │
│  └──────────────────────────────────────┘ │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │      进行中的任务                    │ │
│  │  ┌────────────────────────────────┐ │ │
│  │  │ 任务 #1: AI 技术分享           │ │ │
│  │  │ 状态: 正在下载视频...          │ │ │
│  │  │ [━━━━━━░░░░] 60%             │ │ │
│  │  │                    [查看详情] │ │ │
│  │  └────────────────────────────────┘ │ │
│  └──────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

#### 任务详情页

```
┌────────────────────────────────────────────┐
│  任务详情                      [_][□][×]  │
├────────────────────────────────────────────┤
│  [← 返回] [首页] [历史] [设置]            │
├────────────────────────────────────────────┤
│  任务: AI 技术分享                         │
│  状态: ✅ 已完成                           │
│                                            │
│  ┌─[脚本]─[视频提示词]─[PPT预览]───────┐ │
│  │                                      │ │
│  │  📝 生成的脚本内容                   │ │
│  │                                      │ │
│  │  ## 开场                             │ │
│  │  今天分享一个超实用的 AI 技能...     │ │
│  │                                      │ │
│  │                  [复制] [导出]       │ │
│  └──────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

#### 设置页面

```
┌────────────────────────────────────────────┐
│  设置                          [_][□][×]  │
├────────────────────────────────────────────┤
│  ┌──────────────────────────────────────┐ │
│  │  🔧 基础设置                         │ │
│  │                                      │ │
│  │  数据存储位置:                       │ │
│  │  /Users/xxx/Documents/抖音AI         │ │
│  │                        [选择目录]    │ │
│  └──────────────────────────────────────┘ │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │  🤖 AI 配置                          │ │
│  │                                      │ │
│  │  提供商: [DeepSeek ▼]               │ │
│  │  API Key: [••••••••••]  [显示]      │ │
│  │  模型: [deepseek-chat ▼]            │ │
│  │                                      │ │
│  │                      [测试连接]      │ │
│  └──────────────────────────────────────┘ │
└────────────────────────────────────────────┘
```

### 6.2 UI 组件库

使用 **shadcn/ui**：
- 基于 Tailwind CSS
- 组件现代美观
- 完全可定制
- 打包体积小

---

## 7. 打包和构建

### 7.1 外部依赖下载

**scripts/download-binaries.js**

自动下载以下依赖到 `resources/bin/`：
- ffmpeg (Windows/macOS)
- yt-dlp (Windows/macOS)

**scripts/package-python.js**

打包 Python 环境：
- Windows: Python embeddable + python-pptx
- macOS: 依赖系统 Python 或打包 Python.framework

### 7.2 electron-builder 配置

```yaml
appId: com.douyin.ai-video
productName: 抖音AI视频生成器

files:
  - dist-electron/
  - dist-renderer/
  - dist-backend/
  - node_modules/

extraResources:
  - from: resources/bin
    to: bin
  - from: resources/python
    to: python
  - from: .agents/skills
    to: skills

mac:
  target: [dmg, zip]
  icon: build/icon.icns

win:
  target: [nsis, portable]
  icon: build/icon.ico
```

### 7.3 安装包大小

- **macOS (.dmg)**: ~230MB
  - Electron: 120MB
  - ffmpeg: 60MB
  - yt-dlp: 10MB
  - Python: 30MB
  - 应用代码: 10MB

- **Windows (.exe)**: ~280MB
  - Electron: 140MB
  - ffmpeg: 80MB
  - yt-dlp: 12MB
  - Python: 40MB
  - 应用代码: 10MB

---

## 8. 实施计划

### 阶段 1：基础架构（2-3 天）

**任务：**
- 初始化 Electron 项目
- 配置 TypeScript + Vite + React
- 实现主进程和 preload
- 创建基础窗口

**验收：**
- ✅ `npm run dev` 打开空白窗口
- ✅ React DevTools 可用
- ✅ IPC 通信正常

### 阶段 2：集成后端（1-2 天）

**任务：**
- 在主进程启动 Express
- 配置外部依赖路径
- 修改后端适配 Electron

**验收：**
- ✅ Express 随应用启动
- ✅ 前端可调用后端 API
- ✅ 创建任务功能正常

### 阶段 3：React 前端（3-4 天）

**任务：**
- 集成 shadcn/ui
- 实现所有页面
- 状态管理和 API 客户端

**验收：**
- ✅ 所有页面 UI 完整
- ✅ 任务流程完整
- ✅ 三种输出正常展示

### 阶段 4：配置管理（1 天）

**任务：**
- 首次启动引导
- 配置读写和加密
- 系统通知

**验收：**
- ✅ 首次启动弹出引导
- ✅ 配置持久化
- ✅ API Key 加密存储

### 阶段 5：打包（2-3 天）

**任务：**
- 编写依赖下载脚本
- 配置 electron-builder
- 制作图标
- 测试安装包

**验收：**
- ✅ 生成 macOS .dmg
- ✅ 生成 Windows .exe
- ✅ 安装包可正常运行

### 阶段 6：测试优化（1-2 天）

**任务：**
- 端到端测试
- 错误处理优化
- 性能优化
- 编写文档

**验收：**
- ✅ 完整流程测试通过
- ✅ 应用启动 < 3 秒
- ✅ 用户文档完整

---

## 9. 验收标准

### 9.1 功能完整性

- ✅ 支持抖音链接和分享文案
- ✅ 自动下载视频和转写
- ✅ AI 生成技术分享脚本
- ✅ 生成视频提示词
- ✅ 自动生成 PPT
- ✅ 任务历史管理
- ✅ 应用内配置 API Key

### 9.2 用户体验

- ✅ 安装包双击安装
- ✅ 首次启动引导清晰
- ✅ 界面现代、响应快速
- ✅ 进度反馈实时
- ✅ 错误提示友好

### 9.3 跨平台兼容

- ✅ macOS 10.13+ 正常运行
- ✅ Windows 10/11 正常运行
- ✅ 功能一致

### 9.4 性能要求

- ✅ 应用启动 < 3 秒
- ✅ 任务创建响应 < 0.1 秒
- ✅ UI 流畅不卡顿
- ✅ 内存占用 < 300MB

---

## 10. 风险和应对

### 风险 1：Python 环境打包复杂

**应对：**
- Windows 使用 embeddable 版本
- macOS 依赖系统 Python
- 备选：用 pptxgenjs 替代 python-pptx

### 风险 2：安装包体积过大

**应对：**
- 只打包必要的 ffmpeg 编解码器
- 使用压缩算法优化

### 风险 3：外部依赖下载失败

**应对：**
- 提供国内镜像源
- 构建时预下载并缓存

### 风险 4：兼容性问题

**应对：**
- 在虚拟机中充分测试
- 提供详细错误日志

---

## 11. 技术债务和后续迭代

### 第一版暂不实现

- ❌ 自动更新功能
- ❌ 用户账号系统
- ❌ 云端存储同步
- ❌ 多语言支持
- ❌ 插件系统

### 后续版本可考虑

- 🔮 集成更多视频平台（B站、小红书）
- 🔮 视频直接上传功能
- 🔮 自定义 PPT 模板
- 🔮 AI 视频生成接口对接（Runway、Pika）
- 🔮 批量任务处理

---

## 12. 总结

本设计方案提供了将现有 Web Demo 升级为跨平台桌面应用的完整技术路径：

1. **技术选型明确**：Electron + React + TypeScript
2. **架构设计清晰**：三层架构，职责分离
3. **依赖管理完善**：全部打包，无需用户配置
4. **用户体验优先**：现代界面，友好交互
5. **实施计划具体**：6 个阶段，1-2 周完成
6. **验收标准明确**：功能、性能、兼容性全覆盖

预计开发周期 **1-2 周**，可快速交付给同事/朋友使用。
