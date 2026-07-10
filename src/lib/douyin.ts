export interface DouyinShareInput {
  shareText: string;
  sourceUrl?: string;
}

export interface DouyinShareParseResult {
  sourceUrl: string;
  shareText: string;
  normalizedText: string;
  introText: string;
  hashtags: string[];
  shareTail?: string;
  titleCandidate: string;
  contentType: string;
  topicCandidate: string;
}

const URL_PATTERN = /https?:\/\/[^\s]+/i;
const HASHTAG_PATTERN = /#\s*([^\s#]+)/g;

export function parseDouyinShare(input: DouyinShareInput): DouyinShareParseResult {
  const shareText = normalizeWhitespace(input.shareText);
  const sourceUrl = input.sourceUrl ?? extractUrl(shareText) ?? "";
  const normalizedText = stripShareTail(shareText);
  const hashtags = extractHashtags(normalizedText);
  const introText = extractIntroText(normalizedText);
  const titleCandidate = buildTitleCandidate(introText);
  const contentType = detectContentType(normalizedText);
  const topicCandidate = detectTopicCandidate(normalizedText);
  const shareTail = extractShareTail(shareText);

  return {
    sourceUrl,
    shareText,
    normalizedText,
    introText,
    hashtags,
    shareTail,
    titleCandidate,
    contentType,
    topicCandidate
  };
}

export function extractUrl(text: string) {
  const match = text.match(URL_PATTERN);
  return match?.[0];
}

export function extractHashtags(text: string) {
  const hashtags: string[] = [];
  const withoutUrl = text.replace(URL_PATTERN, " ");
  for (const match of withoutUrl.matchAll(HASHTAG_PATTERN)) {
    const tag = match[1].trim();
    if (tag) {
      hashtags.push(tag);
    }
  }
  return hashtags;
}

export function extractIntroText(text: string) {
  const withoutLink = text.replace(URL_PATTERN, " ");
  const withoutTags = withoutLink.replace(HASHTAG_PATTERN, " ");
  const withoutTail = stripShareTail(withoutTags);
  return collapseSpaces(stripLeadingShareNoise(withoutTail)).trim();
}

export function detectContentType(text: string) {
  const normalized = text.toLowerCase();
  if (normalized.includes("skills") || normalized.includes("技能包")) {
    return "skills_share";
  }
  if (normalized.includes("agent") || normalized.includes("指令")) {
    return "agent_share";
  }
  if (normalized.includes("openai") || normalized.includes("anthropic") || normalized.includes("claude")) {
    return "ai_tool_share";
  }
  return "general_ai_share";
}

export function detectTopicCandidate(text: string) {
  const intro = extractIntroText(text);
  if (!intro) {
    return "AI 技术分享";
  }

  const keywords = [
    "skills",
    "技能包",
    "agent",
    "指令",
    "openai",
    "anthropic",
    "claude",
    "文档",
    "PDF",
    "Excel"
  ];

  for (const keyword of keywords) {
    if (intro.toLowerCase().includes(keyword.toLowerCase())) {
      return keyword;
    }
  }

  return intro.slice(0, 24);
}

export function normalizeWhitespace(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function extractShareTail(text: string) {
  const tailMarker = "复制此链接";
  const index = text.indexOf(tailMarker);
  if (index < 0) {
    return undefined;
  }
  return collapseSpaces(text.slice(index)).trim();
}

function stripShareTail(text: string) {
  const tailMarker = "复制此链接";
  const index = text.indexOf(tailMarker);
  if (index < 0) {
    return text;
  }
  return text.slice(0, index).trim();
}

function buildTitleCandidate(introText: string) {
  const cleaned = collapseSpaces(stripLeadingShareNoise(introText))
    .replace(/^[:：\-\s]+/, "")
    .trim();
  if (!cleaned) {
    return "AI 技术分享";
  }
  return cleaned.slice(0, 48);
}

function collapseSpaces(text: string) {
  return text.replace(/\s+/g, " ");
}

function stripLeadingShareNoise(text: string) {
  const chineseIndex = text.search(/[\u4e00-\u9fff]/);
  if (chineseIndex <= 0) {
    return text.trim();
  }

  const head = text.slice(0, chineseIndex);
  const looksLikeNoise = /[@:/\d]/.test(head) || /[A-Za-z]/.test(head) && /[:/]/.test(head);
  if (!looksLikeNoise) {
    return text.trim();
  }

  return text.slice(chineseIndex).trim();
}
