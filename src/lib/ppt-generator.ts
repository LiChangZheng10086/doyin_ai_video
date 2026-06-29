import OpenAI from "openai";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import type { ScriptAsset, PPTContent, PPTSlide } from "../types.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PPTGeneratorOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  provider?: "deepseek" | "openai";
  pythonBinary?: string;
  storageRoot?: string;
}

type PPTStyle =
  | "lego"           // 乐高积木风
  | "pop-art"        // 复古波普风
  | "clay"           // 黏土定格风
  | "minimal"        // 极简黑白风
  | "academic"       // 学术深蓝
  | "corporate"      // 经典商务
  | "tech";          // 原力科技

export class PPTGenerator {
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly provider: "deepseek" | "openai";
  private readonly pythonBinary: string;
  private readonly storageRoot: string;
  private readonly skillPath: string;

  constructor(options: PPTGeneratorOptions = {}) {
    const apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    const provider = options.provider || (process.env.AI_PROVIDER as "deepseek" | "openai") || "deepseek";

    this.provider = provider;
    this.model = options.model || process.env.AI_MODEL || "deepseek-chat";
    this.pythonBinary = options.pythonBinary || process.env.PYTHON_BINARY || "python3";
    this.storageRoot = options.storageRoot || path.join(process.cwd(), "storage");

    // 获取 ppt-generator-skill 的路径
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    this.skillPath = path.join(homeDir, ".claude/skills/ppt-generator-skill");

    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: options.baseURL ||
          (provider === "deepseek" ? "https://api.deepseek.com" : undefined)
      });
    }
  }

  async generatePPT(
    scriptAsset: ScriptAsset,
    jobId: string
  ): Promise<{
    pptContent: PPTContent;
    pptPath: string;
    style: string;
  }> {
    if (!this.client) {
      throw new Error("PPT generation requires AI API key (DEEPSEEK_API_KEY or OPENAI_API_KEY)");
    }

    // 1. 根据 topic 推荐风格
    const style = this.selectStyle(scriptAsset.topic);

    // 2. 生成 PPT 结构化内容
    const pptContent = await this.generatePPTContent(scriptAsset, style);

    // 3. 保存 JSON 内容
    const outputDir = path.join(this.storageRoot, "output", "ppt");
    await fs.mkdir(outputDir, { recursive: true });

    const jsonPath = path.join(outputDir, `${jobId}.ppt.json`);
    await fs.writeFile(jsonPath, JSON.stringify(pptContent, null, 2), "utf-8");

    // 4. 调用 Python 脚本生成 PPTX（如果脚本存在）
    const pptxPath = path.join(outputDir, `${jobId}.pptx`);
    await this.generatePPTXFile(jsonPath, pptxPath, style);

    return {
      pptContent,
      pptPath: pptxPath,
      style
    };
  }

  private selectStyle(topic: string): PPTStyle {
    const topicLower = topic.toLowerCase();

    // 根据主题推荐风格
    if (topicLower.includes("ai") || topicLower.includes("技术") || topicLower.includes("科技")) {
      return "tech";
    }
    if (topicLower.includes("学术") || topicLower.includes("研究") || topicLower.includes("论文")) {
      return "academic";
    }
    if (topicLower.includes("商务") || topicLower.includes("融资") || topicLower.includes("汇报")) {
      return "corporate";
    }
    if (topicLower.includes("教育") || topicLower.includes("科普") || topicLower.includes("入门")) {
      return "lego";
    }

    // 默认：科技风格
    return "tech";
  }

  private async generatePPTContent(
    scriptAsset: ScriptAsset,
    style: PPTStyle
  ): Promise<PPTContent> {
    const styleMap: Record<PPTStyle, string> = {
      lego: "乐高积木风格",
      "pop-art": "复古波普风格",
      clay: "黏土定格风格",
      minimal: "极简黑白风格",
      academic: "学术深蓝风格",
      corporate: "经典商务风格",
      tech: "原力科技风格"
    };

    const prompt = `请将以下技术分享内容转换成 PPT 结构。

主题：${scriptAsset.topic}
视觉风格：${styleMap[style]}

内容概要：
标题：${scriptAsset.coverTitle}
关键要点：
${scriptAsset.keyPoints?.map((p, i) => `${i + 1}. ${p}`).join("\n") || "无"}

完整脚本：
${scriptAsset.cleanScript}

请生成 8-12 页的 PPT，包括：
1. 封面页（标题 + 副标题）
2. 目录页（3-4 个章节）
3. 内容页（每个章节 2-3 页）
4. 总结页
5. 行动建议页

每一页输出格式：
{
  "title": "页面标题",
  "bullets": ["要点1", "要点2", "要点3"],
  "speakerNotes": "演讲备注（80-150字）",
  "imagePrompt": "配图提示词（描述场景、元素、氛围）"
}

请以 JSON 数组格式输出所有页面。`;

    const response = await this.client!.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content: "你是一个专业的 PPT 设计师，擅长将技术内容转化为结构清晰、易于理解的演示文稿。"
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 3000
    });

    const content = response.choices[0]?.message?.content?.trim() || "";

    // 尝试解析 JSON
    let slides: PPTSlide[];
    try {
      // 提取 JSON 部分（可能被包裹在 ```json 代码块中）
      const jsonMatch = content.match(/```json\s*([\s\S]+?)\s*```/) || content.match(/\[[\s\S]+\]/);
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
      slides = JSON.parse(jsonStr);
    } catch (error) {
      console.error("Failed to parse PPT JSON, using fallback:", error);
      slides = this.generateFallbackSlides(scriptAsset);
    }

    return {
      slides,
      style: styleMap[style],
      theme: style
    };
  }

  private generateFallbackSlides(scriptAsset: ScriptAsset): PPTSlide[] {
    const slides: PPTSlide[] = [];

    // 封面
    slides.push({
      title: scriptAsset.coverTitle,
      bullets: [scriptAsset.topic],
      speakerNotes: "欢迎大家，今天我们要分享的主题是：" + scriptAsset.coverTitle,
      imagePrompt: "Modern tech presentation cover, clean design, professional style"
    });

    // 目录
    if (scriptAsset.keyPoints && scriptAsset.keyPoints.length > 0) {
      slides.push({
        title: "本次分享内容",
        bullets: scriptAsset.keyPoints.slice(0, 4),
        speakerNotes: "今天我们会讨论以下几个核心话题。",
        imagePrompt: "Content overview, clean layout, tech style"
      });
    }

    // 内容页（每个关键点一页）
    scriptAsset.keyPoints?.forEach((point, index) => {
      slides.push({
        title: point,
        bullets: [
          "这是一个重要的概念",
          "让我们深入了解",
          "实际应用场景"
        ],
        speakerNotes: `关于${point}，这是我们需要重点理解的内容。`,
        imagePrompt: `Tech illustration for: ${point}, modern style`
      });
    });

    // 总结
    slides.push({
      title: "总结",
      bullets: scriptAsset.keyPoints?.slice(0, 3) || ["关键点1", "关键点2", "关键点3"],
      speakerNotes: "让我们回顾一下今天分享的核心内容。",
      imagePrompt: "Summary slide, clean design, professional"
    });

    return slides;
  }

  private async generatePPTXFile(
    jsonPath: string,
    outputPath: string,
    style: string
  ): Promise<void> {
    try {
      // 检查 Python 脚本是否存在
      const scriptPath = path.join(this.skillPath, "scripts", "generate_styled_ppt.py");

      try {
        await fs.access(scriptPath);
      } catch {
        console.warn("PPT generator script not found, skipping PPTX generation");
        return;
      }

      // 调用 Python 脚本
      await execFileAsync(this.pythonBinary, [
        scriptPath,
        "--input", jsonPath,
        "--output", outputPath,
        "--style", style
      ], {
        timeout: 60000 // 60秒超时
      });

      console.log(`PPTX file generated: ${outputPath}`);
    } catch (error) {
      console.error("Failed to generate PPTX file:", error);
      // 不抛出错误，只记录日志，因为 JSON 内容已经生成
    }
  }
}

export function createPPTGenerator(options?: PPTGeneratorOptions): PPTGenerator {
  return new PPTGenerator(options);
}
