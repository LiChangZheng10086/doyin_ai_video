export type AiProvider = "deepseek" | "openai" | "custom";

export type EditableAiKey = {
  name: string;
  provider: AiProvider;
  apiKey: string;
  baseURL?: string;
  model: string;
};
export type EditableAiKeyChanges = Omit<EditableAiKey, "apiKey"> & { apiKey?: string };

export function normalizeBaseURL(value?: string) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export function mergeAiKeyChanges<T extends EditableAiKey>(existing: T, changes: EditableAiKeyChanges): T {
  return {
    ...existing,
    ...changes,
    apiKey: changes.apiKey?.trim() || existing.apiKey,
    baseURL: normalizeBaseURL(changes.baseURL)
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
