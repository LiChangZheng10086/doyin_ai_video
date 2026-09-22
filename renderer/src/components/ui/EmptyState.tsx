import React from 'react';
import type { LucideIcon } from 'lucide-react';

/*
 * 空态。
 *
 * ⚠️ 用它之前先回答一个问题：**这真的是「空」，还是「失败」？**
 * 改造前有 5 个列表页把「后端 500 / 请求失败」也渲染成空态（「还没有作品」
 * 「垃圾桶是空的」…），用户会以为自己的数据丢了。错误态该有自己的文案与重试入口，
 * 不要复用空态 —— 两者的正确做法是**互斥**。
 *
 * `action` 请给**可照抄的下一步**（去创建 / 去设置 / 重试），而不是「暂无数据」。
 */
export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  /*
   * 说明与标题重复时不渲染说明。
   * 错误态最容易踩：标题写「垃圾桶加载失败」，而 description 直接来自后端的
   * 兜底文案「加载垃圾桶失败」—— 两行几乎一样，看起来像没加载完。
   */
  const showDescription = Boolean(description) && String(description).trim() !== title.trim();
  return (
    <section className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <span className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-xl border border-line bg-panel text-ink-muted">
        <Icon size={26} aria-hidden="true" />
      </span>
      <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
      {showDescription && <p className="mt-2 max-w-xl text-sm leading-6 text-ink-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </section>
  );
}
