import React from 'react';
import { NavLink } from 'react-router-dom';
import { Video } from 'lucide-react';
import { PRIMARY_NAV_ITEMS, SECONDARY_NAV_ITEMS, isNavigationItemActive } from './navigation';
import { useLocation } from 'react-router-dom';

export function PrimaryRail() {
  const location = useLocation();

  const renderNavItems = (items: typeof PRIMARY_NAV_ITEMS, sectionLabel: string) => (
    items.map((item) => {
      const active = isNavigationItemActive(location.pathname, item);
      return (
        <NavLink
          key={item.to}
          to={item.to}
          aria-label={item.label}
          title={item.label}
          className={`relative flex items-center justify-center w-12 h-12 rounded-lg mx-auto transition-colors ${
            active
              ? 'bg-blue-50 text-tech-blue'
              : 'text-tech-muted hover:text-tech-text hover:bg-tech-bg'
          }`}
        >
          {active && (
            <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-tech-blue" />
          )}
          <item.icon size={20} />
        </NavLink>
      );
    })
  );

  return (
    <nav aria-label="主导航" className="fixed left-0 top-0 bottom-0 z-40 flex w-16 flex-col bg-white border-r border-tech-border">
      <div className="flex items-center justify-center h-14 border-b border-tech-border">
        <div className="w-8 h-8 bg-gradient-to-br from-tech-blue to-tech-purple rounded-lg flex items-center justify-center">
          <Video size={16} className="text-white" />
        </div>
      </div>
      <div className="flex flex-col gap-1 py-4 flex-1">
        {renderNavItems(PRIMARY_NAV_ITEMS, '主导航')}
      </div>
      <div className="flex flex-col gap-1 py-4 border-t border-tech-border">
        {renderNavItems(SECONDARY_NAV_ITEMS, '次导航')}
      </div>
    </nav>
  );
}
