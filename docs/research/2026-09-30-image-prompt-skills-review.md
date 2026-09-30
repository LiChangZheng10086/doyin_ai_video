# 图片提示词 Skills 与设计审核

核实日期：2026-09-30。范围为用户给出的六个 GitHub 仓库的 README、主要 SKILL.md、文件树及许可证资料，并对照本项目素材与文章链路。只读核实；未安装这些 Skills、运行仓库脚本或调用实际生图服务。仓库自述的模型版本与性能不是独立验收结果。

## 仓库核实

| 仓库与本次提交 | 已确认的内容 | 采用判断 |
| --- | --- | --- |
| [SonicBotMan/image-prompt-optimizer](https://github.com/SonicBotMan/image-prompt-optimizer/tree/d8f2e9a8373d1cd96cd1e8f663063c6ef2bbe764) | 根目录 SKILL.md 包含生成／优化、双语、词库和不同平台格式；有 MIT LICENSE。 | 可参考主体、环境、光线、构图的维度。文中有质量口号及固定模型名称／参数，不整体照搬，也不把其模型说明当官方现行规范。 |
| [iamyoki/qwen-image-2.1-skill](https://github.com/iamyoki/qwen-image-2.1-skill/tree/32b8100e70299b56478a35a9f1d5703605cdba46) | `skills/qwen-image-2-1-prompter/` 有 SKILL.md 与文生图／编辑参考规则，声明非官方，根许可证 Apache-2.0。文生图规则要求英文观察者叙述、保留指定文字、排除空泛质量词，并将比例独立保存。 | 专用流程有用，但不适合作为默认中文通用规则。具体官方对齐声明仍需沿其官方来源单独核实；不据此给应用贴「官方认证」。 |
| [Surge-Dan/image-prompt-crafter-skill](https://github.com/Surge-Dan/image-prompt-crafter-skill/tree/42c63ae974827d5bceb8d0b534dc9f340c5159fe) | 有 SKILL.md 与 references，包含抽象情绪转视觉、构图和失败诊断。README 声明 MIT，本次文件树未发现独立 LICENSE 文件，GitHub 未识别 SPDX。 | 概念视觉化值得参考；当前不直接打包其原文。里面的固定模型参数、编码器结论不作为未经验证的应用行为。 |
| [gnipbao/openai-image-prompt-writer](https://github.com/gnipbao/openai-image-prompt-writer/tree/4edd0ab61a19f86d25b71377f10fdaaa1989cf21) | 默认分支 `codex/main`；SKILL.md 支持新建、优化、保留约束、精确文字、参数分离；有 MIT LICENSE。README 明确属于社区项目，并声明没有独立图像效果基准。 | 采用其稳定写作思路；不将仓库声称的「GPT Image 2.5」具体版本或参数直接固化到产品，接入特定模型时另查官方文档。 |
| [TanShilongMario/PromptSkill4image](https://github.com/TanShilongMario/PromptSkill4image/tree/118e2945b7a5fa702209eec426713fe192cfbab4) | 根目录 SKILL.md、examples.md、vocabulary-banks.md 与 MIT LICENSE；中文优先，支持粗稿扩写、翻译、变量以及图像反推。强调按需求选择复杂度。 | 最适合作为首版通用生成／优化的主要参考。只采用文本扩写与翻译思路，图像反推和模板变量编辑器不在首版范围。 |
| [NanmiCoder/open-image-prompts](https://github.com/NanmiCoder/open-image-prompts/tree/7c3e79002ae611f19514fbc5ab2a48673b7418b0) | 有 `img-gen-taste` 和 `img-gen-prompts`，分别处理艺术方向与可追溯案例检索；项目代码 MIT。DATA_LICENSE.md 将原创元数据与第三方提示词／图片的权利分开说明。 | 参考来源可追溯的组织方式。首版不导入大型案例数据库或图片包；代码许可不能被当成所有第三方图片的复用授权。 |

以上提交用于定位本次审阅内容，实际改编前应再次对照对应提交内的许可证。本文是设计与来源核实记录，不是法律判断或各模型兼容性保证。

## 对应用的结论

现有后端是直接调用聊天模型，并没有通用 Agent Skill 执行器。安装到开发助手与应用生成提示词是两条不同路径。适合本轮的最小集成是：将少量经审阅的规则整理为后端系统提示词，复用当前 AI 配置，生成或优化结果进入已有设计的草稿和素材链路。

新增优化模式：输入已有提示词及修改要求，保留未要求修改的内容，新建优化结果供用户确认，不自动覆盖原稿。默认输出通用中文自然语言，可选择英文，模型特定语法另行核实接入。规则版本写入草稿，图片始终绑定用户最终保存的提示词快照。

素材检索继续依据本地图片的实际描述、标签及最终提示词；外部案例库不能替代本地素材身份、文件归属和图片内容校验。

## 原设计发现与修正

1. **中文标题默认过滤容易无结果**：原先按空白分词却直接预填整句中文标题，检索会要求整句包含。改为默认展示全部、用户提交短关键词，明确首版没有中文自动分词。固定匹配计分与同分顺序，区分检索结果数和素材总数。
2. **多张图片共用描述不可靠**：同一提示词生成的图片可能不同。改为每张独立描述／标签，提示词快照共享；空描述明确标识，不伪装已经识图。
3. **双索引串行不等于跨文件事务**：草稿与素材各有 JSON 索引。改为在草稿队列里按版本复制快照，再由 AssetStore 一次保存文件对应的完整元数据；定义读取快照后发生编辑／删除时仍保留原文本的行为。
4. **局部成功缺少前端契约**：现有上传顺序入库，后续失败可能留下前面成功项，而前端只看到异常。设计补齐图片上传的 assets／failures、原始文件序号、未尝试项与网络中断核对流程；音频协议不扩展。
5. **文章内再开 Modal 会冲突**：现有 Modal 各自绑定 document 的 Esc／Tab、操作 root inert 和 body 滚动；两个同时存在时子层关闭可能释放父层背景。改为在现有文章 Modal 内复用内联表单，不增加通用弹窗栈。
6. **输入与失败边界不够具体**：补齐字段限额、码点计数、AI 超时／禁重试、模型输出数量校验、元数据清空语义和新增写入鉴权，同时保持普通上传及已有平台授权契约。

审核后的设计已具备编写实现计划的边界；这不表示功能已经实现，也不表示生成图片效果已验收。
