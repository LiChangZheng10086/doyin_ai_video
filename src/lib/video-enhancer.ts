import OpenAI from "openai";
import type { ScriptAsset, EnhancedScene } from "../types.js";

export interface VideoEnhancerOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  provider?: "deepseek" | "openai";
}

export class VideoEnhancer {
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly provider: "deepseek" | "openai";

  constructor(options: VideoEnhancerOptions = {}) {
    const apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    const provider = options.provider || (process.env.AI_PROVIDER as "deepseek" | "openai") || "deepseek";

    this.provider = provider;
    this.model = options.model || process.env.AI_MODEL || "deepseek-chat";

    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: options.baseURL ||
          (provider === "deepseek" ? "https://api.deepseek.com" : undefined)
      });
    }
  }

  async enhanceScenes(
    sceneList: ScriptAsset["sceneList"],
    topic: string
  ): Promise<{
    videoPrompts: string[];
    enhancedScenes: EnhancedScene[];
  }> {
    if (!this.client) {
      // 如果没有配置 API key，返回基础版本
      return this.fallbackEnhancement(sceneList);
    }

    try {
      const enhancedScenes: EnhancedScene[] = [];
      const videoPrompts: string[] = [];

      // 批量处理场景，每次处理一个
      for (const scene of sceneList) {
        const prompt = this.buildVideoMasterPrompt(scene, topic);

        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            {
              role: "system",
              content: "你是一个专业的视频场景导演，擅长为AI视频生成工具编写电影级的场景提示词。你的输出需要包含相机运动、动作效果、光照风格等专业元素。"
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: 0.7,
          max_tokens: 500
        });

        const enhancedText = response.choices[0]?.message?.content?.trim() || scene.visual;

        // 解析增强后的场景描述
        const enhanced = this.parseEnhancedScene(scene, enhancedText);
        enhancedScenes.push(enhanced);
        videoPrompts.push(enhanced.videoPrompt);
      }

      return { videoPrompts, enhancedScenes };
    } catch (error) {
      console.error("Video enhancement failed, using fallback:", error);
      return this.fallbackEnhancement(sceneList);
    }
  }

  private buildVideoMasterPrompt(
    scene: ScriptAsset["sceneList"][0],
    topic: string
  ): string {
    return `请为这个技术分享视频场景生成专业的视频提示词。

主题：${topic}
场景编号：${scene.scene}
时长：${scene.duration}秒
字幕：${scene.caption}
原始视觉描述：${scene.visual}

请生成一个电影级的视频场景提示词，包含：
1. 相机运动（推进/拉远/跟踪/环绕/固定等）
2. 动作效果（慢动作/快速剪辑/平滑过渡等）
3. 光照风格（柔和/戏剧性/科技感/自然光等）
4. 画面构图和视觉元素
5. 整体氛围和风格

输出格式：
【相机运动】：...
【动作效果】：...
【光照风格】：...
【完整提示词】：一段完整的英文视频生成提示词，适合直接输入到 AI 视频生成工具

请确保提示词符合技术分享短视频的专业性和简洁性。`;
  }

  private parseEnhancedScene(
    originalScene: ScriptAsset["sceneList"][0],
    enhancedText: string
  ): EnhancedScene {
    // 尝试解析结构化内容
    const cameraMatch = enhancedText.match(/【相机运动】[：:]\s*(.+?)(?=\n|【|$)/);
    const motionMatch = enhancedText.match(/【动作效果】[：:]\s*(.+?)(?=\n|【|$)/);
    const lightingMatch = enhancedText.match(/【光照风格】[：:]\s*(.+?)(?=\n|【|$)/);
    const promptMatch = enhancedText.match(/【完整提示词】[：:]\s*(.+?)$/s);

    return {
      scene: originalScene.scene,
      originalVisual: originalScene.visual,
      videoPrompt: promptMatch?.[1]?.trim() || enhancedText,
      cameraMovement: cameraMatch?.[1]?.trim(),
      motionEffect: motionMatch?.[1]?.trim(),
      lightingStyle: lightingMatch?.[1]?.trim()
    };
  }

  private fallbackEnhancement(
    sceneList: ScriptAsset["sceneList"]
  ): {
    videoPrompts: string[];
    enhancedScenes: EnhancedScene[];
  } {
    // 简单的回退方案：基于场景描述生成基础提示词
    const enhancedScenes: EnhancedScene[] = sceneList.map((scene) => ({
      scene: scene.scene,
      originalVisual: scene.visual,
      videoPrompt: `Professional tech content video scene: ${scene.visual}, ${scene.caption}, clean modern style, 8K quality, smooth camera movement`,
      cameraMovement: "Smooth tracking shot",
      motionEffect: "Steady professional motion",
      lightingStyle: "Clean modern lighting"
    }));

    return {
      videoPrompts: enhancedScenes.map((s) => s.videoPrompt),
      enhancedScenes
    };
  }
}

export function createVideoEnhancer(options?: VideoEnhancerOptions): VideoEnhancer {
  return new VideoEnhancer(options);
}
