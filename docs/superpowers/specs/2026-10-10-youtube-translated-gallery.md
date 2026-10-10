# YouTube 中文译文图集

本文件保留首版规格。默认片段、目标条数和创作容量的后续修复以[完整视频图集修复](2026-10-10-full-video-gallery-design.md)及[自定义目标条数](2026-10-10-gallery-custom-target-design.md)为准：默认全文、支持自定义、创作不限 35 张；发布执行器仍独立校验。

用户已认可单条 YouTube 链接 → 下载与文字 → 中文译文保留原文 → 图集 → 现有发布包方案，书面复核由代理完成。

## 行为
- 复用 yt-dlp 下载公开单条视频；YouTube 跳过抖音解析。人工字幕优先、自动字幕次之、无字幕才用内置 multilingual whisper.cpp（auto）。记录字幕来源/语言，不冒充本地 ASR。不自动读取浏览器登录态。
- 下载字幕故障不丢失已下载视频，明确诊断。JSON3 字幕合法化时间轴与滚动重复；完整原文存储。明确 Node JS runtime 与 FFmpeg 路径。长转录请求不因现有 10 分钟 idle timeout 断开。
- 图集创建允许 mode=translated（YouTube 默认）；已有记录缺省 native。译文模式选开始/结束秒，从转录选完整重叠片段，分批 AI 翻译，原文及时间不变；中文人工编辑后保存。逐批校验 id、数量、非空和截断，失败不覆盖已有译文。
- Gallery.translation 绑定转录哈希和视频指纹，包含 start/end 和 cues（segmentIndex,original,text,start,end）；PATCH 只能改 cues 的 text，不能改服务器维护原文/时间/绑定。源变化必须重新翻译。
- 中文方案逐条取时间点画面并绘制中文（不是原生字幕），按 6～9 条目标与文字容量分图；长文字必须减少条数，超 35 张明确要求缩小片段，不截断。英文仍在工作台对照。
- GalleryImage.translatedCaptions?: string[]；与 times 一一对应，纯文本有长度限制。仅 translated 图集可信译文方案能使用它，不允许 native 手动注入绘制内容。
- GalleryQuote.originalText?、verification=translation；GalleryPlan.mode?，无值 native。当前原生规划/OCR不变。
- 同样逐图预览、人工确认、生成一致哈希、指纹和转录复核，再生成现有发布包；不会自动发布。译文变更使方案和生成引用失效，保留旧产物至成功替换。

## 范围与验证
不做频道批量、私有视频登录、云 ASR、自动发布。无字幕的一小时本地 ASR 依赖硬件，不声称实测通过；不静默截断。真实验收链接 https://www.youtube.com/watch?v=0Z-vhBvBmUY 。隔离存储运行单元/API/真实 FFmpeg + Chromium 图集验收，全量回归、类型/凭据门禁和三套编译。网络或平台封锁单独报告，不假称真实链路通过。

内部复核：复用安全视频快照、版本串行持久化、计划预览哈希与发布修订；翻译原文不可被客户端改写，所有外部文本转义；不新增依赖与凭据。许可使用现有 yt-dlp，参考文档 README 链接。当前实现仅本地分支，远程提交须按 main 约定。
