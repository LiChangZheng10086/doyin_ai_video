import React from 'react';

/*
 * 共享按钮原语。
 *
 * 为什么需要它：改造前全仓 **148 个 <button> 各写各的 className**，同一个「次要按钮」
 * 在不同文件里分别是 `px-3 py-2` 和 `px-4 py-2.5`；同一个「危险」有 4 套红；
 * 全仓 0 处按压反馈、0 处 cursor-pointer。这三件事都是「没有原语」的直接后果。
 *
 * 颜色都取自令牌，对比度已实算锁定：
 *   primary  = 品牌红底 + 近黑字（5.21:1）。注意**不能用白字**：白字压 #FE2C55 只有
 *              3.68:1，不达 AA —— 这是本次令牌化时实测出来的。
 *   danger   = 危险色底 + 近黑字（同族，已验证）
 *   outline  = 面板底 + 控件边界（≥3:1）+ 主文字
 *   ghost    = 无底，hover 浮起
 *   subtleDanger = 危险色描边 + 危险色文字（破坏性但非主操作，例如行内删除）
 */

type Variant = 'primary' | 'outline' | 'ghost' | 'danger' | 'subtleDanger' | 'accent' | 'ai' | 'heavy' | 'success';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  danger: 'bg-danger text-on-accent hover:opacity-90',
  ai: 'bg-ai text-on-accent hover:opacity-90',
  success: 'bg-success text-on-accent hover:opacity-90',
  outline: 'border border-line-ui bg-panel text-ink hover:bg-elevated',
  ghost: 'text-ink-muted hover:bg-elevated hover:text-ink',
  subtleDanger: 'border border-danger-line text-danger hover:bg-danger-soft',
  /** 「下一步该做的动作」：品牌色描边 + 浅底，比实心 primary 低一档权重 */
  accent: 'border border-accent-line bg-accent-soft text-accent hover:opacity-90',
  /** 高代价动作（耗时长/占资源）：警示色描边，点下去之前先让人意识到代价 */
  heavy: 'border border-warning-line bg-warning-soft text-warning hover:opacity-90',
};

const SIZE_CLASS: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-10 px-4 text-sm',
  icon: 'h-8 w-8',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({ variant = 'outline', size = 'md', className = '', type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={[
        'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium',
        /*
        * ⚠️ 时长必须写成 `duration-(--duration-ui)`（v4 的括号简写）。
        * 用方括号包住变量名（而不是圆括号）会被当成**字面值**，产出
        * `--tw-duration: --duration-ui`（没有 var()）—— 这是个无效的自定义属性值，
        * 于是 `transition-duration: var(--tw-duration, …)` 整条声明失效、回落到 **0s**。
        * 真机实测：修复前所有按钮的颜色过渡都是「瞬间跳变」而不是令牌里的 160ms。
        */
        'transition-colors duration-(--duration-ui)',
        // 禁止换行：真机实测过操作列的「打开/删除」被逐字换行成两行（列宽 96px 装不下），
        // 按钮文案被拆成单字完全不可读。按钮一律不该换行。
        // 按压反馈：全站基线（index.css 里也有兜底，这里显式声明让使用方一眼看到）
        'active:translate-y-px',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className,
      ].join(' ')}
      {...rest}
    />
  );
}
