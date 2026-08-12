export function extractAiMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown; content?: unknown }).text
      ?? (part as { content?: unknown }).content;
    return typeof text === "string" ? text : "";
  }).join("").trim();
}
