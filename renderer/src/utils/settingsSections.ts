/**
 * 设置页左侧分组定义。
 *
 * 原本位于 `utils/localUsers.ts`；本地用户/操作者管理界面移除后，这里成为唯一消费者
 * （`SettingsPage`），因此独立成文件，并去掉了 `users` 分组。
 */
export const settingsSections = [
  { id: 'models', label: 'AI 模型与密钥', description: 'AI 服务与密钥' },
  // 常驻状态的**唯一**呈现处：三个渠道 + 两项发布链路依赖（spec §6.2 决策 ⑤）。
  // 放在登录分组**之前** —— 它是总览，用户要先知道"哪儿坏了"，再决定去哪一组修。
  { id: 'runtime', label: '运行环境', description: '渠道与引擎状态' },
  { id: 'douyin', label: '抖音登录', description: '抖音扫码登录' },
  { id: 'toutiao', label: '今日头条', description: '头条号扫码登录' },
  { id: 'xhs', label: '小红书', description: '小红书扫码登录' },
  { id: 'wechat', label: '微信公众号', description: '官方 API · 仅存草稿' },
  { id: 'research', label: '资料搜索与阅读', description: '公开来源 · 创作取材' },
  { id: 'asr', label: '语音转录', description: '视频转录服务' },
  { id: 'storage', label: '存储位置', description: '本地文件位置' },
  { id: 'advanced', label: '高级选项', description: '安全与提示' },
] as const;

/**
 * 运行环境的渠道 id → 设置页登录分组的 id。
 *
 * ⚠️ **两套 id 不一样**：分组的「小红书」叫 `xhs`，而运行环境的渠道叫 `xiaohongshu`。
 * 直接把渠道 id 当分组 id 用，编译器会拦下来（`'xiaohongshu'` 不在 `SettingsSection` 里）——
 * 但要是哪天两侧都叫同一个名字、只有一处写错，就会静默跳到错误的分组。所以这里显式映射，
 * 并有用例守。
 */
export function loginSectionOf(channel: 'douyin' | 'toutiao' | 'xiaohongshu'): (typeof settingsSections)[number]['id'] {
  switch (channel) {
    case 'douyin':
      return 'douyin';
    case 'toutiao':
      return 'toutiao';
    default:
      return 'xhs';
  }
}
