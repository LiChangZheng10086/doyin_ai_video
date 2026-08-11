import React from 'react';
import { ApiKeyStatusIndicator } from '../ApiKeyStatusIndicator';
import { CookieStatusIndicator } from '../CookieStatusIndicator';
import { OperatorSwitcher } from '../OperatorSwitcher';
import { usePageContext } from './navigation';

export interface UtilityBarProps {
  onRequestRecovery: () => void;
}

export function UtilityBar({ onRequestRecovery }: UtilityBarProps) {
  const { title, subtitle } = usePageContext();

  return (
    <header className="fixed top-0 left-16 right-0 z-30 flex items-center justify-between h-14 px-4 bg-white border-b border-tech-border md:hidden">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-tech-text truncate">{title}</h2>
        {subtitle && <p className="text-xs text-tech-muted truncate">{subtitle}</p>}
      </div>
    </header>
  );
}

export function UtilityBarDesktop({ onRequestRecovery }: UtilityBarProps) {
  const { title, subtitle } = usePageContext();

  return (
    <header className="fixed top-0 left-16 right-0 z-30 hidden md:flex items-center justify-between h-14 px-5 bg-white border-b border-tech-border">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-tech-text truncate">{title}</h2>
        <p className="text-xs text-tech-muted truncate">{subtitle}</p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <ApiKeyStatusIndicator compact />
        <CookieStatusIndicator compact />
        <OperatorSwitcher onRequestRecovery={onRequestRecovery} />
      </div>
    </header>
  );
}
