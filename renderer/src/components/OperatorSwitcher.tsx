import { FormEvent, useState } from 'react';
import { AlertCircle, KeyRound, LogOut, UserRound } from 'lucide-react';
import type { LocalUser } from '../types';
import { useOperatorStore } from '../store/operator';
import { localIdentityErrorMessage } from '../utils/localUsers';

const roleLabel: Record<LocalUser['role'], string> = {
  admin: '管理员',
  publisher: '发布者',
};

export function OperatorSwitcher() {
  const users = useOperatorStore((state) => state.users);
  const currentUser = useOperatorStore((state) => state.currentUser);
  const switchUser = useOperatorStore((state) => state.switchUser);
  const signOut = useOperatorStore((state) => state.signOut);
  const [pendingAdmin, setPendingAdmin] = useState<LocalUser | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [isSwitching, setIsSwitching] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const activeUsers = users.filter((user) => user.isActive);

  const handleSelection = async (userId: string) => {
    const selected = activeUsers.find((user) => user.id === userId);
    if (!selected || selected.id === currentUser?.id) return;
    if (selected.role === 'admin') {
      setPin('');
      setError('');
      setPendingAdmin(selected);
      return;
    }

    setError('');
    setIsSwitching(true);
    try {
      await switchUser(selected.id);
    } catch (switchError) {
      setError(localIdentityErrorMessage(switchError));
    } finally {
      setIsSwitching(false);
    }
  };

  const handleAdminSwitch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pendingAdmin) return;

    setError('');
    setIsSwitching(true);
    try {
      await switchUser(pendingAdmin.id, pin);
      setPendingAdmin(null);
      setPin('');
    } catch (switchError) {
      setError(localIdentityErrorMessage(switchError));
    } finally {
      setIsSwitching(false);
    }
  };

  const handleSignOut = async () => {
    setError('');
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 text-right">
        <p className="truncate text-sm font-medium text-tech-text">{currentUser?.displayName ?? '未选择操作者'}</p>
        <p className="text-xs text-tech-muted">{currentUser ? roleLabel[currentUser.role] : '只读模式'}</p>
      </div>
      <UserRound size={18} className="shrink-0 text-tech-muted" aria-hidden="true" />
      <label className="sr-only" htmlFor="operator-switcher">切换操作者</label>
      <select
        id="operator-switcher"
        value={currentUser?.id ?? ''}
        onChange={(event) => void handleSelection(event.target.value)}
        disabled={isSwitching || isSigningOut}
        className="max-w-32 rounded-lg border border-tech-border bg-tech-surface px-2 py-1.5 text-sm text-tech-text outline-none transition focus:border-tech-blue focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="" disabled>选择操作者</option>
        {activeUsers.map((user) => (
          <option key={user.id} value={user.id}>{user.displayName}（{roleLabel[user.role]}）</option>
        ))}
      </select>
      {currentUser && (
        <button
          type="button"
          onClick={() => void handleSignOut()}
          disabled={isSigningOut || isSwitching}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-tech-muted transition hover:bg-tech-bg hover:text-tech-text disabled:cursor-not-allowed disabled:opacity-60"
          title="退出当前操作者"
          aria-label="退出当前操作者"
        >
          <LogOut size={16} aria-hidden="true" />
        </button>
      )}
      {error && !pendingAdmin && <p className="max-w-40 text-xs text-red-600" role="alert">{error}</p>}
      {pendingAdmin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form
            onSubmit={handleAdminSwitch}
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-pin-title"
            className="w-full max-w-sm rounded-lg border border-tech-border bg-tech-surface shadow-xl"
          >
            <div className="border-b border-tech-border px-5 py-4">
              <div className="flex items-center gap-2 text-tech-text">
                <KeyRound size={18} className="text-tech-blue" aria-hidden="true" />
                <h2 id="admin-pin-title" className="text-base font-semibold">验证管理员 PIN</h2>
              </div>
              <p className="mt-1 text-sm text-tech-muted">切换至 {pendingAdmin.displayName}</p>
            </div>
            <div className="space-y-4 px-5 py-5">
              <div>
                <label className="mb-2 block text-sm font-medium text-tech-text" htmlFor="operator-admin-pin">管理员 PIN</label>
                <input
                  id="operator-admin-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  autoFocus
                  value={pin}
                  onChange={(event) => setPin(event.target.value)}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? 'operator-admin-pin-error' : undefined}
                  className="w-full rounded-lg border border-tech-border bg-tech-surface px-3 py-2.5 text-sm text-tech-text outline-none transition focus:border-tech-blue focus:ring-2 focus:ring-blue-100"
                />
              </div>
              {error && (
                <div id="operator-admin-pin-error" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700" role="alert">
                  <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setPendingAdmin(null); setPin(''); setError(''); }}
                  disabled={isSwitching}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-tech-muted transition hover:bg-tech-bg hover:text-tech-text disabled:cursor-not-allowed disabled:opacity-60"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isSwitching}
                  className="rounded-lg bg-tech-blue px-4 py-2 text-sm font-medium text-white transition hover:bg-tech-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSwitching ? '正在验证...' : '确认切换'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
