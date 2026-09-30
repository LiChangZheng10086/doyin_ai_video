type SauConfig = { sauBinary?: string; sauBaseDir?: string };
const text = (value: unknown) => typeof value === 'string' ? value.trim() || undefined : undefined;
export function resolveSauConfig(config: SauConfig, env: { SAU_BINARY?: string; SAU_BASE_DIR?: string }): SauConfig {
  return { sauBinary: text(env.SAU_BINARY) ?? text(config.sauBinary), sauBaseDir: text(env.SAU_BASE_DIR) ?? text(config.sauBaseDir) };
}
export function sauConfigToRemember(config: SauConfig, resolved: SauConfig): SauConfig {
  // Only remember a complete first configuration; never mix a temporary override with a saved partial pair.
  return !text(config.sauBinary) && !text(config.sauBaseDir) && resolved.sauBinary && resolved.sauBaseDir ? resolved : {};
}
export async function rememberSauConfig(config: SauConfig, resolved: SauConfig, save: (value: SauConfig) => Promise<void>): Promise<boolean> {
  const value = sauConfigToRemember(config, resolved);
  try { if (value.sauBinary && value.sauBaseDir) await save(value); return true; }
  catch { return false; }
}
