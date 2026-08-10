import type { LocalUser } from '../types';

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
