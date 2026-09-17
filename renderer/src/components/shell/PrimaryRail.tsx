import React from 'react';
import { NavLink } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen, Video } from 'lucide-react';
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
        logo 行保持原来的非交互样式。折叠开关固定在底部且两个状态都可见 ——
        早先把整行 logo 当开关，结果收起态与改造前长得一模一样，用户根本发现不了能点。
        可用性优先于"逐像素一致"。
      */}
      <div className="flex h-14 shrink-0 items-center justify-center border-b border-tech-border">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-tech-blue to-tech-purple">
          <Video size={16} className="text-white" />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-1 py-4">
        {renderNavItems(PRIMARY_NAV_ITEMS)}
      </div>

      <div className="flex flex-col gap-1 border-t border-tech-border py-4">
        {renderNavItems(SECONDARY_NAV_ITEMS)}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? '收起侧栏' : '展开侧栏'}
          title={expanded ? '收起侧栏' : '展开侧栏'}
          className={`mt-1 flex h-10 items-center rounded-lg text-tech-muted transition-colors hover:bg-tech-bg hover:text-tech-text ${
            expanded ? 'mx-2 gap-3 px-3' : 'mx-auto w-12 justify-center'
          }`}
        >
          {expanded
            ? <PanelLeftClose size={18} className="shrink-0" />
            : <PanelLeftOpen size={18} className="shrink-0" />}
          {expanded && <span className="truncate text-sm">收起侧栏</span>}
        </button>
      </div>
    </nav>
  );
}
