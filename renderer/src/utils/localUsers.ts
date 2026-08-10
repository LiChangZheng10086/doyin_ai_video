import type { LocalUser } from '../types';

type AdminSetupValidationErrors = {
  displayName?: string;
  pin?: string;
  confirmation?: string;
};

const LOCAL_IDENTITY_ERROR_MESSAGES: Record<string, string> = {
  local_user_admin_pin_required: '管理员 PIN 为必填项',
  local_user_forbidden: '当前操作者无权执行此操作',
  local_user_last_admin: '至少保留一个启用的管理员',
  local_user_not_found: '未找到可用的本地用户',
  local_user_pin_invalid: 'PIN 不正确，请重试',
  local_user_publisher_pin_forbidden: '发布者不能设置 PIN',
  local_user_recovery_confirmation_invalid: '请准确输入“重置本地用户”以确认恢复',
  local_users_already_initialized: '本地用户已初始化，请刷新后继续',
  local_user_service_unavailable: '本地用户服务暂时不可用',
};

export const settingsSections = [
  { id: 'models', label: 'Models / API Keys', description: 'AI 服务与密钥' },
  { id: 'douyin', label: 'Douyin Login', description: '抖音扫码登录' },
  { id: 'asr', label: 'ASR', description: '视频转录服务' },
  { id: 'storage', label: 'Storage', description: '本地文件位置' },
  { id: 'users', label: '本地用户', description: '操作者与权限' },
  { id: 'advanced', label: 'Advanced', description: '安全与提示' },
] as const;

export type LocalUserMutationOutcome<T = unknown> =
  | { status: 'saved'; value: T; refreshError?: unknown }
  | { status: 'failed'; error: unknown };

export async function runLocalUserMutation<T>(
  mutate: () => Promise<T>,
  applySavedValue: (value: T) => void,
  refresh: () => Promise<void>
): Promise<LocalUserMutationOutcome<T>> {
  let value: T;
  try {
    value = await mutate();
  } catch (error) {
    return { status: 'failed', error };
  }

  applySavedValue(value);
  try {
    await refresh();
    return { status: 'saved', value };
  } catch (refreshError) {
    return { status: 'saved', value, refreshError };
  }
}

export function createLocalUserMutationLock() {
  let locked = false;

  return {
    get locked(): boolean {
      return locked;
    },
    async run<T>(operation: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
      if (locked) return { acquired: false };
      locked = true;
      try {
        return { acquired: true, value: await operation() };
      } finally {
        locked = false;
      }
    },
  };
}

export function canRestoreLocalUserDialogFocus(state: {
  dialogOpen: boolean;
  restorePending: boolean;
  mutationLocked: boolean;
  triggerConnected: boolean;
  triggerDisabled: boolean;
}): boolean {
  return state.restorePending
    && !state.dialogOpen
    && !state.mutationLocked
    && state.triggerConnected
    && !state.triggerDisabled;
}

export function validateAdminSetup(
  displayName: string,
  pin: string,
  confirmation: string
): AdminSetupValidationErrors | null {
  if (!displayName.trim()) return { displayName: '请输入管理员姓名' };
  if (!/^\d{6,12}$/.test(pin)) return { pin: 'PIN 必须为 6 至 12 位数字' };
  if (pin !== confirmation) return { confirmation: '两次 PIN 不一致' };
  return null;
}

export function localIdentityErrorMessage(
  error: unknown,
  fallback = '本地用户操作未完成，请稍后重试'
): string {
  const code = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof code === 'string' ? LOCAL_IDENTITY_ERROR_MESSAGES[code] ?? fallback : fallback;
}

export function canManageUsers(user: LocalUser | null | undefined): boolean {
  return user?.role === 'admin';
}

export function canWithdrawPublished(user: LocalUser | null | undefined): boolean {
  return user?.role === 'admin';
}

export function findRestorablePublisher(users: LocalUser[], userId: string | null): LocalUser | null {
  if (!userId) return null;
  return users.find((user) => user.id === userId && user.role === 'publisher' && user.isActive) ?? null;
}
