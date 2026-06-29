# 🎬 抖音 AI 视频脚本生成器

> 输入抖音分享链接或文案，自动生成技术分享脚本、AI 视频提示词和配套 PPT

一个完整的 AI 驱动的抖音视频内容处理工具，支持视频下载、音频转写、AI 内容清洗、视频场景增强和 PPT 自动生成。

## ✨ 核心功能

### 三重输出

| 输入 | 输出 1 | 输出 2 | 输出 3 |
|------|--------|--------|--------|
| 🔗 抖音分享链接 | 📝 结构化技术脚本 | 🎬 电影级视频提示词 | 📊 配套演示 PPT |
| 📱 分享文案 | （清洗后的内容） | （可对接 AI 视频生成） | （8-12 页幻灯片） |

### 功能亮点

- ✅ **视频下载** - 支持抖音链接解析和视频下载（yt-dlp + 页面直链）
- ✅ **音频转写** - 使用 Whisper/ASR 将视频转为文字
- ✅ **AI 清洗** - DeepSeek/OpenAI 智能清洗，提取技术要点
- ✅ **视频增强** - 为每个场景生成电影级 AI 视频提示词（相机运动、光照、特效）
- ✅ **PPT 生成** - 自动生成 8-12 页结构化演示文稿（tech/academic/corporate 风格）
- ✅ **实时反馈** - 任务进度实时更新，详细展示每个处理阶段


## 🏗️ 技术架构

```
用户输入（抖音链接 / 分享文案）
    │
    ▼
解析层 · 提取信息
  - 解析分享文案
  - 提取视频链接和主题
    │
    ▼
下载层 · 视频获取
  - yt-dlp 下载抖音视频
  - 页面直链提取（备用）
    │
    ▼
转写层 · 音频处理
  - ffmpeg 提取音频
  - Whisper ASR 转文字
    │
    ▼
AI 清洗层 · 内容优化
  - DeepSeek/OpenAI 清洗
  - 提取技术要点、案例、金句
    │
    ▼
双路增强（并行处理）
  ├─► 视频增强器                  ├─► PPT 生成器
  │   - video-master skill        │   - ppt-generator-skill
  │   - 生成电影级视频提示词       │   - 自动推荐风格
  │   - 相机运动、光照、特效       │   - 生成 8-12 页结构
  │   - 支持 DeepSeek/OpenAI      │   - Python-pptx 渲染
  │                                │
  └────────────┬──────────────────┘
               ▼
        三重输出完成
  📝 脚本 + 🎬 视频提示词 + 📊 PPT
```

### 任务状态流转

```
submitted → parsed → downloading → downloaded → audio_extracted 
→ transcribing → cleaned → scripted → done
                                           ↓
                                        failed
```

## 🛠️ 技术栈

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js 18+ |
| 语言 | TypeScript 5.x |
| 后端框架 | Express.js |
| 视频下载 | yt-dlp |
| 音视频处理 | ffmpeg |
| ASR 转写 | Whisper / 其他 ASR 服务 |
| AI 模型 | DeepSeek / OpenAI (gpt-4o-mini) |
| PPT 生成 | Python 3.13 + python-pptx |
| 前端 | 原生 HTML/CSS/JavaScript |
| Skills 集成 | video-master, ppt-generator-skill |
| 存储 | 本地文件系统（JSON 索引） |

### 核心依赖

```json
{
  "express": "Express 服务器",
  "tsx": "TypeScript 运行时",
  "openai": "AI SDK（兼容 DeepSeek）",
  "zod": "类型验证",
  "yt-dlp": "视频下载"
}
```

## 🚀 快速开始

### 前置条件

- **Node.js** 18+ 
- **Python** 3.13+（用于 PPT 生成）
- **ffmpeg**（音视频处理）
- **yt-dlp**（视频下载）
- **DeepSeek API Key** 或 **OpenAI API Key**

### 1️⃣ 安装依赖

```bash
# 克隆项目
git clone https://github.com/LiChangZheng10086/doyin_ai_video.git
cd doyin_ai_video

# 安装 Node.js 依赖
npm install

# 安装 Python 依赖（PPT 生成）
pip3 install python-pptx
```

### 2️⃣ 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入必要配置：

