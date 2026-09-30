import React from 'react';
import { Moon, Sun, Monitor } from 'lucide-react';
import { useThemeStore, type ThemePreference } from '../../store/theme';

export function ThemeSwitcher() {
  const { preference, error, saving, setPreference } = useThemeStore();
  const Icon = preference === 'dark' ? Moon : preference === 'light' ? Sun : Monitor;
  return <div className="relative shrink-0">
    <label className="flex h-8 items-center gap-1.5 rounded-lg border border-line-ui bg-panel pl-2 text-ink focus-within:ring-2 focus-within:ring-accent" title="切换界面主题">
      <Icon size={15} aria-hidden="true" />
      <select aria-label="界面主题" value={preference} disabled={saving} onChange={event => void setPreference(event.target.value as ThemePreference)} className="h-full rounded-r-lg bg-transparent pr-1 text-xs text-ink outline-none">
        <option value="dark">深色</option><option value="light">浅色</option><option value="system">跟随系统</option>
      </select>
    </label>
    {error && <p role="alert" className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-warning-line bg-warning-soft p-3 text-xs leading-5 text-warning shadow-lg">{error}</p>}
  </div>;
}
