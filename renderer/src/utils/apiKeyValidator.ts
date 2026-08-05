/**
 * API Key 验证工具
 * 用于检查用户是否配置了有效的 API Key
 */

/**
 * 检查是否有有效的 API Key
 * @returns Promise<boolean> 是否有活跃的 API Key
 */
export async function hasValidApiKey(): Promise<boolean> {
  try {
    if (typeof window !== 'undefined' && window.electron?.getConfig) {
      const config = await window.electron.getConfig();
      return config.aiKeys?.some(key => key.isActive) ?? false;
    }
    // 浏览器开发模式：检查后端 /api/config 端点
    try {
      const res = await fetch('/api/config');
      const config = await res.json();
      return config.aiKeys?.some((key: any) => key.isActive) ?? false;
    } catch { return false; }
  } catch (error) {
    console.error('Failed to check API key:', error);
    return false;
  }
}

/**
 * 获取当前活跃的 API Key
 * @returns Promise<AIKeyConfig | null> 活跃的 API Key 配置，如果没有则返回 null
 */
export async function getActiveApiKey() {
  try {
    if (typeof window !== 'undefined' && window.electron?.getConfig) {
      const config = await window.electron.getConfig();
      return config.aiKeys?.find(key => key.isActive) ?? null;
    }
    try {
      const res = await fetch('/api/config');
      const config = await res.json();
      return config.aiKeys?.find((key: any) => key.isActive) ?? null;
    } catch { return null; }
  } catch (error) {
    console.error('Failed to get active API key:', error);
    return null;
  }
}