```bash
# AI 配置（必填）
AI_PROVIDER=deepseek          # 或 openai
AI_MODEL=deepseek-chat        # 或 gpt-4o-mini
DEEPSEEK_API_KEY=your_key     # DeepSeek API Key
# OPENAI_API_KEY=your_key     # 或使用 OpenAI

# 服务配置
PORT=3100
HOST=0.0.0.0

# 可选：ASR 转写服务
# OPENAI_API_KEY_FOR_WHISPER=your_key
```

### 3️⃣ 安装系统工具

**macOS:**
```bash
brew install ffmpeg yt-dlp python@3.13
```

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install ffmpeg python3-pip
sudo pip3 install yt-dlp
```

### 4️⃣ 启动服务

```bash
npm run dev
```

服务启动后访问：**http://localhost:3100**

## 📖 使用指南

### 创建任务

1. 打开浏览器访问 `http://localhost:3100`
2. 在「创建任务」区域：
   - **抖音链接**（可选）：粘贴抖音分享链接
   - **主题**：输入视频主题（如"AI 技术分享"）
   - **分享文案**：粘贴抖音分享的完整文案
3. 点击「创建任务」

### 查看进度

任务创建后会实时显示处理进度：

- 📡 **正在提交任务** 
- ✅ **任务已创建**
- ⬇️ **正在下载视频**
- 🎵 **音频提取完成**
- 🎤 **正在转写语音**
- 🤖 **AI 正在清洗内容**
- 🎉 **任务完成！**

### 查看结果

任务完成后，点击右侧任务详情，查看：

- **📝 脚本** - AI 清洗后的结构化内容
- **🎬 视频提示词** - 每个场景的电影级描述
- **📊 PPT预览** - 自动生成的演示文稿
- **💾 下载 PPT** - 下载 PPTX 文件

## 📂 项目结构

## 📂 项目结构

```
doyin_ai_video/
├── src/                           # TypeScript 源码
│   ├── server.ts                  # Express 服务器入口
│   ├── types.ts                   # 类型定义
│   └── lib/
│       ├── jobs.ts                # 任务管理（异步处理）
│       ├── ai-cleaner.ts          # AI 内容清洗
│       ├── video-enhancer.ts      # 视频场景增强
│       ├── ppt-generator.ts       # PPT 自动生成
│       ├── media.ts               # 视频下载和音频处理
│       ├── asr.ts                 # ASR 转写
│       ├── douyin.ts              # 抖音链接解析
│       ├── douyin-page.ts         # 页面信息提取
│       ├── storage.ts             # 本地存储
│       └── script-builder.ts      # 脚本构建
│
├── public/                        # 前端静态资源
│   └── index.html                 # 单页面应用
│
├── .agents/skills/                # AI Skills
│   ├── video-master/              # 视频场景增强 skill
│   └── ppt-generator-skill/       # PPT 生成 skill
│       ├── scripts/
│       │   └── generate_styled_ppt.py  # Python PPT 渲染脚本
│       ├── styles/                # PPT 样式配置
│       └── templates/             # 提示词模板
│
├── storage/                       # 运行时数据（gitignored）
│   ├── raw/                       # 原始数据
│   │   ├── videos/                # 下载的视频
│   │   ├── audio/                 # 提取的音频
│   │   ├── transcripts/           # ASR 转写结果
│   │   ├── text/                  # 解析的文案
│   │   └── page/                  # 页面信息
│   ├── processed/                 # 处理后数据
│   │   ├── scripts/               # 生成的脚本
│   │   └── cleaned/               # AI 清洗结果
│   └── output/                    # 最终输出
│       └── ppt/                   # 生成的 PPT 文件
│
├── docs/                          # 项目文档
│   ├── technical-plan.md          # 技术方案
│   ├── startup-checklist.md       # 启动检查清单
│   └── worklog.md                 # 开发日志
│
├── .env.example                   # 环境变量模板
├── package.json                   # Node.js 依赖
├── tsconfig.json                  # TypeScript 配置
└── README.md                      # 项目说明
```

## 🌐 API 接口

### 任务管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/jobs` | 创建任务 |
| `GET` | `/api/jobs/:id` | 获取任务详情 |
| `GET` | `/api/jobs/:id/video-prompts` | 获取视频提示词 |
| `GET` | `/api/jobs/:id/ppt-content` | 获取 PPT 内容 |
| `GET` | `/api/jobs/:id/ppt/download` | 下载 PPTX 文件 |
| `GET` | `/health` | 健康检查 |

### 请求示例

