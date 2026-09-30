import { create } from 'zustand';
export type ThemePreference = 'dark' | 'light' | 'system';
const key = 'douyin-ai-video.theme';
const valid = (value: unknown): value is ThemePreference => value === 'dark' || value === 'light' || value === 'system';
export const useThemeStore = create<{ preference: ThemePreference; error: string; saving: boolean; setPreference: (value: ThemePreference) => Promise<void> }>(() => ({ preference: 'dark', error: '', saving: false, setPreference: async () => {} }));

export async function initializeTheme(target: Window): Promise<() => void> {
  const media = target.matchMedia('(prefers-color-scheme: dark)');
  const desktopSave = target.electron?.saveConfig;
  let preference: ThemePreference = 'dark'; let error = '';
  try {
    if (desktopSave) {
      const config = await target.electron.getConfig();
      if (config.app?.themeConfigured === true && valid(config.app.theme)) preference = config.app.theme;
    } else {
      const stored = target.localStorage.getItem(key); if (valid(stored)) preference = stored;
    }
  } catch { error = '外观偏好读取失败，暂用深色；请重新选择。'; }
  const apply = () => { target.document.documentElement.dataset.theme = preference === 'system' ? media.matches ? 'dark' : 'light' : preference; };
  useThemeStore.setState({ preference, error, saving: false, setPreference: async value => {
    if (!valid(value) || useThemeStore.getState().saving) return;
    preference = value; apply(); useThemeStore.setState({ preference, saving: true, error: '' });
    try {
      if (desktopSave) await desktopSave({ app: { theme: preference, themeConfigured: true } });
      else target.localStorage.setItem(key, preference);
    } catch { useThemeStore.setState({ error: '外观已在本次窗口生效，但未保存；请稍后重新选择。' }); }
    finally { useThemeStore.setState({ saving: false }); }
  } });
  apply(); media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}
