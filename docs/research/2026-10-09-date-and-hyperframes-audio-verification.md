# 创建日期筛选与本地中文成片音频验收

对应 Issues #7、#6；#12 证据另见 `2026-10-09-native-subtitle-ocr-verification.md`。实现顺序为日期筛选 → 原生字幕候选 → 成片音频；本机用户已有数据未修改。

## #7 创建日期范围

确认搜索、状态与空状态已有实现，只补创建日期起止输入、清除与错误提示。按浏览器本地日历日期比较：开始当天零点包含，结束的下一天本地零点排除，避免用固定 24 小时跨越夏令时。非法日期、起止反向给出明确提示；日期启用时未知创建时间不混入结果。搜索、状态、日期同时生效，清空筛选同步重置所有条件，列表与卡片共用规则。

日期专项在 UTC、Asia/Shanghai、America/New_York 各 8/8 通过，含单边筛选、零点/日末、非法日历日期、反向区间、搜索+状态和夏令时边界。工具栏与列表展示 15/15 通过。系统 Google Chrome 隔离 API/UI 验收同日 00:00 与 23:59:59.999、相邻日排除、状态+搜索+日期组合、空状态清空、反向提示、卡片与 760px 窗口无水平溢出。活动作品条继续独立展示当前作品，筛选作用于作品列表。

## #6 本地配音、字幕、混音

工作台「成片配音与音乐」提供可选中文配音、已安装系统语音、速度、本机音频素材与音量；选项随任务保存，失败重试保留，可明确重新生成已完成视频。正在执行的步骤仍互斥。失败保留旧脚本及旧成片；没有请求音频时保持原有无声输出。

macOS `/usr/bin/say` 离线合成每个镜头的完整 narration，按标点及长度分段；每段 FFprobe 实测时长决定字幕起止与 SRT，分镜前后各预留约 0.3 秒。长口播最多加速到 1.35 倍，仍放不下则明确报错，不截断。这里是分段字幕同步，不是逐字强制对齐。

背景音乐只读取素材库中的音频安全快照，拒绝已删除、错类型、越界软链接或读取时改变的文件。音频输入仅允许本地协议；循环短音乐、淡入淡出、口播时 sidechain 压低背景、限制峰值。产出 `assets/audio/mix.wav`、`audio-manifest.json`、`subtitles.srt`，HyperFrames 预览使用同一混音文件。最终 FFmpeg 明确映射画面和混音，AAC 后再验证，避免渲染器音频失败却交付无声成功。

第一次真实成片验收发现 HyperFrames 0.7.108 使用旧 `-filter_complex_script`，本机 FFmpeg 报 `Unrecognized option 'filter_complex_script'`，CLI 仍输出无声视频。增加明确音轨封装后重新验收成功，没有更新固定 CLI 版本或修改 vendor。

## 验证证据

- 实际 HyperFrames：lint → validate → inspect → 多镜头 snapshot → render → 音轨封装 → FFprobe 验收，1/1 通过。8 分镜总长 52 秒，1080×1920、H.264、30fps；AAC 音轨与画面时长差小于 0.1 秒；17 条字幕完整覆盖测试口播文本，片内声样 RMS 0.08228555；实际帧人工核对字幕在对应口播时出现，在间隙消失。
- FFmpeg 音频测试：口播220Hz、音乐880Hz测试信号验证口播可听、压低音乐、短音频全长循环、仅音乐、无声、超长口播拒绝及安全读取。任务测试验证配置保存、重试、已完成步骤显式重生成、失败旧产物保留、并发拦截。音频+任务 39/39，封装修复后相关 48/48 通过。
- Chrome `scripts/verify-job-date-audio.ts`：上述日期场景、实际系统语音选项、速度/音乐选择、真实 HTTP 音频请求与持久化/重载、非法配置400、重新生成入口，9组通过，pageerror为0。生成故障恢复使用明确不存在CLI的隔离测试配置；实际有声渲染由上一项独立测试覆盖。
- 最终全量：1214项，1213通过、0失败、1跳过（默认跳过的真实HyperFrames另行启用并通过）。并发限定4，耗时约229秒。
- `npm run check`：后端和渲染层类型检查、凭据扫描通过；`npm run build`：前端、Electron、后端编译通过。Vite 仍有既存超过500kB的bundle提示；没有独立npm lint命令，HyperFrames lint和`git diff --check`通过。

```sh
node --import tsx scripts/verify-job-date-audio.ts  # 先 npm run build:renderer；可用 QA_BROWSER_BINARY 指定本机浏览器
npm run test:hyperframes                       # 可用 HYPERFRAMES_CLI_PATH / HYPERFRAMES_BROWSER_PATH 指定已有本地运行时
node --import tsx --test --test-concurrency=4 "src/**/*.test.ts" "electron/**/*.test.ts" "renderer/src/**/*.test.ts" "renderer/src/**/*.test.tsx"
npm run check
npm run build
```

## 尚有限制

中文 TTS 目前只支持 macOS 已安装系统语音；Windows/Linux 能用背景音乐但未接中文TTS。未重打包或安装桌面安装器，也未对其它操作系统实测。没有付费服务、新凭据或素材上传；真实素材、转录文字和生成测试成片不进Git。#12的六窗口改善不能外推全片语义准确率，仍需人工确认字幕。
