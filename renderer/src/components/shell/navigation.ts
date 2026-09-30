import { useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Brain,
  Send,
  Images,
  GalleryVerticalEnd,
  Flame,
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
  { to: '/hotspots', label: '热点', icon: Flame, matchPrefixes: [] },
  { to: '/galleries', label: '图集创作', icon: GalleryVerticalEnd, matchPrefixes: ['/galleries/'] },
  { to: '/collections', label: '合集', icon: Users, matchPrefixes: ['/collections/'] },
  { to: '/skills', label: 'Skills', icon: Brain, matchPrefixes: [] },
  { to: '/assets', label: '素材', icon: Images, matchPrefixes: [] },
  { to: '/publishing', label: '发布', icon: Send, matchPrefixes: [] },
] satisfies NavigationItem[];

export const SECONDARY_NAV_ITEMS = [
  { to: '/trash', label: '垃圾桶', icon: Trash2, matchPrefixes: [] },
  { to: '/settings', label: '设置', icon: Settings, matchPrefixes: [] },
] satisfies NavigationItem[];

export const ALL_NAV_ITEMS = [...PRIMARY_NAV_ITEMS, ...SECONDARY_NAV_ITEMS];

export const MOBILE_NAV_ITEMS: MobileNavigationItem[] = [
  ...PRIMARY_NAV_ITEMS.filter(item => item.to !== '/skills' && item.to !== '/hotspots'),
  { key: 'more' as const, label: '更多', icon: MoreHorizontal },
];

export const MOBILE_MORE_ITEMS = [...PRIMARY_NAV_ITEMS.filter(item => item.to === '/skills' || item.to === '/hotspots'), ...SECONDARY_NAV_ITEMS];

export function isNavigationItemActive(pathname: string, item: NavigationItem): boolean {
  if (pathname === item.to) return true;
  if (item.matchPrefixes.length > 0) {
    return item.matchPrefixes.some((prefix) => pathname.startsWith(prefix));
  }
  return false;
}

export function getPageContext(pathname: string): { title: string; subtitle: string } {
  if (pathname === '/hotspots') return { title: '热点', subtitle: '平台热榜 · 选题收藏' };
  if (pathname.startsWith('/galleries')) return { title: '图集创作', subtitle: '原视频 · 字幕拼图 · 抖音图文' };
  if (pathname.startsWith('/jobs/')) return { title: '作品详情', subtitle: '创作流程与成果' };
  if (pathname.startsWith('/collections/')) return { title: '合集详情', subtitle: '创作者内容库' };
  if (pathname === '/collections') return { title: '合集', subtitle: '创作者内容库' };
  if (pathname === '/skills') return { title: 'Skills', subtitle: '知识资产' };
  if (pathname === '/assets') return { title: '素材', subtitle: '图片与音频素材库' };
  if (pathname === '/publishing') return { title: '发布工作台', subtitle: '按渠道提交与跟踪' };
  if (pathname === '/settings') return { title: '设置', subtitle: '连接与本地环境' };
  if (pathname === '/trash') return { title: '垃圾桶', subtitle: '恢复已删除作品' };
  return { title: '创作中心', subtitle: '从视频到文稿、分镜与成片' };
}

export function usePageContext() {
  const location = useLocation();
  return getPageContext(location.pathname);
}
