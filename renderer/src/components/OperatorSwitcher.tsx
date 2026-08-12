import React, { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, ChevronDown, KeyRound, LogOut, RotateCcw, UserRound } from 'lucide-react';
import type { LocalUser } from '../types';
import { useOperatorStore } from '../store/operator';
import { localIdentityErrorMessage } from '../utils/localUsers';

const roleLabel: Record<LocalUser['role'], string> = {
  admin: '管理员',
  publisher: '发布者',
};

interface OperatorSwitcherProps {
  onRequestRecovery: () => void;
}

function userInitial(user: LocalUser | null): string {
  return user?.displayName.trim().slice(0, 1).toUpperCase() || '?';
}

export function OperatorSwitcher({ onRequestRecovery }: OperatorSwitcherProps) {
  const users = useOperatorStore((state) => state.users);
  const currentUser = useOperatorStore((state) => state.currentUser);
  const switchUser = useOperatorStore((state) => state.switchUser);
  const signOut = useOperatorStore((state) => state.signOut);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingAdmin, setPendingAdmin] = useState<LocalUser | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [isSwitching, setIsSwitching] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pinInputRef = useRef<HTMLInputElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const activeUsers = users.filter((user) => user.isActive);

  const restoreDialogFocus = useCallback(() => {
    requestAnimationFrame(() => lastFocusedElementRef.current?.focus());
  }, []);

  const closeMenu = useCallback((restoreFocus = false) => {
    setMenuOpen(false);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const closeAdminDialog = useCallback(() => {
    if (isSwitching) return;
    setPendingAdmin(null);
    setPin('');
    setError('');
    restoreDialogFocus();
  }, [isSwitching, restoreDialogFocus]);

  useEffect(() => {
    if (!menuOpen) return;

    const handleOutsideMouseDown = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeMenu();
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
    };

    document.addEventListener('mousedown', handleOutsideMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[data-operator-menu-item]')?.focus();
    });

    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMenu, menuOpen]);

  useEffect(() => {
    if (!pendingAdmin) return;
    const appRoot = document.getElementById('root');
    appRoot?.setAttribute('aria-hidden', 'true');
    appRoot?.setAttribute('inert', '');
    pinInputRef.current?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeAdminDialog();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      appRoot?.removeAttribute('aria-hidden');
      appRoot?.removeAttribute('inert');
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeAdminDialog, pendingAdmin]);

  const handleSelection = async (selected: LocalUser) => {
    if (selected.id === currentUser?.id) {
      closeMenu(true);
      return;
    }

    if (selected.role === 'admin') {
      lastFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current;
      setPin('');
      setError('');
      closeMenu();
      setPendingAdmin(selected);
      return;
    }

    setError('');
    setIsSwitching(true);
    try {
      await switchUser(selected.id);
      closeMenu(true);
    } catch (switchError) {
      setError(localIdentityErrorMessage(switchError));
    } finally {
      setIsSwitching(false);
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-operator-menu-item]'));
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    items[(currentIndex + offset + items.length) % items.length]?.focus();
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
      restoreDialogFocus();
    } catch (switchError) {
      setError(localIdentityErrorMessage(switchError));
    } finally {
      setIsSwitching(false);
    }
  };

  const trapDialogFocus = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleSignOut = async () => {
    closeMenu(true);
    setError('');
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      setIsSigningOut(false);
    }
  };

  const disabled = isSwitching || isSigningOut;

  return (
    <div className="relative flex items-center">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setError('');
          setMenuOpen((open) => !open);
        }}
        disabled={disabled}
        aria-label={currentUser ? `当前操作者：${currentUser.displayName}` : '选择操作者'}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls="operator-switcher-menu"
        className="group inline-flex max-w-[220px] items-center gap-2 rounded-xl border border-tech-border bg-tech-surface px-2 py-1.5 text-left shadow-sm transition hover:border-blue-200 hover:bg-blue-50/40 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-violet-500 text-xs font-semibold text-white shadow-sm" aria-hidden="true">
          {currentUser ? userInitial(currentUser) : <UserRound size={16} />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-tech-text">{currentUser?.displayName ?? '选择操作者'}</span>
          <span className="mt-0.5 inline-flex rounded-full bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-tech-blue">
            {currentUser ? roleLabel[currentUser.role] : '只读模式'}
          </span>
        </span>
        <ChevronDown size={16} className={`shrink-0 text-tech-muted transition ${menuOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {menuOpen && (
        <div
          id="operator-switcher-menu"
          ref={menuRef}
          role="menu"
          aria-label="操作者菜单"
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-64 rounded-xl border border-tech-border bg-tech-surface p-2 shadow-xl"
        >
          <div className="border-b border-tech-border px-2 pb-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-tech-muted">当前操作者</p>
            <p className="mt-1 truncate text-sm font-semibold text-tech-text">{currentUser?.displayName ?? '尚未选择'}</p>
          </div>
          <div className="py-2">
            <p className="px-2 pb-1 text-xs text-tech-muted">切换身份</p>
            {activeUsers.length > 0 ? activeUsers.map((user) => {
              const isCurrent = user.id === currentUser?.id;
              return (
                <button
                  key={user.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isCurrent}
                  data-operator-menu-item
                  onClick={() => void handleSelection(user)}
                  disabled={disabled}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-tech-bg focus:bg-tech-bg focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-tech-blue" aria-hidden="true">{userInitial(user)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-tech-text">{user.displayName}</span>
                    <span className="block text-xs text-tech-muted">{roleLabel[user.role]}</span>
                  </span>
                  {isCurrent && <Check size={16} className="shrink-0 text-tech-blue" aria-label="当前操作者" />}
                </button>
              );
            }) : <p className="px-2 py-2 text-sm text-tech-muted">暂无可用操作者</p>}
          </div>
          <div className="border-t border-tech-border pt-2">
            {currentUser ? (
              <button
                type="button"
                role="menuitem"
                data-operator-menu-item
                onClick={() => void handleSignOut()}
                disabled={disabled}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-tech-muted transition hover:bg-red-50 hover:text-red-600 focus:bg-red-50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                <LogOut size={16} aria-hidden="true" />
                退出当前操作者
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                data-operator-menu-item
                onClick={() => {
                  closeMenu(true);
                  onRequestRecovery();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-tech-muted transition hover:bg-tech-bg hover:text-tech-text focus:bg-tech-bg focus:outline-none"
              >
                <RotateCcw size={16} aria-hidden="true" />
                重置本地用户
              </button>
            )}
          </div>
          {error && !pendingAdmin && <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-xs text-red-600" role="alert">{error}</p>}
        </div>
      )}
      {error && !pendingAdmin && !menuOpen && <p className="ml-2 max-w-40 text-xs text-red-600" role="alert">{error}</p>}
      {pendingAdmin && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => event.target === event.currentTarget && closeAdminDialog()}>
          <form
            onSubmit={handleAdminSwitch}
            onKeyDown={trapDialogFocus}
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
                  ref={pinInputRef}
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
                  onClick={closeAdminDialog}
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
        </div>,
        document.body
      )}
    </div>
  );
}
