import { resolve4, resolve6 } from "node:dns/promises";

export type AiErrorCode =
  | "dns"
  | "tls"
  | "timeout"
  | "auth"
  | "endpoint"
  | "model"
  | "quota"
  | "upstream"
  | "unknown";

export interface AiErrorDiagnosis {
  code: AiErrorCode;
  message: string;
}

type AiErrorContext = {
  baseURL?: string;
  model?: string;
};

type DnsCheck = (hostname: string) => Promise<boolean>;

export async function diagnoseAiError(
  error: unknown,
  context: AiErrorContext,
  dnsCheck: DnsCheck = hasDnsRecords
): Promise<AiErrorDiagnosis> {
  const status = findNumber(error, "status");
  const rawMessage = collectErrorMessages(error).join(" ") || "未知错误";
  const hostname = safeHostname(context.baseURL);
  const suffix = context.model ? `（模型：${context.model}）` : "";

  if (status === 401 || status === 403) {
    return { code: "auth", message: `API Key 无效或没有访问权限${suffix}` };
  }
  if (status === 429) {
    return { code: "quota", message: `API 请求被限流或额度不足${suffix}` };
  }
  if (status !== undefined && status >= 500) {
    return { code: "upstream", message: `AI 中转服务暂时不可用（HTTP ${status}）${suffix}` };
  }
  if (status === 404) {
    return { code: "endpoint", message: `API 地址路径不正确（HTTP 404，域名：${hostname}）${suffix}` };
  }
  if (status === 400 && /model|模型|does not exist|not found|unsupported/i.test(rawMessage)) {
    return { code: "model", message: `模型 ID 不存在或当前账号无权使用${suffix}` };
  }
  if (/timeout|timed out|abort/i.test(rawMessage)) {
    return { code: "timeout", message: `连接 AI 服务超时（域名：${hostname}）${suffix}` };
  }
  if (/premature close/i.test(rawMessage)) {
    return { code: "upstream", message: `AI 服务在流式返回中连接中断（域名：${hostname}）${suffix}` };
  }
  if (/certificate|ssl|tls|handshake|econnreset|socket hang up/i.test(rawMessage)) {
    return { code: "tls", message: `TLS、证书或代理连接失败（域名：${hostname}）${suffix}` };
  }
  if (/enotfound|eai_again|getaddrinfo|resolve/i.test(rawMessage)) {
    return { code: "dns", message: `无法解析 API 域名 ${hostname}，请填写中转服务商提供的新地址${suffix}` };
  }

  if (hostname !== "未知地址" && /connection|fetch failed|network/i.test(rawMessage)) {
    const resolvable = await dnsCheck(hostname).catch(() => false);
    if (!resolvable) {
      return { code: "dns", message: `无法解析 API 域名 ${hostname}，请填写中转服务商提供的新地址${suffix}` };
    }
  }

  return { code: "unknown", message: `${rawMessage}${suffix}` };
}

async function hasDnsRecords(hostname: string) {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  return results.some((result) => result.status === "fulfilled" && result.value.length > 0);
}

function safeHostname(baseURL?: string) {
  try {
    return baseURL ? new URL(baseURL).hostname : "未知地址";
  } catch {
    return "未知地址";
  }
}

function collectErrorMessages(error: unknown, depth = 0): string[] {
  if (!error || depth > 4) return [];
  if (typeof error === "string") return [error];
  if (typeof error !== "object") return [String(error)];
  const value = error as Record<string, unknown>;
  return [
    typeof value.message === "string" ? value.message : "",
    ...collectErrorMessages(value.error, depth + 1),
    ...collectErrorMessages(value.cause, depth + 1)
  ].filter(Boolean);
}

function findNumber(error: unknown, key: string, depth = 0): number | undefined {
  if (!error || typeof error !== "object" || depth > 4) return undefined;
  const value = error as Record<string, unknown>;
  if (typeof value[key] === "number") return value[key];
  return findNumber(value.error, key, depth + 1) ?? findNumber(value.cause, key, depth + 1);
}
