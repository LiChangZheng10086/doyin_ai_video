export type AiProvider = "deepseek" | "openai" | "custom";

export type EditableAiKey = {
  name: string;
  provider: AiProvider;
  apiKey: string;
  baseURL?: string;
  model: string;
  maxOutputTokens?: number;
};
export type EditableAiKeyChanges = Omit<EditableAiKey, "apiKey" | "maxOutputTokens"> & {
  apiKey?: string;
  maxOutputTokens?: number | null;
};

export function normalizeBaseURL(value?: string) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export function normalizeMaxOutputTokens(value?: number) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error("输出 Token 上限必须为整数");
  if (value < 256) throw new Error("输出 Token 上限至少为 256");
  return value;
}

export function mergeAiKeyChanges<T extends EditableAiKey>(existing: T, changes: EditableAiKeyChanges): T {
  return {
    ...existing,
    ...changes,
    apiKey: changes.apiKey?.trim() || existing.apiKey,
    baseURL: normalizeBaseURL(changes.baseURL),
    maxOutputTokens: normalizeMaxOutputTokens(
      changes.maxOutputTokens === null ? undefined : changes.maxOutputTokens ?? existing.maxOutputTokens
    )
  };
}

export function classifyHttpFailure(status: number, message: string) {
  if (status === 401 || status === 403) return "auth" as const;
  if (status === 429) return "quota" as const;
  if (status >= 500) return "upstream" as const;
  if (/model|模型|does not exist|unsupported/i.test(message)) return "model" as const;
  if (status === 404) return "endpoint" as const;
  return "unknown" as const;
}

export function classifyNetworkFailure(error: unknown) {
  const text = errorMessages(error).join(" ");
  if (/timeout|timed out|abort/i.test(text)) return "timeout" as const;
  if (/enotfound|eai_again|getaddrinfo|resolve/i.test(text)) return "dns" as const;
  if (/certificate|ssl|tls|handshake|econnreset|socket hang up/i.test(text)) return "tls" as const;
  return "unknown" as const;
}

function errorMessages(error: unknown, depth = 0): string[] {
  if (!error || depth > 4) return [];
  if (typeof error === "string") return [error];
  if (typeof error !== "object") return [String(error)];
  const value = error as Record<string, unknown>;
  return [
    typeof value.message === "string" ? value.message : "",
    typeof value.code === "string" ? value.code : "",
    ...errorMessages(value.cause, depth + 1)
  ].filter(Boolean);
}
