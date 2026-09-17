/**
 * 侧栏折叠偏好。
 *
 * 与 `viewMode` 的持久化口径一致：读失败回落安全默认值、写失败静默忽略 ——
 * 隐私模式或配额耗尽都不该让界面崩掉，也不该阻塞一次折叠操作。
 */
const RAIL_EXPANDED_KEY = 'douyin-ai-video.rail-expanded';

/** 读取是否展开；只认 `'1'`，缺省、非法值与异常一律视为收起。 */
export function readStoredRailExpanded(storage: Storage): boolean {
  try {
    return storage.getItem(RAIL_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeStoredRailExpanded(storage: Storage, expanded: boolean): void {
  try {
    storage.setItem(RAIL_EXPANDED_KEY, expanded ? '1' : '0');
  } catch {
    // 存不下就算了：本次会话仍然按用户点击的状态渲染
  }
}
