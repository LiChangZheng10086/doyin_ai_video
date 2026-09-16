/**
 * 设置页左侧分组定义。
 *
 * 原本位于 `utils/localUsers.ts`；本地用户/操作者管理界面移除后，这里成为唯一消费者
 * （`SettingsPage`），因此独立成文件，并去掉了 `users` 分组。
 */
export const settingsSections = [
  { id: 'models', label: 'AI 模型与密钥', description: 'AI 服务与密钥' },
  { id: 'douyin', label: '抖音登录', description: '抖音扫码登录' },
  { id: 'asr', label: '语音转录', description: '视频转录服务' },
  { id: 'storage', label: '存储位置', description: '本地文件位置' },
  { id: 'advanced', label: '高级选项', description: '安全与提示' },
] as const;