**创建任务：**

```bash
curl -X POST http://localhost:3100/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "sourceUrl": "https://v.douyin.com/MtrrFe2Vtyo/",
    "topic": "AI 技术分享",
    "shareText": "这是抖音分享文案..."
  }'
```

**响应：**

```json
{
  "job": {
    "id": "325a7255-9016-4ae2-9081-0c5efcd52f06",
    "status": "queued",
    "stage": "submitted",
    "sourceUrl": "https://v.douyin.com/MtrrFe2Vtyo/",
    "topic": "AI 技术分享",
    "createdAt": "2026-06-29T13:52:00.000Z",
    "updatedAt": "2026-06-29T13:52:00.000Z"
  }
}
```

**查询任务状态：**

```bash
curl http://localhost:3100/api/jobs/325a7255-9016-4ae2-9081-0c5efcd52f06
```

**获取视频提示词：**

```bash
curl http://localhost:3100/api/jobs/325a7255-9016-4ae2-9081-0c5efcd52f06/video-prompts
```

**下载 PPT：**

```bash
curl -o output.pptx http://localhost:3100/api/jobs/325a7255-9016-4ae2-9081-0c5efcd52f06/ppt/download
```

## ⚙️ 配置说明

### 环境变量

| 变量 | 说明 | 默认值 | 必填 |
|------|------|--------|------|
| `AI_PROVIDER` | AI 提供商 (`deepseek` / `openai`) | `deepseek` | ✅ |
| `AI_MODEL` | AI 模型名称 | `deepseek-chat` | ✅ |
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | - | ⚠️ |
| `OPENAI_API_KEY` | OpenAI API 密钥 | - | ⚠️ |
| `OPENAI_API_KEY_FOR_WHISPER` | Whisper ASR 密钥 | - | ❌ |
| `PORT` | 服务端口 | `3100` | ❌ |
| `HOST` | 服务地址 | `0.0.0.0` | ❌ |

⚠️ `DEEPSEEK_API_KEY` 和 `OPENAI_API_KEY` 至少配置一个

### PPT 样式配置

PPT 生成器支持 7 种视觉风格：

| 风格 | 说明 | 适用场景 |
|------|------|----------|
| `tech` | 科技蓝 | 技术分享、产品发布 |
| `academic` | 学术风 | 论文报告、学术演讲 |
| `corporate` | 商务风 | 企业汇报、商业提案 |
| `lego` | 乐高风 | 创意展示、趣味分享 |
| `pop` | 波普风 | 时尚潮流、年轻化内容 |
| `clay` | 黏土风 | 温馨可爱、教育内容 |
| `bw` | 黑白风 | 极简主义、艺术展示 |

系统会根据内容主题自动推荐最合适的风格。

## 🎯 核心特性详解

### 1. 视频场景增强

使用 `video-master` skill 为每个场景生成电影级 AI 视频提示词：

**输入场景：**
```
场景1: 标题出现 - "Anthropic 官方出品 Skills 技能包"
```

**输出提示词（中文）：**
```
【相机运动】：缓慢推进（慢速Dolly In），从略广的构图逐渐推近至标题文字
的特写，镜头带有轻微呼吸感的平滑稳定运动...

【动作效果】：文字分层浮现动画，第一行标题"Anthropic 官方出品"以淡入
方式从虚到实显现...

【光照风格】：冷色调主光（色温约5500K），模拟屏幕反射光...
```

**输出提示词（英文）：**
```
Cinematic opening title card for a tech keynote, 4 seconds duration. 
An abstract, dark technological background with deep navy blue and 
charcoal gradients, subtle flowing digital particles...
8k resolution, hyper-realistic render, sci-fi elegance aesthetic
```

### 2. PPT 自动生成

使用 `ppt-generator-skill` 将脚本转换为演示文稿：

**生成流程：**
1. 分析脚本内容和主题
2. 自动推荐最合适的视觉风格
3. 生成 8-12 页结构化内容
4. 调用 Python 脚本渲染 PPTX 文件

**PPT 结构：**
- 封面页（标题 + 副标题）
- 目录页（3-4 个章节）
- 内容页（每个章节 2-3 页）
- 总结页
- 行动建议页

每页包含：
- 标题
- 要点列表
- 演讲备注（80-150 字）
- 配图提示词

### 3. 异步任务处理

任务创建后立即返回（0.02 秒），后台异步处理：

