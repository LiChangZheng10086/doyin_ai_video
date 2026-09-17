import React from 'react';
import { NavLink } from 'react-router-dom';
import { PanelLeftClose, Video } from 'lucide-react';
import { PRIMARY_NAV_ITEMS, SECONDARY_NAV_ITEMS, isNavigationItemActive } from './navigation';
import { useLocation } from 'react-router-dom';

export interface PrimaryRailProps {
  /** 展开时显示导航文字；收起时保持改造前的纯图标外观。 */
  expanded: boolean;
  onToggle: () => void;
}

export function PrimaryRail({ expanded, onToggle }: PrimaryRailProps) {
  const location = useLocation();

  const renderNavItems = (items: typeof PRIMARY_NAV_ITEMS) =>
    items.map((item) => {
      const active = isNavigationItemActive(location.pathname, item);
      return (
        <NavLink
          key={item.to}
          to={item.to}
          aria-label={item.label}
          title={item.label}
          className={`relative flex h-12 items-center rounded-lg transition-colors ${
            expanded ? 'mx-2 gap-3 px-3' : 'mx-auto w-12 justify-center'
          } ${
            active
              ? 'bg-blue-50 text-tech-blue'
              : 'text-tech-muted hover:text-tech-text hover:bg-tech-bg'
          }`}
        >
          {active && (
            <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-tech-blue" />
          )}
          <item.icon size={20} className="shrink-0" />
          {expanded && <span className="truncate text-sm">{item.label}</span>}
        </NavLink>
      );
    });

  return (
    <nav
      aria-label="主导航"
      className="fixed left-0 top-0 bottom-0 z-40 flex w-14 flex-col border-r border-tech-border bg-white transition-[width] duration-200 md:w-[var(--rail-w)]"
    >
      {/*
        整个 logo 行就是折叠开关：收起态若只显示 logo，用户就没有入口可以展开。
        这样收起时的视觉与改造前逐像素一致，同时两个状态都有明确的点击目标。
      */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? '收起侧栏' : '展开侧栏'}
        title={expanded ? '收起侧栏' : '展开侧栏'}
        className={`flex h-14 shrink-0 items-center border-b border-tech-border transition-colors hover:bg-tech-bg ${
          expanded ? 'justify-between px-3' : 'justify-center'
        }`}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-tech-blue to-tech-purple">
          <Video size={16} className="text-white" />
        </span>
        {expanded && <PanelLeftClose size={18} className="text-tech-muted" />}
      </button>

      <div className="flex flex-1 flex-col gap-1 py-4">
        {renderNavItems(PRIMARY_NAV_ITEMS)}
      </div>
      <div className="flex flex-col gap-1 border-t border-tech-border py-4">
        {renderNavItems(SECONDARY_NAV_ITEMS)}
      </div>
    </nav>
  );
}
