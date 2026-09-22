import React from 'react';

/*
 * 页面头部（标题 + 说明 + 右侧动作 + 可选附加区）。
 *
 * 为什么需要它：改造前 9 个页面各自手写头部，结果是
 *   · **主标题层级不一致**：JobListPage / CollectionListPage / SettingsPage / TrashPage
 *     用 `<h2>` 当页面主标题 —— 那几页在文档大纲里**根本没有 h1**，读屏用户
 *     按标题跳转时会漏掉整页；另外 SkillListPage 用 `font-bold`、其余用 `font-semibold`。
 *   · 间距与动作区位置各写各的（`mb-6` / `mb-4` / `mt-2` 混用）。
 *
 * 语义约定：**页面的主标题一律 `<h1>`**，区块标题才用 `<h2>`。`title` 用 ReactNode
 * 是为了容纳标题里的状态徽章或计数，但请别把动作按钮塞进来 —— 那是 `actions` 的位置。
 */
export interface PageHeaderProps {
  title: React.ReactNode;
  /** 一句话说明这一页是干什么的。请写成「用户视角」，不要复述功能名。 */
  description?: React.ReactNode;
  /** 右侧动作区（主行动放最后，或直接用 Button 的 primary 变体） */
  actions?: React.ReactNode;
  /** 标题上方的返回/面包屑等 */
  breadcrumb?: React.ReactNode;
  /** 标题下方的附加区（页签、统计条、筛选栏等），与标题共用一个容器 */
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  children,
  className = '',
}: PageHeaderProps) {
  return (
    <header className={`mb-6 ${className}`}>
      {breadcrumb && <div className="mb-3">{breadcrumb}</div>}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold text-ink">{title}</h1>
          {description && (
            // 限宽：中文正文超过 ~75 字/行就开始串行，而页面宽度是 1376px
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-ink-muted">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}
