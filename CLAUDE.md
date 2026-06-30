# 抖音 AI 视频助手

一个基于 Electron + React 的桌面应用，用于从抖音视频链接或分享文本生成 AI 洗稿内容、视频提示词和 PPT。

## 项目架构

```
douyin/
├── src/                      # 后端服务（Node.js + Express）
│   ├── app.ts               # Express 应用配置
│   ├── server.ts            # HTTP 服务器入口
│   ├── lib/                 # 核心业务逻辑
│   │   ├── jobs.ts          # 任务管理器
│   │   ├── cleaner.ts       # 内容清洗
│   │   ├── storage.ts       # 文件存储
│   │   ├── media.ts         # 视频/音频处理
│   │   └── asr.ts           # 语音识别（ASR）
│   └── types.ts             # TypeScript 类型定义
│
├── renderer/                 # 前端界面（React + Vite）
│   ├── src/
│   │   ├── main.tsx         # React 入口
│   │   ├── App.tsx          # 应用路由
│   │   ├── pages/           # 页面组件
│   │   │   ├── HomePage.tsx        # 首页（任务列表）
│   │   │   ├── JobDetailPage.tsx   # 任务详情
│   │   │   └── SettingsPage.tsx    # 设置页面
│   │   ├── components/      # 通用组件
│   │   │   ├── Layout.tsx
│   │   │   ├── JobCard.tsx
│   │   │   └── CreateJobDialog.tsx
│   │   ├── services/        # API 服务层
│   │   │   └── api.ts
│   │   ├── store/           # 状态管理（Zustand）
│   │   │   └── useAppStore.ts
│   │   └── types/           # 前端类型定义
│   │       └── index.ts
│   └── vite.config.ts
│
├── electron/                 # Electron 主进程
│   └── main.ts              # 主进程入口
│
└── dist/                     # 编译输出
    ├── server.js            # 后端编译产物
    └── renderer/            # 前端编译产物
```

## 技术栈

### 后端
- **运行时**: Node.js 18+
- **框架**: Express 4
- **语言**: TypeScript
- **依赖**:
  - `axios` - HTTP 客户端
  - `openai` - OpenAI API SDK（用于 AI 和 ASR）
  - `yt-dlp` - 视频下载（外部二进制）
  - `ffmpeg` - 音视频处理（外部二进制）

### 前端
- **框架**: React 19
- **构建工具**: Vite 6
- **路由**: React Router DOM 7
- **状态管理**: Zustand 5
- **样式**: Tailwind CSS（自定义设计系统）
- **HTTP 客户端**: Axios

### 桌面端
- **框架**: Electron 34
- **构建工具**: electron-builder

## 核心功能流程

### 1. 任务创建与处理

```
用户输入（URL 或分享文本）
    ↓
前端 → POST /api/jobs → 后端
    ↓
任务队列（Jobs Manager）
    ↓
处理流程：
    1. 下载视频（yt-dlp）
    2. 提取音频（ffmpeg）
    3. 语音转录（Whisper API，可选）
    4. 内容清洗（AI 洗稿）
    5. 生成视频提示词（AI）
    6. 生成 PPT 内容（AI，可选）
    ↓
存储结果到文件系统
    ↓
前端轮询 → GET /api/jobs/:id → 获取状态更新
```

### 2. 数据存储结构

所有数据存储在：`~/Documents/抖音AI视频/`

```
抖音AI视频/
├── raw/                      # 原始数据
│   ├── videos/              # 下载的视频文件
│   ├── audio/               # 提取的音频文件
│   ├── transcripts/         # 转录文本（JSON）
│   ├── page/                # 页面元数据
│   └── text/                # 分享文本
│
├── processed/               # 处理后的数据
│   ├── scripts/             # 脚本资产（JSON）
│   ├── cleaned/             # 清洗后的内容（JSON）
│   ├── scenes/              # 场景数据
│   └── subtitles/           # 字幕文件
│
├── output/                  # 输出产物
│   └── ppt/                 # 生成的 PPT 文件
│
└── logs/                    # 日志文件
```

### 3. 任务状态流转

```
queued          # 排队中
    ↓
processing      # 处理中
    ↓ (各个阶段)
    - downloading        # 下载视频
    - extracting        # 提取音频
    - transcribing      # 语音转录
    - cleaning          # 内容清洗
    - generating-video-prompts  # 生成视频提示词
    - generating-ppt    # 生成 PPT
    ↓
done / failed   # 完成 / 失败
```

## API 接口

### 任务管理
- `POST /api/jobs` - 创建任务
- `GET /api/jobs` - 获取任务列表
- `GET /api/jobs/:id` - 获取任务详情

### 内容获取
- `GET /api/jobs/:id/script` - 获取脚本资产
- `GET /api/jobs/:id/cleaned` - 获取清洗后的内容
- `GET /api/jobs/:id/raw-transcript` - 获取原始转录
- `GET /api/jobs/:id/video-prompts` - 获取视频提示词
- `GET /api/jobs/:id/ppt-content` - 获取 PPT 内容
- `GET /api/jobs/:id/download-ppt` - 下载 PPT 文件

