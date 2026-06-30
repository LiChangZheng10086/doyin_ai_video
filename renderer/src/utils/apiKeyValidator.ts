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
    const config = await window.electron.getConfig();
    return config.aiKeys?.some(key => key.isActive) ?? false;
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
    const config = await window.electron.getConfig();
    return config.aiKeys?.find(key => key.isActive) ?? null;
  } catch (error) {
    console.error('Failed to get active API key:', error);
    return null;
  }
}
