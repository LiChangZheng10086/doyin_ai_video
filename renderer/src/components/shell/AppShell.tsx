import React, { useState, ReactNode } from 'react';
import { PrimaryRail } from './PrimaryRail';
import { MobileNavigation } from './MobileNavigation';
import { UtilityBar, UtilityBarDesktop } from './UtilityBar';
import { BottomSheet } from '../ui/BottomSheet';
import { SECONDARY_NAV_ITEMS } from './navigation';
import { ApiKeyStatusIndicator } from '../ApiKeyStatusIndicator';
import { CookieStatusIndicator } from '../CookieStatusIndicator';
import { useNavigate } from 'react-router-dom';
import { readStoredRailExpanded, writeStoredRailExpanded } from '../../utils/railPreference';

export interface AppShellProps {
  children: ReactNode;
  /**
   * 侧栏初始是否展开。测试用它绕开 localStorage；默认由持久化偏好决定。
   */
  initialExpanded?: boolean;
}

export function AppShell({ children, initialExpanded }: AppShellProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(() => {
    if (initialExpanded !== undefined) return initialExpanded;
    // 静态渲染（组件测试）里没有 window，必须判断后再访问 localStorage
    if (typeof window === 'undefined') return false;
    return readStoredRailExpanded(window.localStorage);
  });
  const navigate = useNavigate();

  const toggleRail = () => {
    setRailExpanded((current) => {
      const next = !current;
      if (typeof window !== 'undefined') writeStoredRailExpanded(window.localStorage, next);
      return next;
    });
  };

  return (
    <div
      className={`min-h-screen bg-canvas ${
        railExpanded ? '[--rail-w:208px]' : 'md:[--rail-w:56px] xl:[--rail-w:64px]'
      }`}
    >
      {/* Desktop: left rail + top bar */}
      <div className="hidden md:block">
        <PrimaryRail expanded={railExpanded} onToggle={toggleRail} />
        <UtilityBarDesktop />
      </div>

      {/* Mobile context bar (page title) */}
      <div className="md:hidden">
        <UtilityBar />
      </div>

      {/* Main content area — offset for desktop rail + utility bar, mobile top bar */}
      <main className="pt-14 pb-14 min-h-screen transition-[margin] duration-200 md:ml-[var(--rail-w)] md:pt-14 md:pb-0">
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