## 数据类型定义

### Job（任务）
```typescript
{
  id: string;
  sourceUrl?: string;        // 视频链接
  shareText?: string;        // 分享文本
  topic?: string;            // 主题
  status: 'queued' | 'processing' | 'done' | 'failed';
  stage: JobStage;           // 当前处理阶段
  progress?: number;         // 进度百分比
  error?: string;            // 错误信息
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  storagePath?: string;      // 存储路径
}
```

### CleanedScript（清洗后的内容）
```typescript
{
  jobId: string;
  sourceUrl: string;
  topic?: string;
  transcriptText?: string;   // 转录文本（从 raw-transcript）
  output: {
    title: string;           // 标题
    rawText: string;         // 原始文本（分享文本）
    cleanScript: string;     // 清洗后的脚本
    tags: string[];          // 标签
    videoPrompts: string[];  // 视频提示词数组
    pptContent?: any;        // PPT 内容
    enhancedScenes?: any[];  // 增强场景
    voiceoverScript?: string;// 配音脚本
  };
}
```

## 配置管理

配置文件位置：`~/.douyin-ai-video/config.json`

### AI 配置
```json
{
  "aiKeys": [
    {
      "id": "uuid",
      "name": "DeepSeek",
      "provider": "deepseek",
      "apiKey": "sk-...",
      "baseURL": "https://api.deepseek.com",
      "model": "deepseek-chat",
      "isActive": true
    }
  ]
}
```

### ASR（语音识别）配置
```json
{
  "asrProvider": "openai",
  "asrApiKey": "sk-...",
  "asrBaseURL": "https://api.openai.com/v1",
  "asrModel": "whisper-1"
}
```

## 开发规范

### 1. 代码风格
- 使用 TypeScript 严格模式
- 遵循 ESLint 规则
- 使用 2 空格缩进
- 优先使用函数式组件（React）

### 2. 提交规范
遵循 Conventional Commits：
- `feat:` - 新功能
- `fix:` - Bug 修复
- `refactor:` - 重构
- `docs:` - 文档更新
- `style:` - 代码格式调整
- `test:` - 测试相关

### 3. 类型安全
- 前后端共享类型定义在 `src/types.ts`
- 前端有独立的扩展类型在 `renderer/src/types/index.ts`
- API 响应必须有明确的类型定义

### 4. 错误处理
- 后端：统一返回 `{ message: string }` 错误格式
- 前端：显示用户友好的错误提示
- 区分"加载失败"和"内容不存在"

## 构建与运行

### 开发模式
```bash
# 安装依赖
npm install

# 启动后端服务（监听 59380 端口）
npm run dev:server

# 启动前端开发服务器
npm run dev:renderer

# 启动 Electron
npm run dev:electron
```

### 生产构建
```bash
# 构建后端
npm run build:server

# 构建前端
npm run build:renderer

# 打包 Electron 应用
npm run package        # 当前平台
npm run package:mac    # macOS
npm run package:win    # Windows
```

### 类型检查
```bash
npm run check
```

## 关键注意事项

### 1. 数据来源区分
- **视频转录**：从视频音频提取的真实内容（需要配置 ASR）
- **分享文本**：用户输入的分享文本（后备方案）
- 前端必须清晰区分这两种数据来源

### 2. 状态类型一致性
- 前后端统一使用 `'done'` 表示完成状态（不是 `'completed'`）
- JobStage 的 `'done'` 和 JobStatus 的 `'done'` 是不同的概念

### 3. 内容加载策略
- 优先加载 `cleaned` 数据（包含所有处理结果）
- `script` 数据已废弃，不再使用
- 转录文本通过专用端点 `/raw-transcript` 获取

### 4. UI/UX 原则
- 明确区分"未配置"、"加载失败"、"内容不存在"三种状态
- 错误提示要包含解决方案或后续步骤
- 避免截断内容显示（移除不必要的 max-height）

## 已知问题与改进方向

### 待优化
1. PPT 生成功能尚未完全实现
2. 本地 Whisper 支持需要进一步测试
3. 任务队列没有持久化（重启后丢失）
4. 缺少任务重试机制

### 计划功能
1. 批量导入任务
2. 导出为 Markdown/Word
3. 自定义 AI 提示词模板
4. 任务历史记录搜索

## 故障排查

### 转录功能不工作
1. 检查 ASR 配置是否正确（设置页面）
2. 验证 API Key 是否有效
3. 查看 `raw/transcripts/` 目录是否生成文件
4. 检查后端日志中的错误信息

### 视频下载失败
1. 确认 yt-dlp 二进制文件存在
2. 检查网络连接和代理设置
3. 验证抖音链接格式是否正确
4. 查看 cookies 配置（可能需要登录态）

### 前端无法连接后端
1. 确认后端服务运行在端口 59380
2. 检查防火墙设置
3. 验证 `window.electron.getServerPort()` 返回正确端口

---

**最后更新**: 2026-06-30  
**维护者**: Claude Code  
**仓库**: https://github.com/LiChangZheng10086/doyin_ai_video.git
