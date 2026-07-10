# 抖音 AI 视频助手 — 当前项目方案

## 项目定位

输入抖音视频链接或分享文本，按手动步骤完成视频转录、AI 洗稿、视频提示词生成，并通过 HyperFrames 在本地渲染 9:16 竖屏 MP4。

## 主链路

```text
创建任务
  ↓
视频转录（下载视频 + 提取音频 + ASR）
  ↓
AI 洗稿
  ↓
生成视频提示词
  ↓
HyperFrames 本地生成视频
```

每一步都由用户手动触发。单步执行时后端自动最多重试 3 次，失败后停在该步骤，用户可以手动重试。

## 当前实现

- 桌面端：Electron + React + Vite。
- 后端：Node.js + Express + TypeScript。
- 下载与处理：`yt-dlp`、`ffmpeg`、`ffprobe`。
- ASR：OpenAI Whisper API、本地 faster-whisper、本地 FunASR。
- 洗稿：OpenAI-compatible Chat Completions，优先使用视频转录文本。
- 视频提示词：基于清洗稿、视频大纲、核心要点和口播稿本地生成场景提示词。
- 视频生成：HyperFrames CLI 本地渲染 HTML/CSS/GSAP 到 MP4。

## 输出产物

```text
~/Documents/抖音AI视频/
├── raw/
│   ├── videos/
│   ├── audio/
│   ├── transcripts/
│   ├── page/
│   └── text/
├── processed/
│   ├── scripts/
│   ├── cleaned/
│   ├── scenes/
│   └── subtitles/
├── output/
│   └── videos/
└── logs/
```

## 后续方向

- 优化 FunASR 和本地 Whisper 安装体验。
- 增加视频样式模板和镜头节奏配置。
- 增加可选 TTS 配音和 BGM。
- 增加批量任务与导出能力。
