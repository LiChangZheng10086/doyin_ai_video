import type { DouyinShareParseResult } from "./douyin.js";
import type { DouyinPageInfo } from "./douyin-page.js";
import type { ScriptAsset } from "../types.js";

export interface TranscriptDraftInput {
  sourceUrl: string;
  transcriptText: string;
  topic: string;
  pageInfo?: DouyinPageInfo | null;
}

export function buildScriptDraft(
  parsed: DouyinShareParseResult,
  topic: string,
  pageInfo?: DouyinPageInfo | null
): ScriptAsset {
  const subject = buildSubject(parsed);
  const hook = buildHook(subject);
  const benefits = buildBenefits(parsed);
  const summary = buildSummary(parsed);
  const coverTitle = buildCoverTitle(parsed, pageInfo);
  const tags = dedupeTags([
    ...parsed.hashtags,
    normalizeTag(topic),
    normalizeTag(parsed.contentType),
    "AI",
    "技术分享"
  ]);

  return {
    sourceUrl: parsed.sourceUrl,
    title: parsed.titleCandidate,
    pageTitle: pageInfo?.pageTitle,
    pageDescription: pageInfo?.pageDescription,
    authorName: pageInfo?.authorName,
    publishTime: pageInfo?.publishTime,
    rawShareText: parsed.shareText,
    normalizedShareText: parsed.normalizedText,
    introText: parsed.introText,
    hashtags: parsed.hashtags,
    contentType: parsed.contentType,
    topic,
    rawText: parsed.introText,
    cleanScript: [hook, benefits, summary].join("\n\n"),
    voiceoverScript: [hook, benefits, summary].join(" "),
    coverTitle,
    tags,
    summary,
    keyPoints: [subject, benefits, summary].filter(Boolean).slice(0, 3),
    pptOutline: buildFallbackPptOutline(subject, benefits, summary),
    sceneList: [
      {
        scene: 1,
        duration: 4,
        caption: hook,
        visual: "标题卡 + 重点高亮"
      },
      {
        scene: 2,
        duration: 6,
        caption: benefits,
        visual: "功能点分屏卡片"
      },
      {
        scene: 3,
        duration: 5,
        caption: summary,
        visual: "总结卡 + CTA"
      }
    ],
    status: "draft"
  };
}

export function buildTranscriptDraft(input: TranscriptDraftInput): ScriptAsset {
  const transcript = normalizeTranscript(input.transcriptText);
  const coverTitle = buildTranscriptCoverTitle(input.pageInfo, transcript, input.topic);
  const tags = dedupeTags(["AI", "技术分享", normalizeTag(input.topic)]);
  const summary = transcript.slice(0, 160) || "这里是视频转写内容";
  const keyPoints = buildTranscriptKeyPoints(transcript);

  return {
    sourceUrl: input.sourceUrl,
    title: input.pageInfo?.pageTitle ?? input.topic,
    pageTitle: input.pageInfo?.pageTitle,
    pageDescription: input.pageInfo?.pageDescription,
    authorName: input.pageInfo?.authorName,
    publishTime: input.pageInfo?.publishTime,
    topic: input.topic,
    rawText: transcript,
    transcriptText: transcript,
    cleanScript: transcript,
    voiceoverScript: transcript,
    coverTitle,
    tags,
    summary,
    keyPoints,
    pptOutline: buildFallbackPptOutline(coverTitle, ...keyPoints),
    sceneList: [
      {
        scene: 1,
        duration: 5,
        caption: summary || "先看看视频里到底说了什么",
        visual: "视频转写原文"
      },
      {
        scene: 2,
        duration: 5,
        caption: "后续可在此基础上继续清洗成短视频口播稿",
        visual: "AI 清洗占位"
      }
    ],
    status: "draft"
  };
}

function buildHook(subject: string) {
  return `今天分享 ${subject}，它最核心的价值是让 AI 直接帮你处理文档活。`;
}

function buildBenefits(parsed: DouyinShareParseResult) {
  const abilities = [
    parsed.normalizedText.includes("Word") ? "自动生成 Word 报告" : "",
    parsed.normalizedText.includes("PDF") ? "提取 PDF 文档内容" : "",
    parsed.normalizedText.includes("PPT") ? "创建 PPT 幻灯片" : "",
    parsed.normalizedText.includes("Excel") ? "清洗整理 Excel 数据" : ""
  ].filter(Boolean);

  if (abilities.length === 0) {
    return "它能把原本需要手动整理的内容，直接变成适合 AI 处理的结构化工作流。";
  }

  return `它覆盖了常见的文档操作：${abilities.join("、")}。`;
}

function buildSummary(parsed: DouyinShareParseResult) {
  if (parsed.contentType === "skills_share") {
    return "一句话总结：这类 Skills 特别适合文档办公场景，能把重复的手工操作交给 AI。";
  }

  if (parsed.contentType === "agent_share") {
    return "一句话总结：这类指令模板的重点，是把复杂任务拆成可复用的 Agent 工作流。";
  }

  return "一句话总结：你原来要手动点半天的办公操作，现在可以交给 AI。";
}

function buildCoverTitle(parsed: DouyinShareParseResult, pageInfo?: DouyinPageInfo | null) {
  if (pageInfo?.pageTitle) {
    return pageInfo.pageTitle.slice(0, 24);
  }
  if (parsed.contentType === "skills_share") {
    return "Anthropic Skills：让 AI 会干文档活";
  }
  return parsed.titleCandidate.slice(0, 20) || "AI 技术分享";
}

function buildSubject(parsed: DouyinShareParseResult) {
  if (parsed.contentType === "skills_share") {
    return "Anthropic 官方出品的 Skills 技能包";
  }

  if (parsed.contentType === "agent_share") {
    return "一个很实用的 Agent 指令模板";
  }

  if (parsed.titleCandidate) {
    return parsed.titleCandidate;
  }

  return "一个 AI 技术分享";
}

function buildTranscriptCoverTitle(
  pageInfo: DouyinPageInfo | null | undefined,
  transcriptText: string,
  topic: string
) {
  if (pageInfo?.pageTitle) {
    return pageInfo.pageTitle.slice(0, 24);
  }

  const firstLine = transcriptText.split(/\n+/).find(Boolean)?.trim() ?? "";
  if (firstLine) {
    return firstLine.slice(0, 24);
  }

  return topic.slice(0, 24) || "AI 技术分享";
}

function normalizeTag(tag: string) {
  return tag.replace(/^#/, "").trim();
}

function dedupeTags(tags: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim();
    if (!normalized || seen.has(normalized.toLowerCase())) {
      continue;
    }
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  }
  return result;
}

function normalizeTranscript(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function buildTranscriptKeyPoints(transcript: string) {
  const sentences = transcript
    .split(/[。！？!?；;\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.slice(0, 4).map((sentence) => sentence.slice(0, 80));
}

function buildFallbackPptOutline(title: string, ...points: string[]) {
  const cleanPoints = points.map((point) => point.trim()).filter(Boolean);
  return [
    {
      title: "封面",
      bullets: [title].filter(Boolean)
    },
    {
      title: "核心内容",
      bullets: cleanPoints.slice(0, 4).length ? cleanPoints.slice(0, 4) : ["内容清洗", "要点提炼"]
    },
    {
      title: "总结",
      bullets: cleanPoints.slice(-3).length ? cleanPoints.slice(-3) : ["回顾重点", "行动建议"]
    }
  ];
}
