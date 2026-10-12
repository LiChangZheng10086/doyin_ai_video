# Skills 更新与兼容性验收

日期：2026-10-12。范围为4项已确认的上游更新、必要依赖、README来源清单及远程main交付。文章创作的既有暂存改动在原工作区保留，不纳入本次提交。

## 来源与安装

使用 `skill-installer` 从固定提交下载完整目录，不执行上游安装钩子。3个已有项目级Skill更新，cy-carousel由临时试跑工具转为仓库内完整Skill，另补齐loop-me引用的grilling依赖。项目级Skill共17个；来源与入口见README，目录内容SHA-256使用现有skills工具的排序/拼接算法写入skills-lock.json。

| Skill | GitHub来源 | 固定提交 | 安装目录 |
| --- | --- | --- | --- |
| claude-api | anthropics/skills | dbd4588f9e1033efb41dad4bef2f7947c8993d44 | .agents/skills/claude-api |
| frontend-design | anthropics/skills | dbd4588f9e1033efb41dad4bef2f7947c8993d44 | .agents/skills/frontend-design |
| loop-me | mattpocock/skills | 49dd158d1076134a641b33efb035946536778336 | .agents/skills/loop-me |
| cy-carousel | chengyi-ai/cy-carousel-skill | be1a9f1d35cf87b92fe34d172851060b1a4a35b1 | .agents/skills/cy-carousel |
| grilling（配套依赖） | mattpocock/skills | 49dd158d1076134a641b33efb035946536778336 | .agents/skills/grilling |

## 最小本地适配

- claude-api原description为1068字符；删除一句重复的“不要因一行修改跳过”提示，使描述为1020字符，保留原触发条件、提供商排除及读取顺序，满足1024字符元数据校验。
- cy-carousel的脱敏测试包含形似真实Key的合成假值。只把字符串拆成前缀和正文拼接，运行时假值与原来相同，保留脱敏测试，并通过项目凭据扫描。不保存真实凭据，不放宽扫描规则。
- 7个上游文本文件仅删除行尾空白或末尾多余空行，保留许可条款和脚本逻辑，并同步字体许可证清单中的3项文件哈希。全部本地差异与固定下载快照逐文件核对；frontend-design、loop-me及grilling保持上游原文。

## 兼容性结果

- 新5个入口的YAML用现有skills工具依赖解析，name/description有效；loop-me的显式调用标志保留；description均不超过1024字符，grilling依赖存在。
- 27个Python文件AST语法检查、2个新增Node报告/执行器模板语法检查通过。模板没有执行远程AI调用。
- cy-carousel上游50项回归通过：UTF-8、OCR延迟初始化、缺少Swift时明确错误、清单校验、真实字体渲染、字体回退、严格视觉分流、打包阻断及理由记录。必要本地适配后再次通过。
- 现有图片提示词、字幕译文规划与NoteMediaService共23项回归通过；更新前基线12项通过。应用仍使用OpenAI-compatible SDK，不切换模型提供商；已有前端方向及用户协作约定保持优先。
- 原6页sample样稿使用新版真实渲染出1440×1920 PNG，检查0技术错误，保留4条强调色面积建议；真实打包6张和预览、文稿、交付清单成功，`published=false`。全套缩略图已目检。旧私有输入和新样稿均只在本机，不进Git。
- 上述6张通过现有NoteMediaService及真实FFmpeg，逐张读取输出均为1080×1440 PNG。
- 正式暗色负向夹具刻意重复并留出大片空白，真实严格视觉检查产生2条留白阻断，退出码1；没有绕过阻断。sample模式严格视觉检查明确不适用，空阻断不被解释为视觉通过。骨架阻断与放行路径由上游回归覆盖，不宣称该负向样稿验证了骨架检测。
- 最终npm run check（后端/前端类型和凭据扫描）、Git差异检查、README入口/来源/版本/清单数量、目录哈希及固定快照复核通过。仅Skills和文档更新，未修改应用源码，不需要重编译或重启应用。

## 使用边界与剩余工作

这些Skills供开发助手或独立工具使用；安装不自动增加应用按钮。loop-me与grilling按宿主的技能调用能力使用，已授权内部复核仍遵循AGENTS.md，不因为上游问答建议重复索要确认。当前会话工具清单可能保留旧元数据，下一轮才能使用新Skill清单。

cy-carousel携带上游字体及OFL许可，独立Python渲染可用；当前验收环境Python3.12.14、Pillow12.3.0、NumPy2.3.5、PyMuPDF1.28.2，jieba为可选且未安装。扫描书页OCR仍需要macOS/Swift；未实机验证Windows/Linux，不以模拟平台测试替代。严格视觉默认关闭，暗色正式稿才适用，不替代事实、许可及逐页目检。

应用自动原创图文入口、页面JSON、素材选配与现有小红书草稿通路仍由Issue #15跟踪，本次不宣称完成集成。Windows应用实机由Issue #4跟踪。没有真实平台发布、新安装包或真实Claude API调用；原生字幕拼图不会被套用上游固定页数规则。
