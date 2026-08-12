import React, { useState, ReactNode } from 'react';
import { PrimaryRail } from './PrimaryRail';
import { MobileNavigation } from './MobileNavigation';
import { UtilityBar, UtilityBarDesktop } from './UtilityBar';
import { BottomSheet } from '../ui/BottomSheet';
import { SECONDARY_NAV_ITEMS } from './navigation';
import { ApiKeyStatusIndicator } from '../ApiKeyStatusIndicator';
import { CookieStatusIndicator } from '../CookieStatusIndicator';
import { OperatorSwitcher } from '../OperatorSwitcher';
import { useNavigate } from 'react-router-dom';

export interface AppShellProps {
  children: ReactNode;
  onRequestRecovery: () => void;
}

export function AppShell({ children, onRequestRecovery }: AppShellProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-canvas">
      {/* Desktop: left rail + top bar */}
      <div className="hidden md:block">
        <PrimaryRail />
        <UtilityBarDesktop onRequestRecovery={onRequestRecovery} />
      </div>

      {/* Mobile context bar (page title) */}
      <div className="md:hidden">
        <UtilityBar onRequestRecovery={onRequestRecovery} />
      </div>

      {/* Main content area — offset for desktop rail + utility bar, mobile top bar */}
      <main className="pt-14 md:ml-[56px] xl:ml-16 md:pt-14 pb-14 md:pb-0 min-h-screen">
        {children}
      </main>

      {/* Mobile: bottom navigation */}
      <MobileNavigation onOpenMore={() => setMoreOpen(true)} />

      {/* Mobile "更多" sheet */}
      <BottomSheet open={moreOpen} title="更多" onClose={() => setMoreOpen(false)}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 px-3 py-2">
            <ApiKeyStatusIndicator />
          </div>
          <div className="flex items-center gap-3 px-3 py-2">
            <CookieStatusIndicator />
          </div>
          <div className="px-3 py-2">
            <OperatorSwitcher onRequestRecovery={onRequestRecovery} />
          </div>
          <hr className="border-tech-border" />
          {SECONDARY_NAV_ITEMS.map((item) => (
            <button
              key={item.to}
              type="button"
              onClick={() => { navigate(item.to); setMoreOpen(false); }}
              className="flex items-center gap-3 px-3 py-2.5 text-sm text-tech-text hover:bg-tech-bg rounded-lg"
            >
              <item.icon size={18} className="text-tech-muted" />
              {item.label}
            </button>
          ))}
        </div>
      </BottomSheet>
    </div>
  );
}
