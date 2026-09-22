import React, { useRef } from 'react';

/*
 * 页签组（tablist）的键盘支持。
 *
 * 为什么需要它：改造前全仓的 `role="tablist"` 只有 `onClick` —— **方向键没有任何反应**
 * （发布中心的渠道页签与内容类型子页签、作品详情的成果页签、原视频/成片切换都是）。
 * 按 WAI-ARIA 的 tabs 模式，页签组应该是一个**单一 Tab 停靠点**：
 *   Tab 进入/离开整个组，组内用 ←/→ 切换，Home/End 跳首尾。
 * 这靠 roving tabindex 实现：只有当前选中的页签 `tabIndex=0`，其余为 -1。
 *
 * 用钩子而不是包装组件的理由：各处页签的**视觉结构差别很大**（渠道页签带 logo 与计数、
 * 内容类型是胶囊、成果页签带状态点），包一个组件会逼着所有调用方接受同一套 DOM。
 */
export interface RovingTabs<T extends HTMLElement = HTMLButtonElement> {
  /** 给每个页签挂 `ref={roving.refs[value]}`（用于切换后把焦点移过去） */
  refs: React.MutableRefObject<Record<string, T | null>>;
  /** 挂到 `role="tablist"` 的容器上 */
  onKeyDown: (event: React.KeyboardEvent) => void;
  /** 挂到每个页签：选中者 0，其余 -1 */
  tabIndexFor: (value: string) => 0 | -1;
}

export function useRovingTabs<T extends HTMLElement = HTMLButtonElement>(
  values: string[],
  active: string,
  onSelect: (value: string) => void,
): RovingTabs<T> {
  const refs = useRef<Record<string, T | null>>({});

  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = values.indexOf(active);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (index + 1) % values.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (index - 1 + values.length) % values.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = values.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const value = values[next]!;
    onSelect(value);
    // 选中与聚焦要一起动：WAI-ARIA 的「自动激活」模式下手移到哪就选到哪
    refs.current[value]?.focus();
  };

  return { refs, onKeyDown, tabIndexFor: (value) => (value === active ? 0 : -1) };
}
