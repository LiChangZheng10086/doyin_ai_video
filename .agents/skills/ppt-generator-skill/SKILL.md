---
name: PPT Generator Skill
description: 智能 PPT 生成器。支持 7 种视觉风格（乐高/波普/黏土/黑白/商务/学术/科技），具备根据内容自动推荐风格、生成大纲、绘制配图并组装成片的全自动能力。
---

# PPT Generator Skill

## 🎯 核心能力
本技能将“内容创作”与“视觉设计”合二为一，只需提供一段文字资料，即可全自动生成一份高质量、有设计感的 PPT。

## 🎨 七大视觉风格 (Style Gallery)

### A. 创意叙事类 (Creative & Storytelling)
适合：教育科普、创意营销、个人品牌、轻松话题
1.  **🧱 乐高积木风 (Lego Style)**
    *   **视觉**：乐高小人仔 + 积木搭建的场景，色彩鲜艳，微距摄影感。
    *   **适用**：把抽象概念具象化、流程拆解、寓教于乐。
2.  **🖼️ 复古波普风 (Vintage Pop Art)**
    *   **视觉**：50年代美式漫画，高对比度网点，红黄蓝大色块，粗线条。
    *   **适用**：营销大字报、趋势分析、强调痛点与行动。
3.  **🎞️ 黏土定格风 (Clay Stop-Motion)**
    *   **视觉**：有指纹痕迹的手工黏土模型，柔和暖光，可爱治愈。
    *   **适用**：生活方式、亲子教育、轻松的团队建设。
4.  **✒️ 极简黑白风 (Dan Koe / Zen)**
    *   **视觉**：蚀刻版画质感，纯黑背景 + 白色精细线条，极简留白。
    *   **适用**：深度认知、哲学思考、高端咨询、个人 IP。

### B. 专业商务类 (Business & Professional)
适合：汇报路演、学术报告、技术发布
5.  **🎓 学术深蓝 (Academic Blue)**
    *   **视觉**：纯白底 + 深蓝标题 + 红色强调，严谨的框架图。
    *   **适用**：医疗、科研、学术论文汇报。
6.  **👔 经典商务 (Corporate Navy)**
    *   **视觉**：深海蓝底 + 金色衬线体，高端大气。
    *   **适用**：融资计划书、高管汇报、年度总结。
7.  **🔬 原力科技 (Tech Future)**
    *   **视觉**：黑底 + 霓虹线条，数据可视化风格。
    *   **适用**：AI 产品发布、互联网技术分享。

## 🛠️ 使用流程 (Workflow)

### 1. 风格推荐 (Style Recommendation)
用户提供原始文本，Agent 自动分析调性并推荐风格。
> 用户：“帮我把这篇关于 AI 代理的文章做成 PPT。”
> Agent：“这篇文章讲的是无需人工介入的未来工作流，比较前卫。推荐使用 **[🔬 原力科技风]** 展现未来感，或者 **[🧱 乐高风格]** 来拆解 Agent 是如何像搭积木一样工作的。您选哪个？”

### 2. 结构化生成 (Content Generation)
选定风格后，Agent 调用对应的 **Prompt Template** (位于 `templates/`)，让 LLM 生成结构化的 JSON 内容（包含每页标题、正文、配图提示词）。

### 3. 视觉绘制 (Image Generation)
Agent 自动调用绘图工具（如 Imagen/Midjourney），根据 JSON 中的提示词批量生成每一页的配图。

### 4. 组装成片 (Assembly)
运行 `generate_styled_ppt.py`，将文字与生成的图片自动组装成最终的 `.pptx` 文件。

## 📂 文件结构
```
.agent/skills/ppt-generator/
├── SKILL.md                 # 技能说明书
├── generate_styled_ppt.py   # 通用组装脚本 (支持 JSON -> PPTX)
├── templates/               # 高阶提示词模版
│   ├── lego_style_prompt.md
│   ├── vintage_pop_art_prompt.md
│   ├── clay_style_prompt.md
│   └── dan_koe_style_prompt.md
├── styles/                  # 样式配置文件 (颜色、字体)
│   ├── academic_blue_style.json
│   └── yuanli_style.json
└── prompts/                 # 旧版提示词存档
```

## 💻 命令行调用
```bash
# 组装 PPT (当 JSON 和图片都准备好后)
python3 .agent/skills/ppt-generator/generate_styled_ppt.py \
  --input "presentation_content.json" \
  --output "final_presentation.pptx"
```
