import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { MOBILE_NAV_ITEMS, isNavigationItemActive } from './navigation';
import type { MobileNavigationItem } from './navigation';
import { MoreHorizontal } from 'lucide-react';

export interface MobileNavigationProps {
  onOpenMore: () => void;
}

function isRouteItem(item: MobileNavigationItem): item is Exclude<MobileNavigationItem, { key: 'more' }> {
  return 'to' in item;
}

export function MobileNavigation({ onOpenMore }: MobileNavigationProps) {
  const location = useLocation();

  return (
    <nav aria-label="移动导航" className="fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around bg-white border-t border-tech-border h-14 md:hidden safe-bottom">
      {MOBILE_NAV_ITEMS.map((item) => {
        if (isRouteItem(item)) {
          const active = isNavigationItemActive(location.pathname, item);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              aria-label={item.label}
              className={`flex flex-col items-center justify-center gap-0.5 min-w-0 px-2 py-1 text-[11px] font-medium transition-colors ${
                active ? 'text-tech-blue' : 'text-tech-muted'
              }`}
            >
              <item.icon size={20} />
              <span className="truncate">{item.label}</span>
            </NavLink>
          );
        }
        return (
          <button
            key={item.key}
            type="button"
            aria-label={item.label}
            onClick={onOpenMore}
            className="flex flex-col items-center justify-center gap-0.5 min-w-0 px-2 py-1 text-[11px] font-medium text-tech-muted"
          >
            <MoreHorizontal size={20} />
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
