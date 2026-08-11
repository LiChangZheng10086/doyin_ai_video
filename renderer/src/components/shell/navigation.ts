import { useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Brain,
  Send,
  Trash2,
  Settings,
  MoreHorizontal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavigationItem {
  to: string;
  label: string;
  icon: LucideIcon;
  matchPrefixes: string[];
}

export type MobileNavigationItem = NavigationItem | {
  key: 'more';
  label: '更多';
  icon: typeof MoreHorizontal;
};

export const PRIMARY_NAV_ITEMS = [
  { to: '/', label: '作品', icon: LayoutDashboard, matchPrefixes: ['/jobs/'] },
  { to: '/collections', label: '合集', icon: Users, matchPrefixes: ['/collections/'] },
  { to: '/skills', label: 'Skills', icon: Brain, matchPrefixes: [] },
  { to: '/publishing', label: '发布', icon: Send, matchPrefixes: [] },
] satisfies NavigationItem[];

export const SECONDARY_NAV_ITEMS = [
  { to: '/trash', label: '垃圾桶', icon: Trash2, matchPrefixes: [] },
  { to: '/settings', label: '设置', icon: Settings, matchPrefixes: [] },
] satisfies NavigationItem[];

export const ALL_NAV_ITEMS = [...PRIMARY_NAV_ITEMS, ...SECONDARY_NAV_ITEMS];

export const MOBILE_NAV_ITEMS: MobileNavigationItem[] = [
  ...PRIMARY_NAV_ITEMS,
  { key: 'more' as const, label: '更多', icon: MoreHorizontal },
];

export function isNavigationItemActive(pathname: string, item: NavigationItem): boolean {
  if (pathname === item.to) return true;
  if (item.matchPrefixes.length > 0) {
    return item.matchPrefixes.some((prefix) => pathname.startsWith(prefix));
  }
  return false;
}

export function getPageContext(pathname: string): { title: string; subtitle: string } {
  if (pathname.startsWith('/jobs/')) return { title: '作品详情', subtitle: '创作流程与成果' };
  if (pathname.startsWith('/collections/')) return { title: '合集详情', subtitle: '创作者内容库' };
  if (pathname === '/collections') return { title: '合集', subtitle: '创作者内容库' };
  if (pathname === '/skills') return { title: 'Skills', subtitle: '知识资产' };
  if (pathname === '/publishing') return { title: '发布工作台', subtitle: '人工交付队列' };
  if (pathname === '/settings') return { title: '设置', subtitle: '连接与本地环境' };
  if (pathname === '/trash') return { title: '垃圾桶', subtitle: '恢复已删除作品' };
  return { title: '创作中心', subtitle: '从视频到文稿、分镜与成片' };
}

export function usePageContext() {
  const location = useLocation();
  return getPageContext(location.pathname);
}