```typescript
// 立即返回任务记录
const record = await jobs.create({ sourceUrl, shareText, topic });
res.json({ job: record });  // 秒级响应

// 后台异步处理
processJob(record.id).catch(handleError);
```

前端通过轮询获取实时进度：

```javascript
setInterval(() => {
  fetch(`/api/jobs/${jobId}`)
    .then(res => res.json())
    .then(data => updateUI(data.job.stage));
}, 1000);
```

## 🔧 开发指南

### 本地开发

```bash
# 开发模式（热重载）
npm run dev

# 编译 TypeScript
npm run build

# 生产模式
npm start
```

### 添加新的 AI Skill

1. 在 `.agents/skills/` 目录下创建新 skill
2. 编写 `SKILL.md` 描述 skill 功能
3. 在 `src/lib/` 中创建对应的集成模块
4. 在 `src/lib/jobs.ts` 的 `processJob` 中调用

### 调试技巧

**查看任务详情：**
```bash
cat storage/jobs.json | jq '.["任务ID"]'
```

**查看生成的脚本：**
```bash
cat storage/processed/scripts/任务ID.json | jq
```

**测试 Python PPT 脚本：**
```bash
python3 .agents/skills/ppt-generator-skill/scripts/generate_styled_ppt.py \
  --input storage/output/ppt/test.json \
  --output test.pptx
```

## 🐛 常见问题

### 1. 视频下载失败

**原因：** yt-dlp 版本过旧或抖音链接失效

**解决：**
```bash
# 更新 yt-dlp
pip3 install --upgrade yt-dlp

# 或使用备用方案：直接提供分享文案
```

### 2. ASR 转写失败

**原因：** 未配置 Whisper API Key 或音频质量差

**解决：**
```bash
# 配置 OpenAI API Key 用于 Whisper
export OPENAI_API_KEY_FOR_WHISPER=your_key

# 或跳过视频下载，直接使用分享文案
```

### 3. PPT 文件未生成

**原因：** Python 脚本调用失败或 python-pptx 未安装

**解决：**
```bash
# 安装 python-pptx
pip3 install python-pptx

# 手动测试脚本
python3 .agents/skills/ppt-generator-skill/scripts/generate_styled_ppt.py --help
```

### 4. AI 响应超时

**原因：** API 请求过慢或网络问题

**解决：**
```bash
# 切换到更快的 AI 提供商
AI_PROVIDER=openai
AI_MODEL=gpt-4o-mini

# 或增加超时时间（修改代码）
```

## 📊 性能指标

| 指标 | 数值 |
|------|------|
| 任务创建响应时间 | < 0.05 秒 |
| 视频下载（10MB） | 5-15 秒 |
| ASR 转写（5分钟音频） | 10-30 秒 |
| AI 清洗 | 5-15 秒 |
| 视频提示词生成 | 10-20 秒 |
| PPT 生成 | 5-10 秒 |
| **总耗时（完整流程）** | **1-2 分钟** |

## 🗺️ Roadmap

### v1.1（计划中）

- [ ] 支持批量任务处理
- [ ] 视频直接上传功能
- [ ] 更多视频平台（B站、小红书）
- [ ] 自定义 PPT 模板
- [ ] AI 视频生成接口对接（Runway、Pika）

### v1.2（规划中）

- [ ] 任务队列和并发控制
- [ ] Redis 缓存层
- [ ] PostgreSQL 数据库
- [ ] 用户认证和权限管理
- [ ] Docker 镜像发布

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/AmazingFeature`
3. 提交更改：`git commit -m 'Add some AmazingFeature'`
4. 推送到分支：`git push origin feature/AmazingFeature`
5. 提交 Pull Request

## 📄 开源协议

本项目采用 MIT 协议开源。详见 [LICENSE](LICENSE) 文件。

## 🙏 致谢

- [Claude Code](https://claude.ai/code) - AI 辅助开发
- [video-master skill](https://github.com/anthropics/claude-skills) - 视频场景增强
- [ppt-generator-skill](https://github.com/anthropics/claude-skills) - PPT 自动生成
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - 视频下载
- [python-pptx](https://python-pptx.readthedocs.io/) - PPT 生成

---

**Made with ❤️ by Claude Opus 4.8**

如有问题或建议，欢迎提交 [Issue](https://github.com/LiChangZheng10086/doyin_ai_video/issues) 💬
