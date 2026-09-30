import React from 'react';
import { ApiKeyStatusIndicator } from '../ApiKeyStatusIndicator';
import { CookieStatusIndicator } from '../CookieStatusIndicator';
import { usePageContext } from './navigation';
import { ThemeSwitcher } from './ThemeSwitcher';

export function UtilityBar() {
  const { title, subtitle } = usePageContext();

  return (
    <header className="fixed top-0 left-0 right-0 z-30 flex items-center justify-between gap-3 h-14 px-4 bg-panel border-b border-line transition-[left] duration-200 md:left-[var(--rail-w)] md:hidden">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink truncate">{title}</h2>
        {subtitle && <p className="text-xs text-ink-muted truncate">{subtitle}</p>}
      </div>
      <ThemeSwitcher />
    </header>
  );
}

export function UtilityBarDesktop() {
  const { title, subtitle } = usePageContext();

  return (
    <header className="fixed top-0 left-14 right-0 z-30 hidden md:flex items-center justify-between h-14 px-5 bg-panel border-b border-line transition-[left] duration-200 md:left-[var(--rail-w)]">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink truncate">{title}</h2>
        <p className="text-xs text-ink-muted truncate">{subtitle}</p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <ApiKeyStatusIndicator compact />
        <CookieStatusIndicator compact />
        <ThemeSwitcher />
      </div>
    </header>
  );
}
