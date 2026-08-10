import type { LocalUser } from '../types';

type AdminSetupValidationErrors = {
  displayName?: string;
  pin?: string;
  confirmation?: string;
};

const LOCAL_IDENTITY_ERROR_MESSAGES: Record<string, string> = {
  local_user_admin_pin_required: '管理员 PIN 为必填项',
  local_user_forbidden: '当前操作者无权执行此操作',
  local_user_not_found: '未找到可用的本地用户',
  local_user_pin_invalid: 'PIN 不正确，请重试',
  local_user_recovery_confirmation_invalid: '请准确输入“重置本地用户”以确认恢复',
  local_users_already_initialized: '本地用户已初始化，请刷新后继续',
  local_user_service_unavailable: '本地用户服务暂时不可用',
};

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
