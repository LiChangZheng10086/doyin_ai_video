# 原生字幕候选：本地 OCR 验证

项目：`/Users/mac/workspace/ai/claude/douyin`。本机验收未修改 Issues，未写真实用户存储，视频及转录文字不进入代码仓库。

## 根因与改动

旧规则偏好最底部的稳定亮色边缘，新闻横幅可被当作字幕；无标点 ASR 被合并成约十秒窗口后只采三帧，易跨字幕切换。macOS 现用 Apple Vision 本地中文 OCR，采七帧、保留细字并按转录字符顺序、位置、尺寸筛选。识别只处理下半幅，避免完整背景识别首帧超过 30 秒；失败明确返回错误。无标点合并窗口限制为 4 秒。

OCR 不是原话证明：输出图片仍裁原像素，人工确认保留；错字、台词与画面不同步或未匹配文字明确排除。未提供 OCR 的平台保留旧像素候选并警告，统一校准和高级调整保留。没有付费接口或上传视频。

## 同源对比

1680×720、202.64093 秒原文件 SHA256：`be31496df8e405ad73dc956e9c503e65bfd6a931f110ee152958ab08d227ce91`。固定六窗口及人工标签在 `fixtures/native-subtitles-2026-10-09.json`，标注依据是本机实际画面人工核对。视频和转录文字均不入库、不推送；复核脚本在运行时读取本地转录文件。

| 窗口 | 像素基线 | OCR | 人工预期 |
| --- | --- | --- | --- |
| 开场执行计划 | 排除 | 接受 | 对白 |
| 早期牺牲的伙伴 | 排除 | 接受 | 对白 |
| 运动背景信息茧房 | 排除 | 接受 | 对白 |
| 群众外星人欺骗民众 | 接受 | 接受 | 对白 |
| 新闻标题栏 | 接受 | 排除 | 横幅 |
| 记者画面的新闻栏 | 接受 | 排除 | 横幅 |

六窗口：基线 1 个正确接受、2 个误选、3 个漏检；新规则 4 个正确接受、0 个误选、0 个漏检。是这六个窗口的候选选择结果，不能外推全片、其它视频或逐字语义准确率。同一原规划 15 窗口整体仍是 8 个接受：接受数量未增加，但候选集合改变。其它窗口存在 ASR 偏差而被排除，完整台词覆盖尚未标注验收。

## 复现

```sh
npm run prepare:subtitle-ocr
node --import tsx scripts/verify-native-subtitles.ts --video='/path/to/annotated-source.mp4' --transcript='/path/to/local-transcript.json' --output=/tmp/native-subtitle-report.json
node --import tsx --test src/lib/subtitle-ocr.test.ts src/lib/gallery-planner.test.ts src/lib/gallery-media.test.ts
node --import tsx --test src/lib/galleries.test.ts src/lib/gallery-routes.test.ts
node --import tsx scripts/verify-subtitle-gallery.ts
npm run check:backend
```

固定真实回归 6/6 通过；字符/空白/多行/长句/切换与真实 FFmpeg 专项 13/13 通过；图集服务和 HTTP 7/7 通过；合成 32 段到四张整套预览、确认渲染、发布预览及重转录失效通过。合成栅格测试只证流程，不能证明 OCR 语义。桥接器构建需 macOS Swift 工具链，Mac 打包自动编译并携带程序，用户无需 Swift。未重打包安装器；Windows OCR 未实现。

已比较本机 Tesseract 中文模型，在该运动背景上识别不稳定，未采用。接口参考 [Tesseract 官方 CLI](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)、[Apple Vision](https://developer.apple.com/documentation/vision/vnrecognizetextrequest)。
